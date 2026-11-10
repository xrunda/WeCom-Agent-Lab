import { applyTransition } from './state-machine.ts';
import { matchSentMessage } from './matcher.ts';
import type { Alert, AlertKind, Draft, VerificationResult } from './types.ts';
import type { ArchivePort, Clock, Store } from './ports.ts';

export interface VerifierConfig {
  /** 员工点确认后，等多久开始第一次回读 */
  verifyDelayMs: number;
  /** 没匹配到时，下次再试的间隔 */
  verifyRetryBackoffMs: number;
  /** 最多尝试几次，超过判 UNVERIFIED */
  maxVerifyAttempts: number;
  /** 回读时间窗口向前看多久 */
  verifyLookbackMs: number;
  /** PUSHED 但没点确认时，多久后开始主动回读（防止员工忘点） */
  forgottenAckGraceMs: number;
  fuzzyThreshold: number;
  minFuzzyLength: number;
  /** 连续错群多少次暂停该顾问 */
  pauseAfterMisroutes: number;
}

export const DEFAULT_VERIFIER_CONFIG: VerifierConfig = {
  verifyDelayMs: 3 * 60_000,
  verifyRetryBackoffMs: 5 * 60_000,
  maxVerifyAttempts: 4,
  verifyLookbackMs: 10 * 60_000,
  forgottenAckGraceMs: 10 * 60_000,
  fuzzyThreshold: 0.9,
  minFuzzyLength: 8,
  pauseAfterMisroutes: 2,
};

export interface VerifierDeps {
  store: Store;
  archive: ArchivePort;
  clock: Clock;
  config?: Partial<VerifierConfig>;
  onAlert?: (alert: Alert) => void;
}

export class Verifier {
  private readonly store: Store;
  private readonly archive: ArchivePort;
  private readonly clock: Clock;
  private readonly config: VerifierConfig;
  private readonly onAlert?: (alert: Alert) => void;

  constructor(deps: VerifierDeps) {
    this.store = deps.store;
    this.archive = deps.archive;
    this.clock = deps.clock;
    this.config = { ...DEFAULT_VERIFIER_CONFIG, ...deps.config };
    this.onAlert = deps.onAlert;
  }

  async runDue(): Promise<VerificationResult[]> {
    const now = this.clock.now();
    const results: VerificationResult[] = [];

    for (const draft of this.store.listDrafts()) {
      if (draft.status === 'ACKNOWLEDGED') {
        if (draft.nextVerifyAt === undefined || now < draft.nextVerifyAt) continue;
        const res = await this.verify(draft, now, false);
        if (res) results.push(res);
        continue;
      }

      // 员工可能忘点"已发送"：PUSHED 超过宽限期后也主动回读
      if (draft.status === 'PUSHED') {
        if (draft.pushedAt === undefined) continue;
        if (now < draft.pushedAt + this.config.forgottenAckGraceMs) continue;
        const res = await this.verify(draft, now, true);
        if (res) results.push(res);
      }
    }

    return results;
  }

  private async verify(
    draft: Draft,
    now: number,
    autoAck: boolean,
  ): Promise<VerificationResult | null> {
    const anchor = draft.ackAt ?? draft.pushedAt ?? now;
    // 存档里的发送者是企微 userid；advisorId 可能是 P1 的内部 id。
    // bot-live 场景两者相同，P1 场景靠顾问的 chatId 才能匹配到员工发出的消息。
    const advisor = this.store.getAdvisor(draft.advisorId);
    const fromUser = advisor?.chatId ?? draft.advisorId;
    let messages = await this.archive.listSentMessages({
      fromUser,
      since: anchor - this.config.verifyLookbackMs,
      until: now,
    });
    // 历史数据 / 测试夹具里 chatId 可能不是存档里的发送者，回退到 advisorId
    if (messages.length === 0 && fromUser !== draft.advisorId) {
      messages = await this.archive.listSentMessages({
        fromUser: draft.advisorId,
        since: anchor - this.config.verifyLookbackMs,
        until: now,
      });
    }

    const res = matchSentMessage({
      body: draft.body,
      expectedRoomId: draft.groupRoomId,
      messages,
      checkedAt: now,
      threshold: this.config.fuzzyThreshold,
      minFuzzyLength: this.config.minFuzzyLength,
    });

    // 上层要靠 draftId 找回草稿才能通知员工；UNVERIFIED 也要带，否则失败时静默
    res.draftId = draft.id;

    if (res.outcome === 'UNVERIFIED') {
      // 自动回读（员工尚未点确认）时，不判失败，继续等
      if (autoAck) return null;

      draft.verifyAttempts += 1;
      if (draft.verifyAttempts >= this.config.maxVerifyAttempts) {
        applyTransition(draft, 'UNVERIFIED');
        draft.verification = res;
        this.releaseIfActive(draft);
        this.store.saveDraft(draft);
        this.audit(draft, 'verify', 'unverified');
        this.alert(
          draft.advisorId,
          draft.id,
          'UNVERIFIED',
          `草稿 ${draft.id} 已确认发送，但 ${this.config.maxVerifyAttempts} 次回读均未在存档中匹配到`,
        );
        return res;
      }

      draft.nextVerifyAt = now + this.config.verifyRetryBackoffMs;
      this.store.saveDraft(draft);
      this.audit(draft, 'verify', 'retry');
      return null;
    }

    applyTransition(draft, res.outcome);
    draft.verification = res;
    this.releaseIfActive(draft);
    this.handleOutcome(draft, res);
    this.store.saveDraft(draft);
    this.audit(draft, 'verify', res.outcome.toLowerCase());
    return res;
  }

  private handleOutcome(draft: Draft, res: VerificationResult): void {
    const advisor = this.store.getAdvisor(draft.advisorId);
    if (!advisor) return;

    if (res.outcome === 'MISROUTE_ALERT') {
      advisor.consecutiveMisroutes += 1;
      this.store.saveAdvisor(advisor);
      this.alert(
        advisor.id,
        draft.id,
        'MISROUTE',
        `错群告警：草稿 ${draft.id} 本应发到 ${draft.groupName}，但在 ${res.matchedRoomId} 找到`,
      );

      if (
        advisor.consecutiveMisroutes >= this.config.pauseAfterMisroutes &&
        advisor.status === 'active'
      ) {
        advisor.status = 'paused';
        this.store.saveAdvisor(advisor);
        this.alert(
          advisor.id,
          draft.id,
          'ADVISOR_PAUSED',
          `${advisor.name} 连续 ${advisor.consecutiveMisroutes} 次错群，已暂停自动推送`,
        );
      }
      return;
    }

    if ((res.outcome === 'VERIFIED' || res.outcome === 'EDIT_SENT') && advisor.consecutiveMisroutes > 0) {
      advisor.consecutiveMisroutes = 0;
      this.store.saveAdvisor(advisor);
    }
  }

  private releaseIfActive(draft: Draft): void {
    if (this.store.getActiveDraft(draft.advisorId) === draft.id) {
      this.store.setActiveDraft(draft.advisorId, undefined);
    }
  }

  private alert(
    advisorId: string,
    draftId: string,
    kind: AlertKind,
    message: string,
  ): void {
    const alert: Alert = { kind, message, at: this.clock.now(), advisorId, draftId };
    this.store.emitAlert(alert);
    this.onAlert?.(alert);
  }

  private audit(draft: Draft, action: string, result: string): void {
    this.store.appendAudit({
      at: this.clock.now(),
      actor: 'verifier',
      action,
      target: draft.id,
      result,
    });
  }
}
