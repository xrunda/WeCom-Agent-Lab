import { applyTransition } from './state-machine.ts';
import { buildWaitingReminder } from './message.ts';
import type { Advisor, Alert, AlertKind, Draft } from './types.ts';
import type { BotPort, Clock, Store } from './ports.ts';

export interface QueueConfig {
  maxPushAttempts: number;
  retryBackoffMs: number;
  /** #163：客户等待超过该阈值时发一条聚合提醒（不带正文），默认 30 分钟 */
  remindAfterMs: number;
  /** 同一顾问两条聚合提醒的最小间隔，默认 60 分钟，避免刷屏 */
  remindRepeatMs: number;
  escalateAfterMs: number;
  /**
   * #39：升级时 1:1 推送的主管会话（企微 userid / 与机器人的 1:1 chatId）。
   * 为空时只产生 `ESCALATED` 告警，不额外推送。
   */
  supervisorChatIds: string[];
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxPushAttempts: 3,
  retryBackoffMs: 60_000,
  remindAfterMs: 30 * 60_000,
  remindRepeatMs: 60 * 60_000,
  escalateAfterMs: 60 * 60_000,
  supervisorChatIds: [],
};

export interface PushResult {
  advisorId: string;
  draftId: string;
  pushed: boolean;
  reason?: string;
}

export interface QueueDeps {
  store: Store;
  bot: BotPort;
  clock: Clock;
  config?: Partial<QueueConfig>;
  onAlert?: (alert: Alert) => void;
}

/**
 * 串行队列：每个顾问同一时间只允许一条 PUSHED 未处理的草稿。
 * 不变量：activeDraft 非空时，不推送任何新草稿。
 */
export class SerialQueue {
  private readonly store: Store;
  private readonly bot: BotPort;
  private readonly clock: Clock;
  private readonly config: QueueConfig;
  private readonly onAlert?: (alert: Alert) => void;

