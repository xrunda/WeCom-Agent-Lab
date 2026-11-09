/**
 * #34 / #63 / #56 的运行时编排。
 *
 * 流程：
 *   存档消息 → PatientService.routeInbound → 合并窗口 → 患者长期会话 →
 *   Agent 回合 → reply_draft 工具 → PatientBridge → C2 入队 → 顾问卡片
 *
 * 降级：回合超时 / 模型报错 / 没调工具 → 模板草稿（fallback=true）。
 * 核验结果通过 injectContext 写回会话，不唤醒新回合。
 */
import { InboundMerger, mediaPaths, messageIds, summarizeMessages } from './merge.ts';
import {
  buildSystemPrompt,
  buildTurnPrompt,
  fallbackBody,
  speakerLabel,
} from './persona.ts';
import type { PatientService } from './patient-service.ts';
import type { PatientSessionPort, RuntimeStats } from './session-port.ts';
import type { PatientBridge } from './session-port.ts';
import type { DraftReviewInput, DraftReviewResult } from './guard.ts';
import type {
  AgentReplyDraftInput,
  AgentReplySkipInput,
  InboundMessage,
  ManagedGroup,
  MergedInbound,
  Patient,
  RouteDecision,
  Speaker,
  TenantAgentSettings,
} from './types.ts';
import type { VerifyOutcome } from '../c2/types.ts';

interface GroupContextItem {
  speaker: Speaker;
  text: string;
  at: number;
}

interface RevisionRequest {
  draftId: string;
  instruction: string;
  currentVersion: number;
}

interface ActiveTurn {
  id: string;
  sessionId: string;
  patient: Patient;
  group: ManagedGroup;
  messages: InboundMessage[];
  speaker: Speaker;
  source: 'inbound' | 'proactive';
  startedAt: number;
  replied: boolean;
  skipped: boolean;
  closed: boolean;
  revision?: RevisionRequest;
  /** #40：沙盒回合，草稿回控制台而不是 C2 */
  sandbox?: SandboxDraftSink;
}

/** #40 沙盒患者/群的最小视图，由控制台插件传入 */
export interface SandboxPatientLike {
  id: string;
  tenantId: string;
  displayName: string;
  externalUserId: string;
}

export interface SandboxGroupLike {
  id: string;
  roomId: string;
  name: string;
}

export interface SandboxTurnInput {
  sessionId: string;
  patient: SandboxPatientLike;
  group: SandboxGroupLike;
  text: string;
  mediaIds: string[];
  at: number;
}

export interface SandboxDraftInput {
  sessionId: string;
  patientId: string;
  groupId: string;
  groupName: string;
  body: string;
  inboundSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  fallback: boolean;
  advisorId?: string;
  citedMemoryIds?: string[];
  citedKnowledgeIds?: string[];
}

/** 由 zhiban-console 提供：沙盒草稿交回控制台，不进入 C2 队列 */
export interface SandboxDraftSink {
  enqueueDraft(input: SandboxDraftInput): { draftId: string; version: number };
}

export interface DraftGuardPort {
  review(input: DraftReviewInput): DraftReviewResult;
  /** 草稿入队后回填 draftId（guard 未实现时忽略） */
  linkDraft?(alertId: string, draftId: string): void;
}

export interface PatientAgentRuntimeOptions {
  service: PatientService;
  settings: TenantAgentSettings;
  bridge: PatientBridge;
  sessions: PatientSessionPort;
  emit: (type: string, data: unknown) => void;
  logger?: (line: string) => void;
  mergeWindowMs?: number;
  mergeMaxWaitMs?: number;
  turnTimeoutMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  /** #37：草稿产出后的红线后校验；未安装 zhiban-guard 时为空 */
  guard?: DraftGuardPort;
  /** 懒取控制台的沙盒接收端；控制台插件可能后加载 */
  sandboxSink?: () => SandboxDraftSink | undefined;
}

const VERIFY_TEXT: Record<VerifyOutcome, string> = {
  VERIFIED: '✅ 已核验：草稿正文已在群里找到',
  EDIT_SENT: '✏️ 已发送（内容有改动）：找到了相近正文',
  MISROUTE_ALERT: '⚠️ 发错群：回复出现在别的群，需要人工处理',
  UNVERIFIED: '❌ 未核验：没有在目标群找到这条正文',
};

