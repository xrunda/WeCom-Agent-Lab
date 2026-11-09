/**
 * #40 体验中心沙盒后端。
 *
 * 渠道是模拟的，Agent 是真的：沙盒消息通过 `zhibanPatient.runSandboxTurn`
 * 进入该账号专属的 DSH 长期会话；草稿经 `zhibanSandboxSink` 回到这里，
 * 不进入 C2 队列、不推给真实顾问、不计入统计。
 *
 * 四种动作按契约产生 verified / edit_sent / misroute / unverified。
 * 每个账号每天最多 100 轮；数据全部打 sandbox=true。
 */
import { ConsoleError } from './console-error.ts';
import type { ConsoleMediaRecord, ConsoleStore } from './console-store.ts';
import {
  dayKey,
  SANDBOX_DAILY_LIMIT,
  SANDBOX_GUIDE_STEPS,
  SANDBOX_PRESETS,
  type SandboxDraft,
  type SandboxDraftStatus,
  type SandboxEvent,
  type SandboxMemory,
  type SandboxMessage,
  type SandboxOutcome,
  type SandboxSessionRecord,
  type SandboxVerification,
} from './console-types.ts';

export interface SandboxPatient {
  id: string;
  tenantId: string;
  displayName: string;
  externalUserId: string;
}

export interface SandboxGroup {
  id: string;
  roomId: string;
  name: string;
}

export interface SandboxAgentTurnInput {
  sessionId: string;
  patient: SandboxPatient;
  group: SandboxGroup;
  text: string;
  mediaIds: string[];
  at: number;
}

/** 由 zhiban-patient 实现；未安装时沙盒返回 502 */
export interface SandboxAgentPort {
  ensureSession(patient: SandboxPatient): Promise<string>;
  resetSession(patient: SandboxPatient): Promise<string>;
  runTurn(input: SandboxAgentTurnInput): Promise<void>;
  injectContext?(sessionId: string, text: string): Promise<void>;
}

export interface SandboxSinkDraftInput {
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

/** zhiban-patient 的沙盒回合把草稿交回控制台 */
export interface SandboxSinkPort {
  enqueueDraft(input: SandboxSinkDraftInput): { draftId: string; version: number };
}

export interface SandboxMediaWriter {
  write(mediaId: string, extension: string, data: Buffer): Promise<string>;
}

export interface SandboxServiceOptions {
  tenantId: string;
  store: ConsoleStore;
  timezone: string;
  now?: () => number;
  emit?: (type: string, data: unknown, sandbox?: boolean) => void;
  agent?: () => SandboxAgentPort | undefined;
  mediaWriter?: SandboxMediaWriter;
  dailyLimit?: number;
}

export interface SandboxSessionView {
  session: {
    id: string;
    patient: { id: string; displayName: string; demo: boolean };
    groups: Array<{ id: string; name: string; role: 'primary' | 'other' }>;
    createdAt: number;
    lastActiveAt: number;
  };
  presets: typeof SANDBOX_PRESETS;
  guideSteps: typeof SANDBOX_GUIDE_STEPS;
  quota: { dailyLimit: number; usedToday: number; remaining: number };
}

const DRAFT_STATUS: Record<SandboxOutcome, SandboxDraftStatus> = {
  verified: 'VERIFIED',
  edit_sent: 'EDIT_SENT',
  misroute: 'MISROUTE_ALERT',
  unverified: 'UNVERIFIED',
};

const TERMINAL: ReadonlySet<string> = new Set(['VERIFIED', 'EDIT_SENT', 'MISROUTE_ALERT', 'UNVERIFIED']);

const MAX_TEXT = 2000;
const MAX_EDITED_BODY = 1000;
const MAX_UPLOAD = 10 * 1024 * 1024;

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'account';
}

/** PNG / JPEG 尺寸；解析不出时返回 null（与契约允许的可空一致） */
export function imageSize(data: Buffer): { width: number | null; height: number | null } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

export class SandboxService implements SandboxSinkPort {
  private readonly tenantId: string;
  private readonly store: ConsoleStore;
  private timezone: string;
  private readonly now: () => number;
  private readonly emit: (type: string, data: unknown, sandbox?: boolean) => void;
  private readonly resolveAgent?: () => SandboxAgentPort | undefined;
  private readonly mediaWriter?: SandboxMediaWriter;
  private readonly dailyLimit: number;
  private readonly inflight = new Set<string>();

