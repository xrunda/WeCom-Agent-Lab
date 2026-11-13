/**
 * 顾问侧边栏 · 待回复索引（#146）。
 *
 * 侧边栏首屏回答的是「这个会话现在欠什么」：客户发了需要回应的话，
 * 但在内部员工回复之前，它就一直挂着。这里只做会话级的判定与状态，
 * 不碰草稿、不做推送、不写控制台。
 *
 * 判定先走规则，不调模型：漏一条等于没做，多一条顾问会关掉侧边栏。
 * 因此宁可多判一条，再用白名单收敛「好的 / 收到 / 谢谢」这类消息。
 *
 * 隐私：正文只进内存与持久化的待回复条目（顾问本来就在这个会话里），
 * 日志与审计只带 id 尾号，不带正文。
 */
import type { AuditEvent } from '../c2/types.ts';
import { newId } from './ids.ts';

export type ConvKind = 'group' | 'dm';

/** 会话键：群用 roomId；单聊没有 roomId，用 (员工, 外部成员) 组合 */
export function groupConvKey(roomId: string): string {
  return `room:${roomId}`;
}

export function dmConvKey(staffUserId: string, externalUserId: string): string {
  return `dm:${staffUserId}:${externalUserId}`;
}

export function convKindOf(key: string): ConvKind | undefined {
  if (key.startsWith('room:')) return 'group';
  if (key.startsWith('dm:')) return 'dm';
  return undefined;
}

export type SenderKind = 'external' | 'staff' | 'bot';

export interface SidebarMessageInput {
  msgid: string;
  convKey: string;
  kind: ConvKind;
  roomId?: string;
  senderId: string;
  /** 由接入层判定；不传时按 `wm` 前缀推断 */
  senderKind?: SenderKind;
  msgtype: string;
  text?: string;
  at: number;
}

export type PendingReason = 'question' | 'request' | 'mention' | 'ambiguous';

export type PendingStatus = 'open' | 'replied' | 'dismissed' | 'transferred';

export type PendingCloseReason = 'staff_reply' | 'manual' | 'transferred';

export interface PendingItem {
  id: string;
  convKey: string;
  kind: ConvKind;
  roomId?: string;
  customerId: string;
  firstAt: number;
  lastAt: number;
  messageCount: number;
  /** 最新一条原文，已截断 */
  excerpt: string;
  reason: PendingReason;
  status: PendingStatus;
  closedAt?: number;
  closedBy?: string;
  closedReason?: PendingCloseReason;
  /** 机器人 / 自建应用在该条目之后发过言：不算回复，只做提示 */
  botRepliedAt?: number;
}

export interface SidebarBackend {
  loadItems(): PendingItem[];
  putItem(item: PendingItem): Promise<void>;
  /** 已见消息 id + 时间，用于幂等；按保留期裁剪 */
  loadSeen(): Array<{ msgid: string; at: number }>;
  putSeen(msgid: string, at: number): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
}

export interface SidebarServiceOptions {
  backend: SidebarBackend;
  now?: () => number;
  /** 同一客户连续消息的合并窗口，默认 10 分钟 */
  mergeWindowMs?: number;
  /** 已见消息保留期，默认 7 天 */
  seenRetentionMs?: number;
  /** 已关闭条目的展示保留期，默认 7 天 */
  closedRetentionMs?: number;
  /** 机器人 / 自建应用的 userid；这些发言不算「顾问已回复」 */
  botUserIds?: string[];
  onAudit?: (event: AuditEvent) => void;
  onPersistError?: (error: Error) => void;
}

export interface ObserveResult {
  /** 新建或合并后的开放条目 */
  item?: PendingItem;
  /** 被内部员工回复而关闭的条目 */
  closed: PendingItem[];
}

const DEFAULT_MERGE_WINDOW_MS = 10 * 60_000;
const DEFAULT_SEEN_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_CLOSED_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** 原文截断长度；侧边栏只展示一行两行，保存全文没有意义 */
export const EXCERPT_MAX = 200;

/**
 * 寒暄白名单：客户只是应答，不需要单独建条目。
 * 只匹配「整句就是这些词」或「这些词开头且很短」，避免把
 * 「好的，那我明天还吃这个药吗」误杀。
 */
const ACK_WORDS =
  /^(好的?|好滴|好嘞|收到|收到啦|谢谢|谢谢你|谢谢您|辛苦了?|明白|了解|嗯+|哦+|行|可以|没问题|OK|ok|好呢|知道了?)[。.!！~～]*$/;