function normalize(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

export class PatientAgentRuntime {
  private readonly service: PatientService;
  private settings: TenantAgentSettings;
  private readonly bridge: PatientBridge;
  private readonly sessions: PatientSessionPort;
  private readonly emit: (type: string, data: unknown) => void;
  private readonly logger?: (line: string) => void;
  private readonly sandboxSink?: () => SandboxDraftSink | undefined;
  private readonly merger: InboundMerger;
  private readonly turnTimeoutMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private readonly guard?: DraftGuardPort;

  private readonly flushTimers = new Map<string, unknown>();
  private readonly activeBySession = new Map<string, ActiveTurn>();
  private readonly activeByPatient = new Map<string, ActiveTurn>();
  private readonly queuedMessages = new Map<string, InboundMessage[]>();
  /** #37：最近一次入站文本，改稿回合没有新消息时用于急症复核；不落盘、不进日志 */
  private readonly lastInboundText = new Map<string, string>();
  private readonly groupContext = new Map<string, GroupContextItem[]>();
  private readonly localStats = {
    mergedBatches: 0,
    contextMessages: 0,
    revisions: 0,
    duplicatesSkipped: 0,
  };
  private turnSeq = 0;

  constructor(options: PatientAgentRuntimeOptions) {
    this.service = options.service;
    this.settings = options.settings;
    this.bridge = options.bridge;
    this.sessions = options.sessions;
    this.emit = options.emit;
    this.logger = options.logger;
    this.sandboxSink = options.sandboxSink;
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.cancelSchedule =
      options.cancelSchedule ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.turnTimeoutMs = options.turnTimeoutMs ?? 15_000;
    this.guard = options.guard;
    this.merger = new InboundMerger({
      windowMs: options.mergeWindowMs ?? 30_000,
      maxWaitMs: options.mergeMaxWaitMs ?? 120_000,
    });
  }

  /** 系统提示词由租户设置生成，插件启动时注册到 Agent 预设 */
  systemPrompt(): string {
    return buildSystemPrompt(this.settings);
  }

  /**
   * #41 租户设置即时生效：人设字段下一轮回合使用。
   * 已存在的 DSH 会话系统提示词不会重建，插件会额外注入一条设置更新上下文。
   */
  applySettings(
    patch: Partial<Pick<TenantAgentSettings, 'agentName' | 'patientTerm' | 'tone'>>,
  ): void {
    if (typeof patch.agentName === 'string' && patch.agentName.trim() !== '') {
      this.settings.agentName = patch.agentName.trim();
    }
    if (typeof patch.patientTerm === 'string' && patch.patientTerm.trim() !== '') {
      this.settings.patientTerm = patch.patientTerm.trim();
    }
    if (typeof patch.tone === 'string' && patch.tone.trim() !== '') {
      this.settings.tone = patch.tone.trim();
    }
  }

  /** 插件卸载：取消合并定时器，丢弃未放行的批次 */
  dispose(): void {
    for (const handle of this.flushTimers.values()) this.cancelSchedule(handle);
    this.flushTimers.clear();
    this.merger.clear();
    this.activeBySession.clear();
    this.activeByPatient.clear();
    this.queuedMessages.clear();
    this.lastInboundText.clear();
    this.groupContext.clear();
  }

  stats(): RuntimeStats {
    return { ...this.service.store.stats(), ...this.localStats };
  }

  /** #37：escalate_to_human 用会话 id 反查患者；只覆盖进行中的回合 */
  patientForSession(sessionId: string): string | undefined {
    return this.activeBySession.get(sessionId)?.patient.id;
  }

  // ---------- 群发现 ----------

  observeRooms(
    rooms: Array<{
      roomId: string;
      members: Array<{ id: string; isExternal: boolean; lastActiveAt: number }>;
    }>,
  ): void {
    for (const room of rooms) {
      this.service.observeGroup(room.roomId, room.members);
    }
  }

  // ---------- 入站 ----------

  /**
   * 返回 true 表示这条消息由患者域接管（服务群或采集群），
   * zhiban-wecom 不应再走模板草稿。
   */
  routeInbound(message: InboundMessage): { handled: boolean; decision: RouteDecision } {
    const decision = this.service.routeInbound(message);
    if (decision.action === 'ignore') {
      if (decision.consentNotice) {
        this.log(`成员未同意存档，跳过自动服务 room=${message.roomId}`);
      }
      return { handled: decision.reason !== 'GROUP_UNKNOWN', decision };
    }
    if (decision.action === 'context') {
      this.handleContext(message, decision);
      return { handled: true, decision };
    }

    this.merger.add(message);
    this.scheduleFlush(message.roomId);
    return { handled: true, decision };
  }

  /** 定时器或测试直接调用：放行安静满窗口的批次 */
  async flushDue(): Promise<void> {
    for (const roomId of this.merger.flushDue(this.now())) {
      const messages = this.merger.take(roomId);
      if (messages.length === 0) continue;
      await this.runBatch(messages);
    }
  }

  private scheduleFlush(roomId: string): void {
    if (this.flushTimers.has(roomId)) return;
    const handle = this.schedule(() => {
      this.flushTimers.delete(roomId);
      void this.flushDue();
    }, this.merger.windowMs);
    this.flushTimers.set(roomId, handle);
  }

  private async runBatch(messages: InboundMessage[]): Promise<void> {
    const last = messages[messages.length - 1];
    if (!last) return;
    const decision = this.service.routeInbound(last);
    if (decision.action === 'ignore') return;
    if (decision.action === 'context') {
      for (const message of messages) this.handleContext(message, decision);
      return;
    }

    const patient = decision.patientId ? this.service.store.getPatient(decision.patientId) : undefined;
    const group = decision.groupId ? this.service.store.getGroup(decision.groupId) : undefined;
    if (!patient || !group) return;

    this.localStats.mergedBatches += 1;
    const speaker = this.service.resolveSpeaker(group, last.from);
    const merged: MergedInbound = {
      id: `batch_${++this.turnSeq}`,
      roomId: group.roomId,
      groupId: group.id,
      groupName: group.name,
      patientId: patient.id,
      advisorId: group.advisorId ?? this.settings.advisorId,
      messages,
      speaker,
      source: 'inbound',
      mergedAt: this.now(),
      lastMessageAt: last.msgtime,
    };
    this.emit('patient.inbound.merged', {
      patientId: patient.id,
      groupId: group.id,
      batchId: merged.id,
      messageCount: messages.length,
      mediaCount: mediaPaths(messages).length,
      speakerRole: speaker.role,
    });
    this.log(`合并 ${messages.length} 条输入 → 患者 ${patient.id} 回合`);
    await this.enqueueTurn(merged);
  }

  /** 采集群 / 内部员工发言：只写上下文，不唤醒回合 */
  private handleContext(message: InboundMessage, decision: RouteDecision): void {
    const group = this.service.store.getGroupByRoomId(message.roomId);
    if (!group) return;
    const speaker = this.service.resolveSpeaker(group, message.from);
    if (!speaker.isExternal) {
      const verified = this.bridge.listVerifiedBodies(message.from);
      if (verified.some((body) => normalize(body) === normalize(message.text))) {
        this.localStats.duplicatesSkipped += 1;
        return;
      }
    }

    const patient = decision.patientId
      ? this.service.store.getPatient(decision.patientId)
      : this.service.patientForGroup(group.id);
    if (!patient) return;

    const items = this.groupContext.get(patient.id) ?? [];
    items.push({ speaker, text: message.text, at: message.msgtime });
    this.groupContext.set(patient.id, items.slice(-8));

    void this.sessions
      .ensure(patient)
      .then((session) =>
        this.sessions.injectContext(
          session.sessionId,
          `[群上下文] ${speakerLabel(speaker)}：${message.msgtype === 'image' ? '[图片]' : message.text}`,
        ),
      )
      .catch((error: unknown) => {
        this.log(`上下文注入失败：${error instanceof Error ? error.message : String(error)}`);
      });
    this.localStats.contextMessages += 1;
    this.emit('patient.context.injected', {
      patientId: patient.id,
      groupId: group.id,
      speakerRole: speaker.role,
    });
  }

  // ---------- 回合 ----------

  private async enqueueTurn(merged: MergedInbound): Promise<void> {
    if (this.activeByPatient.has(merged.patientId)) {
      const queue = this.queuedMessages.get(merged.patientId) ?? [];
      queue.push(...merged.messages);
      this.queuedMessages.set(merged.patientId, queue);
      this.log(`患者 ${merged.patientId} 上一轮未结束，新增 ${merged.messages.length} 条排队`);
      return;
    }
    await this.executeTurn(merged);
  }

  private async executeTurn(merged: MergedInbound, revision?: RevisionRequest): Promise<void> {
    const patient = this.service.store.getPatient(merged.patientId);
    const group = this.service.store.getGroup(merged.groupId);
    if (!patient || !group) return;

    if (merged.messages.length > 0) {
      this.lastInboundText.set(
        merged.patientId,
        merged.messages
          .map((message) => message.text)
          .join('\n')
          .slice(0, 4000),
      );
    }

    let record;
    try {
      record = await this.sessions.ensure(patient);
    } catch (error) {
      this.log(`患者会话创建失败：${error instanceof Error ? error.message : String(error)}`);
      await this.fallback(merged, undefined, group);
      return;
    }

    const turn: ActiveTurn = {
      id: merged.id,
      sessionId: record.sessionId,
      patient,
      group,
      messages: merged.messages,
      speaker: merged.speaker,
      source: merged.source,
      startedAt: this.now(),
      replied: false,
      skipped: false,
      closed: false,
      revision,
    };
    this.activeBySession.set(turn.sessionId, turn);
    this.activeByPatient.set(patient.id, turn);
    this.service.store.bumpStat('turns');

    const prompt = buildTurnPrompt(merged, this.settings, {
      revisionInstruction: revision?.instruction,
      groupContext: this.groupContext.get(patient.id),
      currentVersion: revision?.currentVersion,
    });

    let outcome: 'idle' | 'timeout' | 'error' = 'idle';
    try {
      await this.sessions.prompt(turn.sessionId, prompt);
      outcome = await this.sessions.waitIdle(turn.sessionId, this.turnTimeoutMs);
    } catch (error) {
      outcome = 'error';
      this.service.store.bumpStat('errors');
      this.log(`Agent 回合失败：${error instanceof Error ? error.message : String(error)}`);
    }

    turn.closed = true;
    this.activeBySession.delete(turn.sessionId);
    this.activeByPatient.delete(patient.id);

    if (!turn.replied && !turn.skipped) {
      if (outcome === 'timeout') this.service.store.bumpStat('timeouts');
      if (revision) {
        await this.notify(
          `改稿没有完成（${outcome === 'timeout' ? '超时' : '模型报错'}），仍保留第 ${revision.currentVersion} 版，请重试。`,
        );
        this.emit('draft.revision.failed', {
          draftId: revision.draftId,
          patientId: patient.id,
          reason: outcome,
        });
      } else {
        this.log(`回合未产出工具调用（${outcome}），使用模板草稿 patient=${patient.id}`);
        await this.fallback(merged, turn, group);
      }
    }

    await this.drainQueue(patient, group);
  }

  private async drainQueue(patient: Patient, group: ManagedGroup): Promise<void> {
    const queued = this.queuedMessages.get(patient.id);
    if (!queued || queued.length === 0) return;
    this.queuedMessages.delete(patient.id);
    const last = queued[queued.length - 1];
    const speaker = this.service.resolveSpeaker(group, last.from);
    const merged: MergedInbound = {
      id: `batch_${++this.turnSeq}`,
      roomId: group.roomId,
      groupId: group.id,
      groupName: group.name,
      patientId: patient.id,
      advisorId: group.advisorId ?? this.settings.advisorId,
      messages: queued,
      speaker,
      source: 'inbound',
      mergedAt: this.now(),
      lastMessageAt: last.msgtime,
    };
    await this.executeTurn(merged);
  }

  /** 模板降级：模型超时 / 报错 / 没调工具 */
  private async fallback(
    merged: MergedInbound,
    turn: ActiveTurn | undefined,
    group: ManagedGroup,
  ): Promise<void> {
    const patient = this.service.store.getPatient(merged.patientId);
    if (!patient) return;
    const summary = summarizeMessages(merged.messages) || '（无文字内容）';
    try {
      const result = await this.bridge.enqueueDraft({
        advisorId: group.advisorId ?? this.settings.advisorId,
        groupRoomId: group.roomId,
        patientId: patient.id,
        customerId: merged.speaker.id,
        customerName: patient.displayName,
        lastInboundAt: merged.lastMessageAt,
        inboundMessageIds: messageIds(merged.messages),
        mediaIds: mediaPaths(merged.messages),
        inboundSummary: summary,
        body: fallbackBody(this.settings, patient.displayName),
        riskLevel: 'low',
        source: merged.source,
        fallback: true,
        citedMemoryIds: [],
        citedKnowledgeIds: [],
      });
      if (turn) turn.replied = true;
      this.service.store.bumpStat('fallbacks');
      this.emit('draft.created', {
        draftId: result.draftId,
        patientId: patient.id,
        groupId: group.id,
        advisorId: group.advisorId ?? this.settings.advisorId,
        source: merged.source,
        fallback: true,
        riskLevel: 'low',
      });
      this.log(`已降级为模板草稿 ${result.draftId}（patient=${patient.id}）`);
    } catch (error) {
      this.log(`模板草稿入队失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------- 沙盒回合（#40） ----------

  /**
   * 体验中心的一轮：真 Agent / 真工具，草稿交给控制台沙盒。
   * 不计入患者域统计，不进入 C2 队列，也不触发 SSE 的正式草稿事件。
   */
  async runSandboxTurn(input: SandboxTurnInput): Promise<void> {
    const sink = this.sandboxSink?.();
    if (!sink) throw new Error('SANDBOX_SINK_UNAVAILABLE');

    const at = this.now();
    const patient: Patient = {
      id: input.patient.id,
      tenantId: input.patient.tenantId,
      displayName: input.patient.displayName,
      externalUserId: input.patient.externalUserId,
      tags: [],
      consent: 'unknown',
      status: 'serving',
      demo: false,
      accompaniedSince: at,
      createdAt: at,
      updatedAt: at,
    };
    const group: ManagedGroup = {
      id: input.group.id,
      tenantId: input.patient.tenantId,
      roomId: input.group.roomId,
      name: input.group.name,
      nameSource: 'config',
      status: 'serving',
      advisorId: this.settings.advisorId,
      memberCount: 1,
      externalMemberCount: 1,
      lastActiveAt: at,
      demo: false,
      createdAt: at,
      updatedAt: at,
    };
    const speaker: Speaker = {
      id: input.patient.externalUserId,
      displayName: input.patient.displayName,
      role: 'self',
      isExternal: true,
    };
    const message: InboundMessage = {
      msgid: `msg_sbx_${at}_${++this.turnSeq}`,
      roomId: group.roomId,
      from: speaker.id,
      text: input.text,
      msgtime: input.at,
      ...(input.mediaIds.length > 0 ? { msgtype: 'image' as const } : {}),
    };
    const merged: MergedInbound = {
      id: `sandbox_${++this.turnSeq}`,
      roomId: group.roomId,
      groupId: group.id,
      groupName: group.name,
      patientId: patient.id,
      advisorId: this.settings.advisorId,
      messages: [message],
      speaker,
      source: 'inbound',
      mergedAt: at,
      lastMessageAt: input.at,
    };

    const turn: ActiveTurn = {
      id: merged.id,
      sessionId: input.sessionId,
      patient,
      group,
      messages: merged.messages,
      speaker,
      source: 'inbound',
      startedAt: at,
      replied: false,
      skipped: false,
      closed: false,
      sandbox: sink,
    };
    this.activeBySession.set(turn.sessionId, turn);
    this.activeByPatient.set(patient.id, turn);

    let outcome: 'idle' | 'timeout' | 'error' = 'idle';
    try {
      await this.sessions.prompt(turn.sessionId, buildTurnPrompt(merged, this.settings));
      outcome = await this.sessions.waitIdle(turn.sessionId, this.turnTimeoutMs);
    } catch (error) {
      outcome = 'error';
      this.log(`沙盒回合失败：${error instanceof Error ? error.message : String(error)}`);
    }

    turn.closed = true;
    this.activeBySession.delete(turn.sessionId);
    this.activeByPatient.delete(patient.id);

    if (!turn.replied && !turn.skipped) {
      try {
        sink.enqueueDraft({
          sessionId: turn.sessionId,
          patientId: patient.id,
          groupId: group.id,
          groupName: group.name,
          body: fallbackBody(this.settings, patient.displayName),
          inboundSummary: summarizeMessages(merged.messages) || '（无文字内容）',
          riskLevel: 'low',
          fallback: true,
          advisorId: this.settings.advisorId,
          citedMemoryIds: [],
          citedKnowledgeIds: [],
        });
      } catch (error) {
        this.log(`沙盒模板草稿失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.log(`沙盒回合未产出工具调用（${outcome}），使用模板草稿`);
    }
  }

  // ---------- 工具回调 ----------

  async replyDraft(
    sessionId: string,
    input: AgentReplyDraftInput,
  ): Promise<{ draftId: string; version: number }> {
    const turn = this.requireTurn(sessionId);
    // #37：草稿产出后先过红线校验再入队；未安装 zhiban-guard 时保持原样
    const review = this.guard?.review({
      body: input.body,
      riskLevel: input.riskLevel,
      patientId: turn.patient.id,
      groupId: turn.group.id,
      sessionId,
      source: turn.source,
      inboundText:
        turn.messages.length > 0
          ? turn.messages
              .map((message) => message.text)
              .join('\n')
              .slice(0, 4000)
          : turn.revision
            ? this.lastInboundText.get(turn.patient.id)
            : undefined,
    });
    const body = review?.guideOnly && review.referralBody ? review.referralBody : input.body;
    const riskLevel = review?.riskLevel ?? input.riskLevel;
    if (review && review.hits.length > 0) {
      this.log(
        `草稿命中风险规则 ${review.hits.join(',')} patient=${turn.patient.id} ` +
          `risk=${riskLevel} guideOnly=${review.guideOnly}`,
      );
    }
    if (turn.sandbox) {
      const result = turn.sandbox.enqueueDraft({
        sessionId: turn.sessionId,
        patientId: turn.patient.id,
        groupId: turn.group.id,
        groupName: turn.group.name,
        body,
        inboundSummary: input.inboundSummary,
        riskLevel,
        fallback: false,
        advisorId: this.settings.advisorId,
        citedMemoryIds: input.citedMemoryIds,
        citedKnowledgeIds: input.citedKnowledgeIds,
      });
      turn.replied = true;
      return result;
    }
    const revision = turn.revision;
    if (revision) {
      const result = await this.bridge.reviseDraft(revision.draftId, {
        body,
        inboundSummary: input.inboundSummary,
        riskLevel,
        instruction: revision.instruction,
        citedMemoryIds: input.citedMemoryIds,
        citedKnowledgeIds: input.citedKnowledgeIds,
      });
      turn.replied = true;
      this.localStats.revisions += 1;
      this.service.store.bumpStat('replies');
      this.emit('draft.revised', {
        draftId: result.draftId,
        patientId: turn.patient.id,
        groupId: turn.group.id,
        version: result.version,
        instruction: revision.instruction,
      });
      this.afterGuard(review, turn, result.draftId);
      this.log(`改稿完成 ${result.draftId} → 第 ${result.version} 版`);
      return result;
    }

    const group = turn.group;
    const result = await this.bridge.enqueueDraft({
      advisorId: group.advisorId ?? this.settings.advisorId,
      groupRoomId: group.roomId,
      patientId: turn.patient.id,
      customerId: turn.speaker.id,
      customerName: turn.patient.displayName,
      lastInboundAt: turn.messages.at(-1)?.msgtime,
      inboundMessageIds: messageIds(turn.messages),
      mediaIds: mediaPaths(turn.messages),
      inboundSummary: input.inboundSummary,
      body,
      riskLevel,
      source: turn.source,
      fallback: false,
      citedMemoryIds: input.citedMemoryIds,
      citedKnowledgeIds: input.citedKnowledgeIds,
    });
    turn.replied = true;
    this.service.store.bumpStat('replies');
    this.emit('draft.created', {
      draftId: result.draftId,
      patientId: turn.patient.id,
      groupId: group.id,
      advisorId: group.advisorId ?? this.settings.advisorId,
      source: turn.source,
      fallback: false,
      riskLevel,
    });
    this.afterGuard(review, turn, result.draftId);
    return result;
  }

  /** #37：命中规则后通知顾问；只带规则名与等级，不带正文。 */
  private afterGuard(review: DraftReviewResult | undefined, turn: ActiveTurn, draftId: string): void {
    if (!review || review.hits.length === 0) return;
    if (review.alertId) this.guard?.linkDraft?.(review.alertId, draftId);
    this.emit('draft.guard.hit', {
      draftId,
      patientId: turn.patient.id,
      groupId: turn.group.id,
      ruleIds: review.hits,
      ruleNames: review.hitNames,
      riskLevel: review.riskLevel,
      guideOnly: review.guideOnly,
      escalated: review.escalate,
    });
    const suffix = review.guideOnly ? '；正文已改为就医引导' : '';
    void this.notify(
      `⚠️ 草稿命中风险规则：${review.hitNames.join('、')}；风险等级 ${review.riskLevel}${suffix}。请重点审核。`,
    );
  }

  async replySkip(sessionId: string, _input: AgentReplySkipInput): Promise<{ skipped: true }> {
    const turn = this.requireTurn(sessionId);
    if (turn.replied) throw new Error('ALREADY_REPLIED');
    turn.skipped = true;
    if (turn.sandbox) return { skipped: true };
    this.service.store.bumpStat('skips');
    this.emit('patient.reply.skipped', {
      patientId: turn.patient.id,
      groupId: turn.group.id,
      reason: _input.reason,
    });
    return { skipped: true };
  }

  private requireTurn(sessionId: string): ActiveTurn {
    const turn = this.activeBySession.get(sessionId);
    if (!turn) {
      const closed = [...this.activeByPatient.values()].find((t) => t.sessionId === sessionId && t.closed);
      if (closed) throw new Error('TURN_CLOSED');
      throw new Error('NO_ACTIVE_TURN');
    }
    if (turn.closed) throw new Error('TURN_CLOSED');
    if (turn.replied) throw new Error('ALREADY_REPLIED');
    if (turn.skipped) throw new Error('ALREADY_SKIPPED');
    return turn;
  }

  // ---------- 核验回写 ----------

  async handleDraftVerified(draftId: string, outcome: VerifyOutcome): Promise<void> {
    const draft = this.bridge.getDraft(draftId);
    if (!draft) return;
    const patient = this.service.store.findPatientByExternalId(draft.customerId);
    if (!patient) return;

    try {
      const session = await this.sessions.ensure(patient);
      await this.sessions.injectContext(
        session.sessionId,
        `[系统通知] 草稿 ${draftId}（第 ${draft.version ?? 1} 版）${VERIFY_TEXT[outcome]}`,
      );
      this.emit('patient.verification.injected', {
        draftId,
        patientId: patient.id,
        outcome,
      });
    } catch (error) {
      this.log(`核验结果回写失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------- 顾问改稿 ----------

  /** 顾问在机器人 1:1 里发的文字；有活动草稿则作为改稿指令 */
  async handleAdvisorText(advisorUserId: string, text: string): Promise<boolean> {
    const advisor =
      this.service.store.getAdvisor(advisorUserId) ??
      this.service.store.getAdvisorByWecomUserId(advisorUserId);
    if (!advisor) return false;

    const draft = this.bridge.getActiveDraft(advisor.id);
    if (!draft) {
      await this.notify(
        '用法：收到草稿后直接回复一句话，我就按你的要求改。例如「语气再温和一点，加上明天记得复诊」。',
      );
      return true;
    }
    const patient = this.service.store.findPatientByExternalId(draft.customerId);
    const group = this.service.store.getGroupByRoomId(draft.groupRoomId);
    if (!patient || !group) {
      await this.notify('这条草稿对应的患者或群已不存在，请手动处理。');
      return true;
    }
    if (this.activeByPatient.has(patient.id)) {
      await this.notify('上一轮还在生成，请稍后再发一次改稿指令。');
      return true;
    }

    this.bridge.requestRevision(draft.id, text);
    await this.notify(`收到，正在按你的要求改第 ${(draft.version ?? 1) + 1} 版…`);

    const advisorSpeaker: Speaker = {
      id: advisor.wecomUserId,
      displayName: advisor.name,
      role: 'advisor',
      isExternal: false,
    };
    const merged: MergedInbound = {
      id: `revision_${++this.turnSeq}`,
      roomId: group.roomId,
      groupId: group.id,
      groupName: group.name,
      patientId: patient.id,
      advisorId: advisor.id,
      messages: [],
      speaker: advisorSpeaker,
      source: 'inbound',
      mergedAt: this.now(),
      lastMessageAt: this.now(),
    };
    this.emit('draft.revision.requested', {
      draftId: draft.id,
      patientId: patient.id,
      version: draft.version ?? 1,
    });
    await this.executeTurn(merged, {
      draftId: draft.id,
      instruction: text,
      currentVersion: draft.version ?? 1,
    });
    return true;
  }

  // ---------- 工具 ----------

  private async notify(text: string): Promise<void> {
    try {
      await this.bridge.notifyAdvisor(text);
    } catch (error) {
      this.log(`回执失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private log(line: string): void {
    this.logger?.(line);
  }
}