  constructor(deps: QueueDeps) {
    this.store = deps.store;
    this.bot = deps.bot;
    this.clock = deps.clock;
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...deps.config };
    this.onAlert = deps.onAlert;
  }

  /**
   * #163：草稿不再向员工 1:1 推送卡片/正文/图片，内容只在侧边栏展示。
   * 这里只把排队草稿标记为 PUSHED 并做「客户在等」聚合提醒。
   */
  async tick(): Promise<PushResult[]> {
    const now = this.clock.now();
    const results: PushResult[] = [];

    for (const advisor of this.store.listAdvisors()) {
      if (advisor.status !== 'active') continue;

      results.push(...this.markQueued(advisor, now));

      const waiting = this.store
        .listDrafts()
        .filter((draft) => draft.advisorId === advisor.id && draft.status === 'PUSHED')
        .sort(
          (a, b) =>
            (a.pushedAt ?? a.queuedAt) - (b.pushedAt ?? b.queuedAt) || a.id.localeCompare(b.id),
        );
      // active 只用于升级计时：上一条处理完后，交给最久未处理的 PUSHED 草稿
      const current = this.store.getActiveDraft(advisor.id);
      const currentDraft = current ? this.store.getDraft(current) : undefined;
      if (currentDraft?.status !== 'PUSHED' && waiting.length > 0) {
        this.store.setActiveDraft(advisor.id, waiting[0]!.id);
      }
      if (waiting.length > 0) await this.remindWaiting(advisor, waiting, now);

      const activeId = this.store.getActiveDraft(advisor.id);
      const active = activeId ? this.store.getDraft(activeId) : undefined;
      if (active) this.handleTimeout(advisor, active, now);
    }

    return results;
  }

  /** 把排队草稿标记为 PUSHED（侧边栏据此展示）；不产生任何 1:1 内容消息 */
  private markQueued(advisor: Advisor, now: number): PushResult[] {
    const queued = this.store.listQueued(advisor.id, now);
    if (queued.length === 0) return [];

    const results: PushResult[] = [];
    for (const draft of queued) {
      if (draft.status === 'FAILED') applyTransition(draft, 'QUEUED');
      applyTransition(draft, 'PUSHED');
      draft.pushAttempts += 1;
      // 等待时长从入队算起：标记 PUSHED 只是状态变化，不是重新计时
      draft.pushedAt = draft.queuedAt;
      draft.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      draft.errorCode = undefined;
      this.store.saveDraft(draft);
      this.audit(advisor.id, 'push', draft.id, 'ok');
      results.push({ advisorId: advisor.id, draftId: draft.id, pushed: true });
    }

    return results;
  }

  /**
   * 「客户在等」聚合提醒：超过阈值、且距上一条提醒超过间隔才发。
   * 只带群数、条数与最久等待时长，不带任何正文；提醒后逐条记 remindedAt，
   * 避免重启后重复提醒同一批草稿。
   */
  private async remindWaiting(advisor: Advisor, waiting: Draft[], now: number): Promise<void> {
    const oldest = waiting[0]!;
    const since = oldest.pushedAt ?? oldest.queuedAt;
    const oldestWait = now - since;
    if (oldestWait < this.config.remindAfterMs) return;

    const pending = waiting.filter((draft) => draft.remindedAt === undefined);
    if (pending.length === 0) return;
    const last = advisor.waitingRemindedAt;
    if (last !== undefined && now - last < this.config.remindRepeatMs) return;

    if (!advisor.chatId) {
      if (!advisor.noChatIdAlerted) {
        advisor.noChatIdAlerted = true;
        this.store.saveAdvisor(advisor);
        this.alert(advisor.id, undefined, 'NO_CHATID', `${advisor.name} 尚未与机器人建立会话，无法提醒`);
      }
      return;
    }

    const groups = new Set(waiting.map((draft) => draft.groupRoomId)).size;
    try {
      await this.bot.sendText(advisor.chatId, buildWaitingReminder(groups, oldestWait).text.content);
    } catch (err) {
      const errorCode = err instanceof Error ? err.message : 'UNKNOWN_PUSH_ERROR';
      this.audit(advisor.id, 'remind', pending[0]!.id, 'failed', errorCode);
      this.alert(
        advisor.id,
        pending[0]!.id,
        'PUSH_FAILED',
        `等待提醒发送失败，将在下一轮重试：${errorCode}`,
      );
      return;
    }

    for (const draft of pending) {
      draft.remindedAt = now;
      this.store.saveDraft(draft);
      this.audit(advisor.id, 'remind', draft.id, 'ok');
    }
    advisor.waitingRemindedAt = now;
    this.store.saveAdvisor(advisor);
  }

  private handleTimeout(advisor: Advisor, draft: Draft, now: number): void {
    if (draft.status !== 'PUSHED') {
      this.store.setActiveDraft(advisor.id, undefined);
      return;
    }

    const elapsed = now - (draft.pushedAt ?? now);

    if (elapsed >= this.config.escalateAfterMs && draft.escalatedAt === undefined) {
      draft.escalatedAt = now;
      this.store.saveDraft(draft);
      this.audit(advisor.id, 'escalate', draft.id, 'ok');
      this.alert(
        advisor.id,
        draft.id,
        'ESCALATED',
        `草稿 ${draft.id} 超过 ${Math.round(this.config.escalateAfterMs / 60000)} 分钟未处理，已升级`,
      );
      this.notifySupervisors(advisor, draft);
      return;
    }

    // 「客户在等」提醒统一由 remindWaiting 聚合发送，这里只管升级
  }

  private alert(
    advisorId: string,
    draftId: string | undefined,
    kind: AlertKind,
    message: string,
  ): void {
    const alert: Alert = {
      kind,
      message,
      at: this.clock.now(),
      advisorId,
      draftId,
    };
    this.store.emitAlert(alert);
    this.onAlert?.(alert);
  }

  /**
   * #39：升级时把通知 1:1 推给配置的主管。
   * 只带群名与客户名，不带消息正文；推送失败只影响通知，不影响队列状态。
   */
  private notifySupervisors(advisor: Advisor, draft: Draft): void {
    const targets = this.config.supervisorChatIds.filter(
      (chatId) => chatId !== '' && chatId !== advisor.chatId,
    );
    if (targets.length === 0) return;
    const minutes = Math.round(this.config.escalateAfterMs / 60_000);
    const text = `升级：${advisor.name} 的草稿超过 ${minutes} 分钟未处理（${draft.groupName} · ${draft.customerName}）`;
    for (const chatId of targets) {
      void this.bot.sendText(chatId, text).catch(() => undefined);
    }
  }

  private audit(
    actor: string,
    action: string,
    target: string,
    result: string,
    errorCode?: string,
  ): void {
    this.store.appendAudit({
      at: this.clock.now(),
      actor,
      action,
      target,
      result,
      errorCode,
    });
  }
}