const ACK_PREFIX =
  /^(好的?|好滴|好嘞|收到|收到啦|谢谢|谢谢你|谢谢您|辛苦了?|明白|了解|嗯+|哦+|行|可以|没问题|OK|ok|好呢|知道了?)[，,。.！!~～\s]/;

const QUESTION_WORDS =
  /(吗|么|呢|什么|啥|怎么|怎样|如何|为什么|为啥|哪|几点|多少|多久|几天|能不能|可不可以|可以吗|要不要|是不是|有没有|怎么办|咋办)/;

const REQUEST_WORDS = /(帮我|麻烦|请|问一下|咨询|想问|想问下|看一下|确认一下)/;

const MENTION = /@/;

/** 文本是否需要回应；返回分类，不需要时返回 undefined */
export function replyExpectation(text: string | undefined, msgtype: string): PendingReason | undefined {
  const value = (text ?? '').trim();
  if (value === '') return undefined;
  // 图片没有文本可判；语音若已转写则按文本判，未转写时由 UI 提示，不建档
  if (msgtype === 'image') return undefined;

  if (ACK_WORDS.test(value)) return undefined;
  if (ACK_PREFIX.test(value) && value.length <= 10) return undefined;

  if (MENTION.test(value)) return 'mention';
  if (/[?？]/.test(value)) return 'question';
  if (QUESTION_WORDS.test(value)) return 'question';
  if (REQUEST_WORDS.test(value)) return 'request';
  // 没有疑问词但有一定长度的陈述，可能是需要回应的信息（如「我今天头晕」）
  if (value.length >= 5) return 'ambiguous';
  return undefined;
}

export function trimExcerpt(text: string | undefined): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > EXCERPT_MAX ? `${value.slice(0, EXCERPT_MAX)}…` : value;
}

