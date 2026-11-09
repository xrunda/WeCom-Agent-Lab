import type { SentMessage, VerificationResult } from './types.ts';

/** 去掉所有标点、符号与空白，统一全半角与大小写 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  if (s.length === 0) return out;
  if (s.length === 1) {
    out.set(s, 1);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice 系数，适合中文短文本 */
export function diceCoefficient(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let totalA = 0;
  let totalB = 0;
  let inter = 0;
  for (const v of A.values()) totalA += v;
  for (const v of B.values()) totalB += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  if (totalA + totalB === 0) return 1;
  return (2 * inter) / (totalA + totalB);
}

export interface MatchInput {
  body: string;
  expectedRoomId: string;
  messages: readonly SentMessage[];
  checkedAt: number;
  /** 模糊匹配阈值，默认 0.9 */
  threshold?: number;
  /** 正文过短时只接受精确匹配，默认 8 个字 */
  minFuzzyLength?: number;
}

function result(
  outcome: VerificationResult['outcome'],
  checkedAt: number,
  extra: Partial<VerificationResult> = {},
): VerificationResult {
  return { outcome, checkedAt, ...extra };
}

/**
 * 在员工发出的消息里找草稿正文。
 *
 * 优先级：
 * 1. 精确匹配 & 目标群 → VERIFIED
 * 2. 精确匹配 & 其他群 → MISROUTE_ALERT
 * 3. 模糊匹配 ≥ 阈值 & 目标群 → EDIT_SENT
 * 4. 模糊匹配 ≥ 阈值 & 其他群 → MISROUTE_ALERT
 * 5. 都没有 → UNVERIFIED
 */
export function matchSentMessage(input: MatchInput): VerificationResult {
  const threshold = input.threshold ?? 0.9;
  const minFuzzyLength = input.minFuzzyLength ?? 8;
  const target = normalizeText(input.body);

  if (target.length === 0) {
    return result('UNVERIFIED', input.checkedAt);
  }

  const normalized = input.messages
    .map((m) => ({ message: m, text: normalizeText(m.text) }))
    .filter((x) => x.text.length > 0);

  const exact = normalized.filter((x) => x.text === target);
  if (exact.length > 0) {
    const inExpected = exact.find((x) => x.message.roomid === input.expectedRoomId);
    if (inExpected) {
      return result('VERIFIED', input.checkedAt, {
        matchedMsgId: inExpected.message.msgid,
        matchedRoomId: inExpected.message.roomid,
        similarity: 1,
      });
    }
    const wrong = exact[0];
    return result('MISROUTE_ALERT', input.checkedAt, {
      matchedMsgId: wrong.message.msgid,
      matchedRoomId: wrong.message.roomid,
      similarity: 1,
    });
  }

  if (target.length < minFuzzyLength) {
    return result('UNVERIFIED', input.checkedAt);
  }

  let best: { message: SentMessage; sim: number } | undefined;
  for (const x of normalized) {
    const sim = diceCoefficient(target, x.text);
    if (!best || sim > best.sim) best = { message: x.message, sim };
  }

  if (best && best.sim >= threshold) {
    const outcome = best.message.roomid === input.expectedRoomId ? 'EDIT_SENT' : 'MISROUTE_ALERT';
    return result(outcome, input.checkedAt, {
      matchedMsgId: best.message.msgid,
      matchedRoomId: best.message.roomid,
      similarity: best.sim,
    });
  }

  return result('UNVERIFIED', input.checkedAt);
}
