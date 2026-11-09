import { parseButtonKey } from './message.ts';
import { SerialQueue } from './queue.ts';
import type { PushResult, QueueConfig } from './queue.ts';
import { Verifier, DEFAULT_VERIFIER_CONFIG } from './verifier.ts';
import type { VerifierConfig } from './verifier.ts';
import type {
  AckAction,
  Advisor,
  Alert,
  CustomerGroup,
  Draft,
  DraftRevision,
  DraftSource,
  GroupNameSource,
  RiskLevel,
  VerificationResult,
} from './types.ts';
import type { ArchivePort, BotPort, Clock, Store } from './ports.ts';

export interface ServiceConfig {
  queue?: Partial<QueueConfig>;
  verifier?: Partial<VerifierConfig>;
  /** 草稿正文硬上限，超过直接拒绝 */
  maxBodyChars?: number;
  /** 重启后从已有草稿的最大序号继续，避免 id 冲突 */
  initialSeq?: number;
}

const DEFAULT_MAX_BODY_CHARS = 1000;

export interface ServiceDeps {
  store: Store;
  bot: BotPort;
  archive: ArchivePort;
  clock: Clock;
  config?: ServiceConfig;
  onAlert?: (alert: Alert) => void;
}

export interface EnqueueDraftInput {
  id?: string;
  advisorId: string;
  groupRoomId: string;
  groupNameSource?: GroupNameSource;
  groupMembers?: string[];
  customerId: string;
  customerName: string;
  lastInboundAt?: number;
  inboundMessageId: string;
  /** #63：合并窗口内的全部消息 id；缺省用 inboundMessageId */
  inboundMessageIds?: string[];
  /** #54 / #63：合并输入附带的图片路径 */
  mediaIds?: string[];
  inboundSummary: string;
  body: string;
  ruleIds?: string[];
  riskLevel?: RiskLevel;
  /** #34：inbound（患者提问）/ proactive（Agent 主动） */
  source?: DraftSource;
  /** #34：模板降级草稿 */
  fallback?: boolean;
  citedMemoryIds?: string[];
  citedKnowledgeIds?: string[];
}

export interface TickResult {
  pushed: PushResult[];
  verified: VerificationResult[];
}

/**
 * C2 编排层：草稿入队、串行推送、员工确认、存档校验。
 * 所有平台交互通过 BotPort / ArchivePort 抽象，便于离线测试。
 */
export class C2Service {
  readonly store: Store;
  readonly bot: BotPort;
  readonly archive: ArchivePort;
  readonly clock: Clock;
  readonly queue: SerialQueue;
  readonly verifier: Verifier;

  private readonly config: ServiceConfig;
  private readonly maxBodyChars: number;
  private seq = 0;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.bot = deps.bot;
    this.archive = deps.archive;
    this.clock = deps.clock;
    this.config = deps.config ?? {};
    this.maxBodyChars = this.config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    this.seq = this.config.initialSeq ?? 0;

    this.queue = new SerialQueue({
      store: this.store,
      bot: this.bot,
      clock: this.clock,
      config: this.config.queue,
      onAlert: deps.onAlert,
    });