function tailId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 2)}…${id.slice(-6)}`;
}

export class SidebarService {
  private readonly backend: SidebarBackend;
  private readonly now: () => number;
  private readonly mergeWindowMs: number;
  private readonly seenRetentionMs: number;
  private readonly closedRetentionMs: number;
  private readonly botUserIds: Set<string>;
  private readonly onAudit?: (event: AuditEvent) => void;
  private readonly onPersistError?: (error: Error) => void;

  private items = new Map<string, PendingItem>();
  private seen = new Map<string, number>();
  private writes: Promise<void>[] = [];

  constructor(options: SidebarServiceOptions) {
    this.backend = options.backend;
    this.now = options.now ?? (() => Date.now());
    this.mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
    this.seenRetentionMs = options.seenRetentionMs ?? DEFAULT_SEEN_RETENTION_MS;
    this.closedRetentionMs = options.closedRetentionMs ?? DEFAULT_CLOSED_RETENTION_MS;
    this.botUserIds = new Set(options.botUserIds ?? []);
    this.onAudit = options.onAudit;
    this.onPersistError = options.onPersistError;

    for (const item of this.backend.loadItems()) this.items.set(item.id, item);
    for (const entry of this.backend.loadSeen()) this.seen.set(entry.msgid, entry.at);
    this.prune(this.now());
  }

  /** 进入一条存档消息；返回本次产生的变化，便于埋点与测试 */
  observe(input: SidebarMessageInput): ObserveResult {
    if (this.seen.has(input.msgid)) return { closed: [] };
    this.seen.set(input.msgid, input.at);
    this.write(this.backend.putSeen(input.msgid, input.at));

    const senderKind = input.senderKind ?? this.classify(input.senderId);

    if (senderKind === 'external') {
      const reason = replyExpectation(input.text, input.msgtype);
      if (!reason) return { closed: [] };
      const item = this.upsertExternal(input, reason);
      return { item, closed: [] };
    }

    if (senderKind === 'bot') {
      const touched = this.markBotReplied(input);
      return { closed: [], ...(touched.length > 0 ? { item: touched[0] } : {}) };
    }

    return { closed: this.closeByStaff(input) };
  }

  /** 某个会话的开放条目，等待最久的在前 */
  openItems(convKey: string): PendingItem[] {
    return [...this.items.values()]
      .filter((item) => item.convKey === convKey && item.status === 'open')
      .sort((a, b) => a.lastAt - b.lastAt);
  }

  /** 最近关闭的条目，新的在前 */
  recentlyClosed(convKey: string, limit = 5): PendingItem[] {
    return [...this.items.values()]
      .filter((item) => item.convKey === convKey && item.status !== 'open')
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, limit);
  }

  get(id: string): PendingItem | undefined {
    return this.items.get(id);
  }

  /** 顾问手动关闭：已处理 / 无需回复 / 转交 */
  close(id: string, reason: 'dismissed' | 'transferred', actor: string): PendingItem | undefined {
    const item = this.items.get(id);
    if (!item || item.status !== 'open') return undefined;
    const at = this.now();
    item.status = reason;
    item.closedAt = at;
    item.closedBy = actor;
    item.closedReason = reason === 'transferred' ? 'transferred' : 'manual';
    this.persist(item);
    this.audit({
      at,
      actor,
      action: 'sidebar.pending.close',
      target: item.id,
      result: `${reason} ${tailId(item.convKey)}`,
    });
    return item;
  }

  allItems(): PendingItem[] {
    return [...this.items.values()];
  }

  async flush(): Promise<void> {
    while (this.writes.length > 0) {
      const pending = this.writes;
      this.writes = [];
      await Promise.all(pending);
    }
  }

  /** 裁剪已见消息与过期关闭条目；开放条目永不裁剪 */
  prune(now = this.now()): void {
    const seenBefore = now - this.seenRetentionMs;
    for (const [msgid, at] of this.seen) {
      if (at < seenBefore) this.seen.delete(msgid);
    }
    const closedBefore = now - this.closedRetentionMs;
    for (const [id, item] of this.items) {
      if (item.status !== 'open' && (item.closedAt ?? 0) < closedBefore) {
        this.items.delete(id);
      }
    }
  }

  private classify(senderId: string): SenderKind {
    if (this.botUserIds.has(senderId)) return 'bot';
    return senderId.startsWith('wm') ? 'external' : 'staff';
  }

  private upsertExternal(input: SidebarMessageInput, reason: PendingReason): PendingItem {
    const existing = [...this.items.values()].find(
      (item) =>
        item.convKey === input.convKey &&
        item.customerId === input.senderId &&
        item.status === 'open' &&
        input.at - item.lastAt <= this.mergeWindowMs,
    );

    if (existing) {
      existing.lastAt = Math.max(existing.lastAt, input.at);
      existing.messageCount += 1;
      existing.excerpt = trimExcerpt(input.text);
      // 疑问优先于模糊陈述，便于 UI 排序与提示
      if (reason === 'question' || reason === 'request' || reason === 'mention') {
        existing.reason = reason;
      }
      this.persist(existing);
      return existing;
    }

    const item: PendingItem = {
      id: newId('pend', input.at),
      convKey: input.convKey,
      kind: input.kind,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      customerId: input.senderId,
      firstAt: input.at,
      lastAt: input.at,
      messageCount: 1,
      excerpt: trimExcerpt(input.text),
      reason,
      status: 'open',
    };
    this.items.set(item.id, item);
    this.persist(item);
    return item;
  }

  /** 内部员工回复：关闭该会话里更早的开放条目 */
  private closeByStaff(input: SidebarMessageInput): PendingItem[] {
    const closed: PendingItem[] = [];
    for (const item of this.items.values()) {
      if (
        item.convKey === input.convKey &&
        item.status === 'open' &&
        item.lastAt <= input.at
      ) {
        item.status = 'replied';
        item.closedAt = input.at;
        item.closedBy = input.senderId;
        item.closedReason = 'staff_reply';
        this.persist(item);
        closed.push(item);
      }
    }
    return closed;
  }

  /** 机器人发言只做提示，不关闭条目 */
  private markBotReplied(input: SidebarMessageInput): PendingItem[] {
    const touched: PendingItem[] = [];
    for (const item of this.items.values()) {
      if (
        item.convKey === input.convKey &&
        item.status === 'open' &&
        item.lastAt <= input.at &&
        (item.botRepliedAt ?? 0) < input.at
      ) {
        item.botRepliedAt = input.at;
        this.persist(item);
        touched.push(item);
      }
    }
    return touched;
  }

  private persist(item: PendingItem): void {
    this.write(this.backend.putItem(item));
  }

  private write(promise: Promise<void>): void {
    this.writes.push(
      promise.catch((error: unknown) => {
        this.onPersistError?.(error instanceof Error ? error : new Error(String(error)));
      }),
    );
  }

  private audit(event: AuditEvent): void {
    this.write(this.backend.appendAudit(event));
    this.onAudit?.(event);
  }
}

/** zhiban-wecom 只依赖这个结构化接口，不反向依赖插件 */
export interface SidebarSink {
  observe(input: SidebarMessageInput): unknown;
}
