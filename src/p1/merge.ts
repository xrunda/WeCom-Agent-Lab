/**
 * #63 连发合并。
 *
 * 患者连发「我今天」「吃了火锅」「[图片]」不应该产生 3 轮 / 3 份草稿。
 * 同一服务群内，最后一条消息之后静默 windowMs（默认 30 秒）才放行；
 * 超过 maxWaitMs（默认 2 分钟）即使还在连发也强制放行，避免无限等。
 *
 * 纯内存、可注入 now，单测直接调 flushDue。
 */
import type { InboundMessage } from './types.ts';

export interface MergeOptions {
  windowMs?: number;
  maxWaitMs?: number;
  /** 单批最多合并多少条，防止刷屏 */
  maxMessages?: number;
}

interface Batch {
  messages: InboundMessage[];
  firstAt: number;
  lastAt: number;
}

export class InboundMerger {
  private readonly windowMsValue: number;
  private readonly maxWaitMs: number;
  private readonly maxMessages: number;
  private readonly batches = new Map<string, Batch>();

  constructor(options: MergeOptions = {}) {
    this.windowMsValue = options.windowMs ?? 30_000;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.maxMessages = options.maxMessages ?? 20;
  }

  add(message: InboundMessage): void {
    const batch = this.batches.get(message.roomId);
    if (!batch) {
      this.batches.set(message.roomId, {
        messages: [message],
        firstAt: message.msgtime,
        lastAt: message.msgtime,
      });
      return;
    }
    batch.messages.push(message);
    batch.lastAt = Math.max(batch.lastAt, message.msgtime);
    if (batch.messages.length > this.maxMessages) batch.messages.shift();
  }

  /** 返回本轮应该放行的群（安静满窗口，或等满 maxWait） */
  flushDue(now: number): string[] {
    const due: string[] = [];
    for (const [roomId, batch] of this.batches) {
      const quiet = now - batch.lastAt >= this.windowMs;
      const waited = now - batch.firstAt >= this.maxWaitMs;
      if (quiet || waited) due.push(roomId);
    }
    return due;
  }

  /**
   * 距离该群下一次可放行还有多久（毫秒）。
   * 取「安静窗口」与「最长等待」两者中先到的一个；0 表示已经到点。
   */
  msUntilDue(roomId: string, now: number): number {
    const batch = this.batches.get(roomId);
    if (!batch) return 0;
    const quietIn = batch.lastAt + this.windowMsValue - now;
    const maxWaitIn = batch.firstAt + this.maxWaitMs - now;
    return Math.max(0, Math.min(quietIn, maxWaitIn));
  }

  /** 取出并清空一个群的批次；消息按时间升序 */
  take(roomId: string): InboundMessage[] {
    const batch = this.batches.get(roomId);
    if (!batch) return [];
    this.batches.delete(roomId);
    return [...batch.messages].sort((a, b) => a.msgtime - b.msgtime);
  }

  pending(roomId: string): number {
    return this.batches.get(roomId)?.messages.length ?? 0;
  }

  get windowMs(): number {
    return this.windowMsValue;
  }

  clear(): void {
    this.batches.clear();
  }
}

/** 合并输入的可读摘要：文字按顺序拼接，图片标 [图片] */
export function summarizeMessages(messages: InboundMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.msgtype === 'image') {
      parts.push('[图片]');
    } else if (message.text.trim().length > 0) {
      parts.push(message.text.trim());
    }
  }
  const flat = parts.join('；').replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

export function messageIds(messages: InboundMessage[]): string[] {
  return messages.map((message) => message.msgid);
}

export function mediaPaths(messages: InboundMessage[]): string[] {
  return messages
    .map((message) => message.mediaPath)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}
