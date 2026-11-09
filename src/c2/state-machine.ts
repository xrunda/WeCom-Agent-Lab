import { DRAFT_STATUS } from './types.ts';
import type { Draft, DraftStatus } from './types.ts';

/**
 * 允许的状态转移。
 *
 * 关键约束：
 * - PUSHED 不能直接跳过 ACK 进入终态，但允许 VERIFIED 等（存档自动发现员工已发送）
 * - 终态不再转移
 */
const TRANSITIONS: Record<DraftStatus, readonly DraftStatus[]> = {
  QUEUED: [DRAFT_STATUS.PUSHED, DRAFT_STATUS.FAILED, DRAFT_STATUS.DEAD_LETTER],
  PUSHED: [
    DRAFT_STATUS.ACKNOWLEDGED,
    DRAFT_STATUS.SKIPPED,
    DRAFT_STATUS.VERIFIED,
    DRAFT_STATUS.EDIT_SENT,
    DRAFT_STATUS.MISROUTE_ALERT,
    DRAFT_STATUS.UNVERIFIED,
    DRAFT_STATUS.FAILED,
    DRAFT_STATUS.DEAD_LETTER,
    // #56：顾问私聊发指令，Agent 产出新版本，重新进入队列
    DRAFT_STATUS.QUEUED,
  ],
  FAILED: [DRAFT_STATUS.QUEUED, DRAFT_STATUS.DEAD_LETTER],
  ACKNOWLEDGED: [
    DRAFT_STATUS.VERIFIED,
    DRAFT_STATUS.EDIT_SENT,
    DRAFT_STATUS.MISROUTE_ALERT,
    DRAFT_STATUS.UNVERIFIED,
  ],
  SKIPPED: [],
  VERIFIED: [],
  EDIT_SENT: [],
  MISROUTE_ALERT: [],
  UNVERIFIED: [],
  DEAD_LETTER: [],
};

const TERMINAL: ReadonlySet<DraftStatus> = new Set([
  DRAFT_STATUS.SKIPPED,
  DRAFT_STATUS.VERIFIED,
  DRAFT_STATUS.EDIT_SENT,
  DRAFT_STATUS.MISROUTE_ALERT,
  DRAFT_STATUS.UNVERIFIED,
  DRAFT_STATUS.DEAD_LETTER,
]);

/** 释放串行队列的状态：员工已处理，或草稿已死 */
const RELEASES_QUEUE: ReadonlySet<DraftStatus> = new Set([
  DRAFT_STATUS.ACKNOWLEDGED,
  DRAFT_STATUS.SKIPPED,
  DRAFT_STATUS.VERIFIED,
  DRAFT_STATUS.EDIT_SENT,
  DRAFT_STATUS.MISROUTE_ALERT,
  DRAFT_STATUS.UNVERIFIED,
  DRAFT_STATUS.DEAD_LETTER,
]);

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function applyTransition(draft: Draft, to: DraftStatus): Draft {
  if (!canTransition(draft.status, to)) {
    throw new Error(`ILLEGAL_TRANSITION ${draft.status} -> ${to} (draft=${draft.id})`);
  }
  draft.status = to;
  return draft;
}

export function isTerminal(status: DraftStatus): boolean {
  return TERMINAL.has(status);
}

export function releasesQueue(status: DraftStatus): boolean {
  return RELEASES_QUEUE.has(status);
}
