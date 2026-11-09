import { applyTransition } from './state-machine.ts';
import { buildCard } from './message.ts';
import type { Advisor, Alert, AlertKind, Draft } from './types.ts';
import type { BotPort, Clock, Store } from './ports.ts';

export interface QueueConfig {
  maxPushAttempts: number;
  retryBackoffMs: number;
  remindAfterMs: number;
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
  remindAfterMs: 15 * 60_000,
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

  async tick(): Promise<PushResult[]> {
    const now = this.clock.now();
    const results: PushResult[] = [];

    for (const advisor of this.store.listAdvisors()) {
      if (advisor.status !== 'active') continue;

      const activeId = this.store.getActiveDraft(advisor.id);
      if (activeId !== undefined) {
        const active = this.store.getDraft(activeId);
        if (active) this.handleTimeout(advisor, active, now);
        continue;
      }

      if (!advisor.chatId) {
        if (!advisor.noChatIdAlerted) {
          advisor.noChatIdAlerted = true;
          this.store.saveAdvisor(advisor);
          this.alert(advisor.id, undefined, 'NO_CHATID', `${advisor.name} 尚未与机器人建立会话，无法推送`);
        }
        continue;
      }

      const queued = this.store.listQueued(advisor.id, now);
      const next = queued[0];
      if (!next) continue;

      results.push(await this.push(advisor, next, queued.length, now));
    }

    return results;
  }

  private async push(
    advisor: Advisor,
    draft: Draft,
    queueDepth: number,
    now: number,
  ): Promise<PushResult> {
    this.store.setActiveDraft(advisor.id, draft.id);
    draft.pushAttempts += 1;

    try {
      const chatId = advisor.chatId as string;

      // 卡片已成功但正文失败时，重试只补正文，避免重复卡片
      if (!draft.cardMessageId) {
        const cardRes = await this.bot.sendCard(chatId, buildCard(draft, queueDepth));
        draft.cardMessageId = cardRes.messageId;
      }

      const bodyRes = await this.bot.sendText(chatId, draft.body);
      draft.bodyMessageId = bodyRes.messageId;

      if (draft.status === 'FAILED') applyTransition(draft, 'QUEUED');
      applyTransition(draft, 'PUSHED');
      draft.pushedAt = now;
      draft.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      draft.errorCode = undefined;
      this.store.saveDraft(draft);
      this.audit(advisor.id, 'push', draft.id, 'ok');

      return { advisorId: advisor.id, draftId: draft.id, pushed: true };
    } catch (err) {
      const errorCode = err instanceof Error ? err.message : 'UNKNOWN_PUSH_ERROR';
      draft.errorCode = errorCode;

      if (draft.pushAttempts >= this.config.maxPushAttempts) {
        this.store.setActiveDraft(advisor.id, undefined);
        if (draft.status === 'QUEUED' || draft.status === 'FAILED') {
          if (draft.status === 'FAILED') applyTransition(draft, 'QUEUED');
          applyTransition(draft, 'DEAD_LETTER');
        }
        this.store.saveDraft(draft);
        this.audit(advisor.id, 'push', draft.id, 'dead_letter', errorCode);
        this.alert(
          advisor.id,
          draft.id,
          'DEAD_LETTER',
          `草稿 ${draft.id} 连续 ${draft.pushAttempts} 次推送失败，已进入死信：${errorCode}`,
        );
        return { advisorId: advisor.id, draftId: draft.id, pushed: false, reason: 'DEAD_LETTER' };
      }

      if (draft.status === 'QUEUED') applyTransition(draft, 'FAILED');
      applyTransition(draft, 'QUEUED');
      draft.nextAttemptAt = now + this.config.retryBackoffMs * draft.pushAttempts;
      this.store.setActiveDraft(advisor.id, undefined);
      this.store.saveDraft(draft);
      this.audit(advisor.id, 'push', draft.id, 'retry', errorCode);
      this.alert(
        advisor.id,
        draft.id,
        'PUSH_FAILED',
        `草稿 ${draft.id} 第 ${draft.pushAttempts} 次推送失败，将重试：${errorCode}`,
      );

      return { advisorId: advisor.id, draftId: draft.id, pushed: false, reason: errorCode };
    }
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

    if (elapsed >= this.config.remindAfterMs && draft.remindedAt === undefined) {
      draft.remindedAt = now;
      this.store.saveDraft(draft);
      this.audit(advisor.id, 'remind', draft.id, 'ok');
      if (advisor.chatId) {
        void this.bot
          .sendText(
            advisor.chatId,
            `提醒：还有 1 条草稿待处理（${draft.groupName} · ${draft.customerName}）`,
          )
          .catch(() => undefined);
      }
    }
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