  constructor(options: SandboxServiceOptions) {
    this.tenantId = options.tenantId;
    this.store = options.store;
    this.timezone = options.timezone;
    this.now = options.now ?? (() => Date.now());
    this.emit = options.emit ?? (() => undefined);
    this.resolveAgent = options.agent;
    this.mediaWriter = options.mediaWriter;
    this.dailyLimit = options.dailyLimit ?? SANDBOX_DAILY_LIMIT;
  }

  // ---------- 会话 ----------

  async ensureSession(accountId: string): Promise<SandboxSessionView> {
    const existing = this.store.getSandboxSession(accountId);
    if (existing) return this.sessionView(existing);
    const agent = this.requireAgent();
    const at = this.now();
    const patient = this.patientFor(accountId);
    const sessionId = await agent.ensureSession(patient);
    const record: SandboxSessionRecord = {
      id: this.store.newId('sbx'),
      tenantId: this.tenantId,
      accountId,
      patientId: patient.id,
      sessionId,
      createdAt: at,
      lastActiveAt: at,
    };
    this.store.saveSandboxSession(record);
    this.recordEvent(record, 'sandbox.state', { sessionId: record.id });
    return this.sessionView(record);
  }

  sessionView(record: SandboxSessionRecord): SandboxSessionView {
    const quota = this.quotaFor(record.accountId);
    return {
      session: {
        id: record.id,
        patient: { id: record.patientId, displayName: '体验患者', demo: false },
        groups: [
          { id: this.groupFor(record.accountId, 1).id, name: '体验客户群', role: 'primary' },
          { id: this.groupFor(record.accountId, 2).id, name: '另一个客户群', role: 'other' },
        ],
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
      },
      presets: SANDBOX_PRESETS,
      guideSteps: SANDBOX_GUIDE_STEPS,
      quota,
    };
  }

  quotaFor(accountId: string): { dailyLimit: number; usedToday: number; remaining: number } {
    const day = dayKey(this.now(), this.timezone);
    const used = this.store.getSandboxQuota(accountId, day).used;
    return {
      dailyLimit: this.dailyLimit,
      usedToday: used,
      remaining: Math.max(0, this.dailyLimit - used),
    };
  }

  /** #41：租户时区变更后，每日额度的自然日边界随之变化 */
  setTimezone(timezone: string): void {
    this.timezone = timezone;
  }

  // ---------- 消息 ----------

  async postMessage(
    accountId: string,
    input: { kind?: unknown; text?: unknown; mediaId?: unknown },
  ): Promise<{ messageId: string; acceptedAt: number; quota: ReturnType<SandboxService['quotaFor']> }> {
    await this.ensureSession(accountId);
    const record = this.store.getSandboxSession(accountId);
    if (!record) throw new ConsoleError('INTERNAL', '沙盒会话创建失败');
    const kind = input.kind;
    if (kind !== 'text' && kind !== 'image') {
      throw new ConsoleError('VALIDATION_FAILED', 'kind 只能是 text 或 image');
    }
    let text = '';
    let mediaId: string | undefined;
    if (kind === 'text') {
      if (typeof input.text !== 'string' || input.text.trim() === '') {
        throw new ConsoleError('VALIDATION_FAILED', 'text 不能为空');
      }
      text = input.text.trim();
      if (text.length > MAX_TEXT) {
        throw new ConsoleError('VALIDATION_FAILED', 'text 不能超过 2000 字');
      }
    } else {
      if (typeof input.mediaId !== 'string' || input.mediaId.trim() === '') {
        throw new ConsoleError('VALIDATION_FAILED', 'image 消息必须带 mediaId');
      }
      mediaId = input.mediaId.trim();
      const media = this.store.getMedia(mediaId);
      if (!media || media.accountId !== accountId || !media.sandbox) {
        throw new ConsoleError('NOT_FOUND', '沙盒图片不存在');
      }
    }

    const day = dayKey(this.now(), this.timezone);
    const quota = this.store.getSandboxQuota(accountId, day);
    if (quota.used >= this.dailyLimit) {
      throw new ConsoleError('LIMIT_EXCEEDED', '今日沙盒对话已达上限，请次日再试');
    }
    this.store.saveSandboxQuota({ ...quota, used: quota.used + 1 });

    const at = this.now();
    const message: SandboxMessage = {
      id: this.store.newId('msg_sbx'),
      tenantId: this.tenantId,
      accountId,
      at,
      sender: 'customer',
      kind,
      ...(kind === 'text' ? { text } : { mediaId }),
    };
    this.store.saveSandboxMessage(message);
    this.touch(record);
    this.recordEvent(record, 'sandbox.message', {
      sessionId: record.id,
      message: { id: message.id, at: message.at, sender: message.sender, kind: message.kind, text: message.text },
    });
    this.emit('sandbox.message', { sessionId: record.id, message }, true);

    if (kind === 'text') {
      void this.runTurn(record, message);
    }
    return { messageId: message.id, acceptedAt: at, quota: this.quotaFor(accountId) };
  }