    this.verifier = new Verifier({
      store: this.store,
      archive: this.archive,
      clock: this.clock,
      config: this.config.verifier,
      onAlert: deps.onAlert,
    });
  }

  addAdvisor(input: { id: string; name: string; chatId?: string }): Advisor {
    const advisor: Advisor = {
      id: input.id,
      name: input.name,
      chatId: input.chatId,
      status: 'active',
      consecutiveMisroutes: 0,
    };
    this.store.saveAdvisor(advisor);
    this.store.appendAudit({
      at: this.clock.now(),
      actor: 'admin',
      action: 'add_advisor',
      target: input.id,
      result: 'ok',
    });
    return advisor;
  }

  bindGroup(input: {
    roomId: string;
    name: string;
    advisorId: string;
    chatId?: string;
  }): CustomerGroup {
    if (!this.store.getAdvisor(input.advisorId)) {
      throw new Error(`ADVISOR_NOT_FOUND ${input.advisorId}`);
    }
    const group: CustomerGroup = {
      roomId: input.roomId,
      chatId: input.chatId,
      name: input.name,
      advisorId: input.advisorId,
      status: 'mapped',
    };
    this.store.saveGroup(group);
    this.store.appendAudit({
      at: this.clock.now(),
      actor: 'admin',
      action: 'bind_group',
      target: input.roomId,
      result: 'ok',
    });
    return group;
  }

  enqueueDraft(input: EnqueueDraftInput): Draft {
    const group = this.store.getGroup(input.groupRoomId);
    if (!group) throw new Error(`GROUP_NOT_FOUND ${input.groupRoomId}`);
    if (group.status !== 'mapped') throw new Error(`GROUP_NOT_MAPPED ${input.groupRoomId}`);
    if (group.advisorId !== input.advisorId) {
      throw new Error(
        `ADVISOR_MISMATCH group=${input.groupRoomId} expected=${group.advisorId} got=${input.advisorId}`,
      );
    }
    if (!this.store.getAdvisor(input.advisorId)) {
      throw new Error(`ADVISOR_NOT_FOUND ${input.advisorId}`);
    }
    const body = input.body.trim();
    if (body.length === 0) throw new Error('EMPTY_BODY');
    if (body.length > this.maxBodyChars) {
      throw new Error(`BODY_TOO_LONG ${body.length} > ${this.maxBodyChars}`);
    }

    const now = this.clock.now();
    const version = 1;
    const draft: Draft = {
      id: input.id ?? this.nextDraftId(),
      advisorId: input.advisorId,
      groupRoomId: input.groupRoomId,
      groupName: group.name,
      groupNameSource: input.groupNameSource,
      groupMembers: input.groupMembers,
      customerId: input.customerId,
      customerName: input.customerName,
      lastInboundAt: input.lastInboundAt,
      inboundMessageId: input.inboundMessageId,
      inboundMessageIds: input.inboundMessageIds ?? [input.inboundMessageId],
      mediaIds: input.mediaIds ?? [],
      inboundSummary: input.inboundSummary,
      body,
      ruleIds: input.ruleIds ?? [],
      riskLevel: input.riskLevel ?? 'low',
      status: 'QUEUED',
      version,
      revisions: [
        { version, body, createdBy: 'agent', createdAt: now },
      ],
      source: input.source ?? 'inbound',
      fallback: input.fallback === true,
      citedMemoryIds: input.citedMemoryIds ?? [],
      citedKnowledgeIds: input.citedKnowledgeIds ?? [],
      createdAt: now,
      queuedAt: now,
      nextAttemptAt: now,
      pushAttempts: 0,
      verifyAttempts: 0,
    };

    this.store.saveDraft(draft);
    this.store.appendAudit({
      at: now,
      actor: 'pipeline',
      action: 'enqueue',
      target: draft.id,
      result: 'ok',
    });
    return draft;
  }

  acknowledge(draftId: string, action: AckAction, version?: number): Draft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new Error(`DRAFT_NOT_FOUND ${draftId}`);
    // #56：旧版卡片按钮失效。没有版本段的旧 key 按 v1 处理。
    const cardVersion = version ?? 1;
    if (cardVersion !== (draft.version ?? 1)) {
      throw new Error(`STALE_CARD ${draftId} card=v${cardVersion} current=v${draft.version ?? 1}`);
    }
    if (draft.status !== 'PUSHED') {
      // 已确认过（或已进入终态）时重复点击是常态：卡片按钮不会置灰，
      // 员工点两下、或点了上一轮的旧卡片都会走到这里，要和「没推送过」区分开。
      if (draft.status !== 'QUEUED' && draft.status !== 'FAILED') {
        throw new Error(`ALREADY_ACKNOWLEDGED ${draftId} status=${draft.status}`);
      }
      throw new Error(`DRAFT_NOT_PUSHED ${draftId} status=${draft.status}`);
    }

    const now = this.clock.now();
    const target = action === 'sent' ? 'ACKNOWLEDGED' : 'SKIPPED';

    draft.status = target;
    draft.ackAction = action;
    draft.ackAt = now;

    if (action !== 'skipped') {
      const delay = this.config.verifier?.verifyDelayMs ?? DEFAULT_VERIFIER_CONFIG.verifyDelayMs;
      draft.verifyAttempts = 0;
      draft.nextVerifyAt = now + delay;
    }

    if (this.store.getActiveDraft(draft.advisorId) === draft.id) {
      this.store.setActiveDraft(draft.advisorId, undefined);
    }

    this.store.saveDraft(draft);
    this.store.appendAudit({
      at: now,
      actor: draft.advisorId,
      action: `ack_${action}`,
      target: draft.id,
      result: 'ok',
    });
    return draft;
  }

  /** 机器人卡片按钮回调入口 */
  handleButtonCallback(key: string): Draft {
    const parsed = parseButtonKey(key);
    if (!parsed) throw new Error(`INVALID_BUTTON_KEY ${key}`);
    return this.acknowledge(parsed.draftId, parsed.action, parsed.version);
  }

  /**
   * #56：记录顾问的改稿指令（审计 + 让旧卡片立即失效），
   * 真正的正文由 Agent 下一轮调用 reply_draft 时通过 reviseDraft 写入。
   */
  requestRevision(draftId: string, instruction: string): Draft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new Error(`DRAFT_NOT_FOUND ${draftId}`);
    const text = instruction.trim();
    if (text.length === 0) throw new Error('EMPTY_REVISION_INSTRUCTION');
    this.store.appendAudit({
      at: this.clock.now(),
      actor: draft.advisorId,
      action: 'draft.revision.request',
      target: draft.id,
      result: 'ok',
      errorCode: text.slice(0, 120),
    });
    return draft;
  }

  /**
   * #56：把 Agent 按指令重写后的正文写成新版本，重新排队推送。
   * 新版本清空 cardMessageId，旧卡片（带旧版本号 key）点击时会被判为过期。
   */
  reviseDraft(
    draftId: string,
    input: {
      body: string;
      inboundSummary?: string;
      riskLevel?: RiskLevel;
      instruction?: string;
      citedMemoryIds?: string[];
      citedKnowledgeIds?: string[];
    },
  ): Draft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new Error(`DRAFT_NOT_FOUND ${draftId}`);
    if (draft.status !== 'PUSHED' && draft.status !== 'QUEUED') {
      throw new Error(`DRAFT_NOT_REVISABLE ${draftId} status=${draft.status}`);
    }
    const body = input.body.trim();
    if (body.length === 0) throw new Error('EMPTY_BODY');
    if (body.length > this.maxBodyChars) {
      throw new Error(`BODY_TOO_LONG ${body.length} > ${this.maxBodyChars}`);
    }

    const now = this.clock.now();
    const version = (draft.version ?? 1) + 1;
    const revision: DraftRevision = {
      version,
      body,
      instruction: input.instruction?.trim() || draft.revisionInstruction,
      createdBy: 'agent',
      createdAt: now,
    };
    const revisions = [...(draft.revisions ?? [{ version: 1, body: draft.body, createdBy: 'agent' as const, createdAt: draft.createdAt }]), revision];

    draft.version = version;
    draft.revisions = revisions;
    draft.body = body;
    draft.revisionInstruction = revision.instruction;
    draft.inboundSummary = input.inboundSummary?.trim() || draft.inboundSummary;
    draft.riskLevel = input.riskLevel ?? draft.riskLevel;
    draft.citedMemoryIds = input.citedMemoryIds ?? draft.citedMemoryIds;
    draft.citedKnowledgeIds = input.citedKnowledgeIds ?? draft.citedKnowledgeIds;
    // 重新排队：清掉本次推送状态与旧卡片，否则串行队列会把 active 当作仍在等待
    this.store.setActiveDraft(draft.advisorId, undefined);
    draft.cardMessageId = undefined;
    draft.bodyMessageId = undefined;
    draft.pushedAt = undefined;
    draft.pushAttempts = 0;
    draft.verifyAttempts = 0;
    draft.nextVerifyAt = undefined;
    draft.errorCode = undefined;
    draft.remindedAt = undefined;
    draft.escalatedAt = undefined;
    draft.status = 'QUEUED';
    draft.queuedAt = now;
    draft.nextAttemptAt = now;

    this.store.saveDraft(draft);
    this.store.appendAudit({
      at: now,
      actor: draft.advisorId,
      action: 'draft.revision',
      target: draft.id,
      result: 'ok',
      errorCode: `v${version}`,
    });
    return draft;
  }

  async tick(): Promise<TickResult> {
    const pushed = await this.queue.tick();
    const verified = await this.verifier.runDue();
    return { pushed, verified };
  }

  queueDepth(advisorId: string): number {
    const active = this.store.getActiveDraft(advisorId) ? 1 : 0;
    return active + this.store.listQueued(advisorId, this.clock.now()).length;
  }

  private nextDraftId(): string {
    this.seq += 1;
    return `draft_${this.seq}`;
  }
}
