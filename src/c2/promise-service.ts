/**
 * #160 承诺追踪服务：抽取入账、到期提醒、关闭与顺延。
 *
 * 只发顾问本人 1:1，不进客户群（F1）。
 * 每条承诺只提醒一次；「稍后提醒」最多顺延 2 次（每次 +1 天）。
 * 日志只记 promiseId、群尾号与状态，不记原话。
 */
import { buildPromiseCard } from './message.ts';
import {
  extractPromises,
  formatDueAt,
  promiseId,
  shanghaiDayStart,
} from './promises.ts';
import type { PromiseRecord } from './promises.ts';
import type { BotPort, Clock } from './ports.ts';
import type { Draft } from './types.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface PromiseServiceConfig {
  /** 每日扫描时段（东八区小时），默认 09:00；队列 tick 会按分钟粒度调用 */
  reminderHour?: number;
  /** 「稍后提醒」最多顺延次数，默认 2 */
  maxSnoozes?: number;
  /** 单张卡片最多列几条，默认 3 */
  maxPerCard?: number;
}

export interface PromiseServiceDeps {
  store: {
    listPromises(): PromiseRecord[];
    getPromise(id: string): PromiseRecord | undefined;
    savePromise(record: PromiseRecord): void;
  };
  bot: BotPort;
  clock: Clock;
  /** 顾问 id → 与机器人的 1:1 chatId；缺省时把 advisorId 当 chatId（测试） */
  chatIdFor?: (advisorId: string) => string | undefined;
  config?: PromiseServiceConfig;
  logger?: (line: string) => void;
}

export interface PromiseIngestInput {
  advisorId: string;
  roomId: string;
  groupName: string;
  customerId?: string;
  customerName?: string;
  text: string;
  msgId: string;
  at: number;
}

export type PromiseAction = 'done' | 'later' | 'false';

export interface PromiseResolution {
  action: PromiseAction;
  closed: PromiseRecord[];
  snoozed: PromiseRecord[];
}

export const DEFAULT_PROMISE_CONFIG: Required<PromiseServiceConfig> = {
  reminderHour: 9,
  maxSnoozes: 2,
  maxPerCard: 3,
};

function tail(value: string): string {
  return value.length <= 8 ? value : `…${value.slice(-6)}`;
}

export class PromiseService {
  private readonly store: PromiseServiceDeps['store'];
  private readonly bot: BotPort;
  private readonly clock: Clock;
  private readonly chatIdFor?: (advisorId: string) => string | undefined;
  private readonly config: Required<PromiseServiceConfig>;
  private readonly logger?: (line: string) => void;

  constructor(deps: PromiseServiceDeps) {
    this.store = deps.store;
    this.bot = deps.bot;
    this.clock = deps.clock;
    this.config = { ...DEFAULT_PROMISE_CONFIG, ...deps.config };
    this.chatIdFor = deps.chatIdFor;
    this.logger = deps.logger;
  }