  private async runTurn(record: SandboxSessionRecord, message: SandboxMessage): Promise<void> {
    if (this.inflight.has(record.accountId)) return;
    this.inflight.add(record.accountId);
    try {
      const agent = this.requireAgent();
      const patient = this.patientFor(record.accountId);
      const group = this.groupFor(record.accountId, 1);
      await agent.runTurn({
        sessionId: record.sessionId,
        patient,
        group,
        text: message.text ?? '[图片]',
        mediaIds: message.mediaId ? [message.mediaId] : [],
        at: message.at,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.recordEvent(record, 'sandbox.state', { sessionId: record.id, error: detail.slice(0, 120) });
      this.emit('sandbox.state', { sessionId: record.id, error: detail.slice(0, 120) }, true);
    } finally {
      this.inflight.delete(record.accountId);
    }
  }

  /** zhiban-patient 的沙盒回合回调 */
  enqueueDraft(input: SandboxSinkDraftInput): { draftId: string; version: number } {
    const record = this.bySession(input.sessionId);
    if (!record) throw new Error('SANDBOX_SESSION_NOT_FOUND');
    const at = this.now();
    const draft: SandboxDraft = {
      id: this.store.newId('draft_sbx'),
      tenantId: this.tenantId,
      accountId: record.accountId,
      version: 1,
      body: input.body,
      status: 'PUSHED',
      riskLevel: input.riskLevel,
      inboundSummary: input.inboundSummary,
      createdAt: at,
      updatedAt: at,
      sandbox: true,
    };
    this.store.saveSandboxDraft(draft);
    this.touch(record);
    this.recordEvent(record, 'sandbox.draft', { sessionId: record.id, draft });
    this.emit('sandbox.draft', { sessionId: record.id, draft }, true);
    return { draftId: draft.id, version: draft.version };
  }

  // ---------- 状态 ----------

  state(accountId: string, since?: number): {
    session: { id: string; lastActiveAt: number };
    messages: SandboxMessage[];
    memories: SandboxMemory[];
    drafts: SandboxDraft[];
    verification: SandboxVerification | null;
    events: SandboxEvent[];
    quota: ReturnType<SandboxService['quotaFor']>;
  } {
    const record = this.store.getSandboxSession(accountId);
    if (!record) throw new ConsoleError('NOT_FOUND', '沙盒会话不存在，请先创建');
    const messages = this.store
      .listSandboxMessages(accountId)
      .filter((item) => since === undefined || item.at > since)
      .sort((a, b) => a.at - b.at);
    const drafts = this.store
      .listSandboxDrafts(accountId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const verifications = this.store
      .listSandboxVerifications(accountId)
      .sort((a, b) => a.checkedAt - b.checkedAt);
    const events = this.store
      .listSandboxEvents(accountId)
      .filter((item) => since === undefined || item.at > since)
      .sort((a, b) => a.at - b.at);
    return {
      session: { id: record.id, lastActiveAt: record.lastActiveAt },
      messages,
      memories: this.store.listSandboxMemories(accountId),
      drafts,
      verification: verifications.at(-1) ?? null,
      events,
      quota: this.quotaFor(accountId),
    };
  }

  // ---------- 四种动作 ----------

  action(
    accountId: string,
    draftId: string,
    input: { action?: unknown; editedBody?: unknown; targetGroupId?: unknown },
  ): { outcome: SandboxOutcome; draftStatus: SandboxDraftStatus; verification: SandboxVerification } {
    const record = this.store.getSandboxSession(accountId);
    if (!record) throw new ConsoleError('NOT_FOUND', '沙盒会话不存在');
    const draft = this.store.getSandboxDraft(accountId, draftId);
    if (!draft) throw new ConsoleError('NOT_FOUND', `沙盒草稿 ${draftId} 不存在`);
    if (TERMINAL.has(draft.status)) {
      throw new ConsoleError('CONFLICT', '草稿已是终态，不能重复操作');
    }

    const action = input.action;
    if (
      action !== 'send_original' &&
      action !== 'send_edited' &&
      action !== 'send_wrong_group' &&
      action !== 'ack_only'
    ) {
      throw new ConsoleError('VALIDATION_FAILED', 'action 只能是 send_original / send_edited / send_wrong_group / ack_only');
    }

    const primary = this.groupFor(accountId, 1);
    const other = this.groupFor(accountId, 2);
    let outcome: SandboxOutcome;
    let matchedMsgId: string | null = null;
    let matchedRoomId: string | null = null;
    let matchedGroupName: string | null = null;
    let similarity: number | null = null;

    if (action === 'send_original') {
      outcome = 'verified';
      matchedMsgId = this.store.newId('msg_sbx');
      matchedRoomId = primary.id;
      matchedGroupName = primary.name;
      similarity = 1;
    } else if (action === 'send_edited') {
      if (typeof input.editedBody !== 'string' || input.editedBody.trim() === '') {
        throw new ConsoleError('VALIDATION_FAILED', 'send_edited 必须带 editedBody');
      }
      if (input.editedBody.trim().length > MAX_EDITED_BODY) {
        throw new ConsoleError('VALIDATION_FAILED', 'editedBody 不能超过 1000 字');
      }
      outcome = 'edit_sent';
      matchedMsgId = this.store.newId('msg_sbx');
      matchedRoomId = primary.id;
      matchedGroupName = primary.name;
      similarity = 0.82;
    } else if (action === 'send_wrong_group') {
      const target = typeof input.targetGroupId === 'string' ? input.targetGroupId : other.id;
      if (target !== other.id) {
        throw new ConsoleError('VALIDATION_FAILED', 'targetGroupId 必须是另一个客户群');
      }
      outcome = 'misroute';
      matchedMsgId = this.store.newId('msg_sbx');
      matchedRoomId = other.id;
      matchedGroupName = other.name;
      similarity = 1;
    } else {
      outcome = 'unverified';
    }

    const at = this.now();
    const verification: SandboxVerification = {
      id: this.store.newId('vrf'),
      tenantId: this.tenantId,
      accountId,
      draftId,
      outcome,
      matchedMsgId,
      matchedRoomId,
      matchedGroupName,
      similarity,
      attempts: 1,
      checkedAt: at,
      sandbox: true,
    };
    this.store.saveSandboxVerification(verification);
    const status = DRAFT_STATUS[outcome];
    const updated: SandboxDraft = { ...draft, status, updatedAt: at };
    if (action === 'send_edited') {
      updated.body = (input.editedBody as string).trim();
      updated.version = 2;
    }
    this.store.saveSandboxDraft(updated);
    this.touch(record);
    this.recordEvent(record, 'sandbox.verification', {
      sessionId: record.id,
      outcome,
      verification,
    });
    this.emit('sandbox.verification', { sessionId: record.id, outcome, verification }, true);
    this.emit('sandbox.state', { sessionId: record.id }, true);

    const TEXT: Record<SandboxOutcome, string> = {
      verified: '✅ 已核验：草稿正文已在群里找到',
      edit_sent: '✏️ 已发送（内容有改动）',
      misroute: '⚠️ 发错群：回复出现在别的群',
      unverified: '❌ 未核验：没有在目标群找到这条正文',
    };
    const agent = this.resolveAgent?.();
    if (agent?.injectContext) {
      void agent
        .injectContext(record.sessionId, `[系统通知] 草稿 ${draftId} ${TEXT[outcome]}`)
        .catch(() => undefined);
    }
    return { outcome, draftStatus: status, verification };
  }

  // ---------- 重置 ----------

  async reset(accountId: string): Promise<SandboxSessionView> {
    const existing = this.store.getSandboxSession(accountId);
    if (!existing) return this.ensureSession(accountId);
    const agent = this.requireAgent();
    const patient = this.patientFor(accountId);
    const sessionId = await agent.resetSession(patient);
    this.store.clearSandboxData(accountId);
    const at = this.now();
    const record: SandboxSessionRecord = {
      ...existing,
      id: this.store.newId('sbx'),
      sessionId,
      createdAt: at,
      lastActiveAt: at,
    };
    this.store.saveSandboxSession(record);
    this.recordEvent(record, 'sandbox.state', { sessionId: record.id });
    this.emit('sandbox.state', { sessionId: record.id }, true);
    return this.sessionView(record);
  }

  // ---------- 外部事件（记忆面板） ----------

  /** 监听平台的 memory.created；只接收沙盒患者 */
  ingestMemoryEvent(type: string, data: unknown): void {
    if (type !== 'memory.created' || data === null || typeof data !== 'object') return;
    const event = data as Record<string, unknown>;
    const patientId = typeof event.patientId === 'string' ? event.patientId : undefined;
    if (!patientId || !patientId.startsWith('pat_sandbox_')) return;
    const record = this.store
      .listSandboxSessions()
      .find((item) => item.patientId === patientId);
    if (!record) return;
    const memory: SandboxMemory = {
      id: typeof event.memoryId === 'string' ? event.memoryId : this.store.newId('mem'),
      tenantId: this.tenantId,
      accountId: record.accountId,
      category: typeof event.category === 'string' ? event.category : 'other',
      content: typeof event.content === 'string' ? event.content.slice(0, 200) : '',
      createdAt: this.now(),
    };
    this.store.saveSandboxMemory(memory);
    this.recordEvent(record, 'sandbox.memory', { sessionId: record.id, memory });
    this.emit('sandbox.memory', { sessionId: record.id, memory }, true);
  }

  // ---------- 上传与媒体 ----------

  async saveUpload(
    accountId: string,
    file: { filename?: string; contentType?: string; data: Buffer },
  ): Promise<SandboxMedia> {
    if (!this.mediaWriter) {
      throw new ConsoleError('UPSTREAM_UNAVAILABLE', '媒体存储未配置');
    }
    const contentType = file.contentType ?? '';
    const extension =
      contentType === 'image/png' || file.filename?.toLowerCase().endsWith('.png')
        ? 'png'
        : contentType === 'image/jpeg' || /\.(jpe?g)$/i.test(file.filename ?? '')
          ? 'jpg'
          : '';
    if (!extension) {
      throw new ConsoleError('VALIDATION_FAILED', '只支持 JPG / PNG 图片');
    }
    if (file.data.length === 0 || file.data.length > MAX_UPLOAD) {
      throw new ConsoleError('VALIDATION_FAILED', '图片不能为空且不能超过 10 MB');
    }
    const mediaId = this.store.newId('med_sbx');
    const path = await this.mediaWriter.write(mediaId, extension, file.data);
    const size = imageSize(file.data);
    const record: ConsoleMediaRecord = {
      id: mediaId,
      tenantId: this.tenantId,
      accountId,
      path,
      contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
      size: file.data.length,
      width: size.width,
      height: size.height,
      sandbox: true,
      createdAt: this.now(),
    };
    this.store.saveMedia(record);
    return {
      mediaId,
      url: `/zhiban/api/media/${mediaId}`,
      width: record.width,
      height: record.height,
      size: record.size,
    };
  }

  media(accountId: string, mediaId: string): ConsoleMediaRecord {
    const media = this.store.getMedia(mediaId);
    if (!media || media.tenantId !== this.tenantId) {
      throw new ConsoleError('NOT_FOUND', '媒体不存在');
    }
    if (media.sandbox && media.accountId !== accountId) {
      throw new ConsoleError('NOT_FOUND', '媒体不存在');
    }
    return media;
  }

  // ---------- 内部 ----------

  private requireAgent(): SandboxAgentPort {
    const agent = this.resolveAgent?.();
    if (!agent) {
      throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 Agent 插件未安装或尚未就绪');
    }
    return agent;
  }

  private patientFor(accountId: string): SandboxPatient {
    const token = safeToken(accountId);
    return {
      id: `pat_sandbox_${token}`,
      tenantId: this.tenantId,
      displayName: '体验患者',
      externalUserId: `wm_sandbox_${token}`,
    };
  }

  private groupFor(accountId: string, index: 1 | 2): SandboxGroup {
    const token = safeToken(accountId);
    return {
      id: `grp_sandbox_${token}_${index}`,
      roomId: `wr_sandbox_${token}_${index}`,
      name: index === 1 ? '体验客户群' : '另一个客户群',
    };
  }

  private bySession(sessionId: string): SandboxSessionRecord | undefined {
    return this.store.listSandboxSessions().find((record) => record.sessionId === sessionId);
  }

  private touch(record: SandboxSessionRecord): void {
    this.store.saveSandboxSession({ ...record, lastActiveAt: this.now() });
  }

  private recordEvent(record: SandboxSessionRecord, type: string, data: Record<string, unknown>): void {
    const event: SandboxEvent = {
      id: this.store.newId('evt'),
      tenantId: this.tenantId,
      accountId: record.accountId,
      type,
      at: this.now(),
      data,
    };
    this.store.saveSandboxEvent(event);
  }
}

export interface SandboxMedia {
  mediaId: string;
  url: string;
  width: number | null;
  height: number | null;
  size: number;
}
