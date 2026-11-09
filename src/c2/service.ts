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
  inboundSummary: string;
  body: string;
  ruleIds?: string[];
  riskLevel?: RiskLevel;
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
      inboundSummary: input.inboundSummary,
      body,
      ruleIds: input.ruleIds ?? [],
      riskLevel: input.riskLevel ?? 'low',
      status: 'QUEUED',
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

  acknowledge(draftId: string, action: AckAction): Draft {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new Error(`DRAFT_NOT_FOUND ${draftId}`);
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
    return this.acknowledge(parsed.draftId, parsed.action);
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