  /** 从顾问自己发出的文本里抽承诺；按 msgid 幂等 */
  ingestText(input: PromiseIngestInput): PromiseRecord[] {
    const extracted = extractPromises(input.text, input.at);
    if (extracted.length === 0) return [];
    const saved: PromiseRecord[] = [];
    extracted.forEach((item, index) => {
      const id = promiseId(input.msgId, index);
      if (this.store.getPromise(id)) return;
      const record: PromiseRecord = {
        id,
        advisorId: input.advisorId,
        roomId: input.roomId,
        groupName: input.groupName,
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.customerName ? { customerName: input.customerName } : {}),
        excerpt: item.excerpt,
        dueAt: item.dueAt,
        dueLabel: item.dueLabel,
        sourceMsgId: input.msgId,
        status: 'pending',
        remindCount: 0,
        createdAt: input.at,
      };
      this.store.savePromise(record);
      saved.push(record);
      this.log(`新增承诺 ${record.id} room=${tail(record.roomId)} 到期=${item.dueLabel}`);
    });
    return saved;
  }

  /** 已确认发出的草稿，正文里的承诺按草稿 id 幂等 */
  ingestDraft(draft: Draft): PromiseRecord[] {
    if (!draft.body) return [];
    return this.ingestText({
      advisorId: draft.advisorId,
      roomId: draft.groupRoomId,
      groupName: draft.groupName,
      customerId: draft.customerId,
      customerName: draft.customerName,
      text: draft.body,
      msgId: `draft:${draft.id}:v${draft.version ?? 1}`,
      at: this.clock.now(),
    });
  }

  /**
   * 到期扫描：只处理已到点且从未提醒过的承诺。
   * 同一顾问同时到期时合并成一张卡片。
   */
  async dueScan(now = this.clock.now()): Promise<PromiseRecord[]> {
    const due = this.store
      .listPromises()
      .filter((item) => item.status === 'pending')
      .filter((item) => item.remindedAt === undefined)
      .filter((item) => item.dueAt <= now);
    if (due.length === 0) return [];

    const byAdvisor = new Map<string, PromiseRecord[]>();
    for (const item of due) {
      const list = byAdvisor.get(item.advisorId) ?? [];
      list.push(item);
      byAdvisor.set(item.advisorId, list);
    }

    const reminded: PromiseRecord[] = [];
    for (const [advisorId, items] of byAdvisor) {
      const chatId = this.chatIdFor ? this.chatIdFor(advisorId) : advisorId;
      if (!chatId) {
        // 未绑定 1:1 时保留待提醒状态，下一轮再试；不向任何群发送
        this.log(`承诺提醒跳过 advisor=…${advisorId.slice(-6)}：未绑定会话`);
        continue;
      }
      const sorted = items.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
      const shown = sorted.slice(0, this.config.maxPerCard);
      const card = buildPromiseCard(shown, sorted.length);
      try {
        await this.bot.sendCard(chatId, card);
      } catch (error) {
        this.log(
          `承诺提醒发送失败 advisor=${tail(advisorId)}：` +
            `${error instanceof Error ? error.message : 'UNKNOWN'}`,
        );
        continue;
      }
      for (const item of shown) {
        item.remindedAt = now;
        item.remindCount += 1;
        this.store.savePromise(item);
        reminded.push(item);
      }
      // 超出卡片容量的顺延到次日扫描，避免同一批到期连发多张卡片
      const overflowAt = shanghaiDayStart(now) + DAY_MS + this.config.reminderHour * 60 * MINUTE_MS;
      for (const item of sorted.slice(this.config.maxPerCard)) {
        item.dueAt = overflowAt;
        item.dueLabel = formatDueAt(overflowAt);
        this.store.savePromise(item);
      }
      this.log(`承诺提醒已发送 advisor=${tail(advisorId)} 条数=${shown.length}`);
    }
    return reminded;
  }

  /** 卡片按钮：promise:<id1,id2,...>:done|later|false */
  handleButtonKey(key: string): PromiseResolution | undefined {
    const match = /^promise:([^:]+):(done|later|false)$/.exec(key);
    if (!match) return undefined;
    const ids = match[1]!.split(',').filter((id) => id !== '');
    const action = match[2] as PromiseAction;
    const now = this.clock.now();
    const closed: PromiseRecord[] = [];
    const snoozed: PromiseRecord[] = [];

    for (const id of ids) {
      const record = this.store.getPromise(id);
      if (!record || record.status !== 'pending') continue;
      if (action === 'later') {
        // 首次提醒 + 最多 2 次顺延；第三次点「稍后提醒」不再推
        if (record.remindCount > this.config.maxSnoozes) continue;
        record.dueAt = now + DAY_MS;
        record.dueLabel = `第 ${record.remindCount} 次顺延 · ${formatDueAt(record.dueAt)}`;
        record.remindedAt = undefined;
        record.snoozedAt = now;
        this.store.savePromise(record);
        snoozed.push(record);
        this.log(`承诺顺延 ${record.id} 至 ${new Date(record.dueAt).toISOString()}`);
        continue;
      }
      record.status = action === 'done' ? 'done' : 'dismissed';
      record.closedAt = now;
      this.store.savePromise(record);
      closed.push(record);
      this.log(`承诺关闭 ${record.id} 方式=${action}`);
    }

    return { action, closed, snoozed };
  }

  /** 到期但没有任何可推送会话时的兜底：控制台可见（不在这里发） */
  pending(): PromiseRecord[] {
    return this.store.listPromises().filter((item) => item.status === 'pending');
  }

  private log(line: string): void {
    this.logger?.(line);
  }
}
