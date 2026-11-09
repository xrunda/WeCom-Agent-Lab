/**
 * 存档触发：从会话存档里发现「客户在群里发的消息」，交给上层生成草稿。
 *
 * 为什么从这里出发：官方机器人进不了外部客户群（M1 结论），
 * 客户消息唯一的入口就是会话存档。
 *
 * 本模块只做窗口过滤、去重、调用 compose；不直接依赖 C2Service，
 * 也不负责推送——这样离线测试可以只测「该不该生成草稿」。
 */
import type { ArchivePort, Clock, Store } from './ports.ts';
import { describeMessageMeta } from './redact.ts';
import type { ArchivedInbound, CustomerGroup, RiskLevel } from './types.ts';

export interface ComposeInput {
  group: CustomerGroup;
  message: ArchivedInbound;
}

/** compose 的产出：只描述「该回什么」，不涉及草稿 id 与队列 */
export interface ComposedDraft {
  /** 要发给客户的正文 */
  body: string;
  /** 卡片上的客户原话摘要；缺省用客户原文前 40 字 */
  inboundSummary?: string;
  /** 客户称呼；缺省用发送者 id 后 6 位 */
  customerName?: string;
  riskLevel?: RiskLevel;
}

export type ComposeFn = (input: ComposeInput) => ComposedDraft | undefined;

export interface ArchiveTriggerConfig {
  /** 只处理这些群 */
  roomIds: string[];
  /** 员工本人 userid，用于排除他自己发的消息 */
  excludeSender: string;
  /** 只处理 msgtime >= 该时刻的消息；缺省取构造时刻，避免重放历史 */
  startedAt?: number;
  /** #54：把图片消息也交给 compose（需适配器启用媒体下载） */
  includeMedia?: boolean;
  /** 去重集合上限 */
  seenLimit?: number;
}

export interface TriggerEvent {
  group: CustomerGroup;
  message: ArchivedInbound;
  draft: ComposedDraft;
}

/** #63：外部发言触发回合；内部员工发言只作上下文 */
export interface TriggerPollResult {
  events: TriggerEvent[];
  internal: ArchivedInbound[];
  /** 本轮观察到的群与外部成员，供 zhiban-patient 自动发现 */
  rooms: Array<{
    roomId: string;
    members: Array<{ id: string; isExternal: boolean; lastActiveAt: number }>;
  }>;
}

export interface ArchiveTriggerDeps {
  archive: ArchivePort;
  store: Store;
  clock: Clock;
  compose: ComposeFn;
  config: ArchiveTriggerConfig;
  logger?: (line: string) => void;
}

export class ArchiveTrigger {
  private readonly archive: ArchivePort;
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly compose: ComposeFn;
  private readonly config: ArchiveTriggerConfig;
  private readonly logger?: (line: string) => void;

  private readonly startedAt: number;
  private readonly seen = new Set<string>();

  constructor(deps: ArchiveTriggerDeps) {
    this.archive = deps.archive;
    this.store = deps.store;
    this.clock = deps.clock;
    this.compose = deps.compose;
    this.config = deps.config;
    this.logger = deps.logger;
    this.startedAt = deps.config.startedAt ?? deps.clock.now();
  }

  /**
   * 拉一次存档，返回本次新出现的、可以生成草稿的客户消息。
   * 同一条 msgid 只会返回一次（进程内去重）。
   */
  async poll(): Promise<TriggerEvent[]> {
    return (await this.pollWithContext()).events;
  }

  /**
   * #63：一次拉取同时返回外部发言（触发草稿）与内部员工发言（只作上下文）。
   * 存档端口没有 listGroupMessages 时退化为原行为（无内部上下文、无群发现）。
   */
  async pollWithContext(): Promise<TriggerPollResult> {
    const now = this.clock.now();
    const list = this.archive.listGroupMessages;
    const messages = list
      ? await list.call(this.archive, {
          roomIds: this.config.roomIds,
          since: this.startedAt,
          until: now,
          includeMedia: this.config.includeMedia === true,
        })
      : await this.archive.listInboundMessages({
          roomIds: this.config.roomIds,
          excludeSender: this.config.excludeSender,
          since: this.startedAt,
          until: now,
          includeMedia: this.config.includeMedia === true,
        });
    messages.sort((a, b) => a.msgtime - b.msgtime);
    this.log(`轮询完成：候选 ${messages.length} 条`);

    const events: TriggerEvent[] = [];
    const internal: ArchivedInbound[] = [];
    const roomMembers = new Map<string, Map<string, { id: string; isExternal: boolean; lastActiveAt: number }>>();

    for (const message of messages) {
      if (this.seen.has(message.msgid)) continue;
      this.seen.add(message.msgid);

      const group = this.store.getGroup(message.roomid);
      if (!group || group.status !== 'mapped') {
        this.log(`跳过 ${describeMessageMeta({ ...message, msgtype: 'text' })}：群未绑定`);
        continue;
      }

      const isExternal = message.from.startsWith('wm');
      const members =
        roomMembers.get(message.roomid) ??
        new Map<string, { id: string; isExternal: boolean; lastActiveAt: number }>();
      members.set(message.from, {
        id: message.from,
        isExternal,
        lastActiveAt: message.msgtime,
      });
      roomMembers.set(message.roomid, members);

      if (!isExternal) {
        // 内部员工（顾问/同事）的发言：只进上下文，不触发回合
        internal.push(message);
        continue;
      }
      if (message.from === this.config.excludeSender) continue;

      const draft = this.compose({ group, message });
      if (!draft) {
        this.log(`跳过 ${describeMessageMeta({ ...message, msgtype: 'text' })}：原文为空，compose 返回空`);
        continue;
      }

      events.push({ group, message, draft });
      this.log(`命中客户消息 ${describeMessageMeta({ ...message, msgtype: 'text' })}`);
    }

    this.trimSeen();
    return {
      events,
      internal,
      rooms: [...roomMembers].map(([roomId, members]) => ({ roomId, members: [...members.values()] })),
    };
  }

  private trimSeen(): void {
    const limit = this.config.seenLimit ?? 2000;
    if (this.seen.size <= limit) return;
    let drop = this.seen.size - limit;
    for (const msgid of this.seen) {
      if (drop <= 0) break;
      this.seen.delete(msgid);
      drop -= 1;
    }
  }

  private log(line: string): void {
    this.logger?.(line);
  }
}
