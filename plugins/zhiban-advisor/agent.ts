/**
 * zhiban-advisor 的回合编排（#167 §6 / §11）。
 *
 * 每条 1:1 文本：串行化（单顾问同时只有一轮）→ 全局并发上限 → 限流 →
 * 取会话 → 拼前置上下文 → prompt → session/event 捕获回复 → 拆条发送。
 * 超时先回「还在处理」，回合稍后完成时补发；失败走降级文案。
 * 本模块不落日志正文，只记 advisor 尾号、耗时与工具名。
 */
import { buildAdvisorTurnPrefix } from '../../src/p1/advisor/persona.ts';
import { buildTodoSnapshot, splitForWecom } from '../../src/p1/advisor/format.ts';
import type {
  AdvisorActiveDraftView,
  AdvisorGetResult,
  AdvisorHitItem,
  AdvisorSearchScope,
  AdvisorWecomDataPort,
  TodoSnapshot,
} from '../../src/p1/advisor/types.ts';
import { tailId } from '../../src/c2/redact.ts';
import type { AdvisorSessionPort, AdvisorTurnOutcome } from './sessions.ts';

/** 全局并发满时最多排队的时长 */
const CONCURRENCY_WAIT_MS = 5_000;

/** 超时后补发的固定前缀（§6） */
const LATE_PREFIX = '刚才那条查完了：';

/** 中断但已有部分结果的前缀 */
const INTERRUPTED_PREFIX = '刚才那条没跑完，先给你已经查到的：';

/** 降级文案（§8）：只保留仍在命令表里的动作，不列已退役的关键词 */
const DEGRADE_TEXT =
  '我这边暂时没接上模型，先把能确定的给你：\n' +
  '· 我的待办 —— 未完成草稿、今日承诺、未处理告警\n' +
  '稍后可以再问一次。';

const EMPTY_TEXT = '这次没查到能回答的内容，可以换个说法再问一次。';

export interface AdvisorAgentOptions {
  sessions: AdvisorSessionPort;
  data: AdvisorWecomDataPort;
  emit: (type: string, data: unknown) => void;
  logger?: (line: string) => void;
  now?: () => number;
  turnTimeoutMs?: number;
  maxConcurrentTurns?: number;
  messagesPerMinute?: number;
  messagesPerDay?: number;
  /** 全局并发满时最多排队的时长（测试可调短） */
  concurrencyWaitMs?: number;
}

/** 上一条列表：供「纯编号」确定性选择 */
export interface LastList {
  scope: AdvisorSearchScope;
  items: AdvisorHitItem[];
  at: number;
}

const LIST_TTL_MS = 30 * 60_000;

export class AdvisorAgent {
  private readonly sessions: AdvisorSessionPort;
  private readonly data: AdvisorWecomDataPort;
  private readonly emit: (type: string, data: unknown) => void;
  private readonly logger?: (line: string) => void;
  private readonly now: () => number;
  private readonly turnTimeoutMs: number;
  private readonly maxConcurrentTurns: number;
  private readonly messagesPerMinute: number;
  private readonly messagesPerDay: number;
  private readonly concurrencyWaitMs: number;

  /** 单顾问进行中的回合 */
  private readonly inflight = new Map<string, boolean>();
  /** 全局并发计数 */
  private activeTurns = 0;
  /** 分钟级限流桶 */
  private readonly minuteBuckets = new Map<string, { at: number; count: number }>();
  /** 日级限流桶 */
  private readonly dayBuckets = new Map<string, { at: number; count: number }>();
  /** 顾问 → 上一条列表（工具写入，纯编号选择读取） */
  private readonly lastLists = new Map<string, LastList>();
  /** 顾问 → 本轮待补发的餐食原图（服务端路径 + 发送前的标注，只在插件内部传递） */
  private readonly pendingMedia = new Map<string, Array<{ path: string; label: string }>>();

  constructor(options: AdvisorAgentOptions) {
    this.sessions = options.sessions;
    this.data = options.data;
    this.emit = options.emit;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30_000;
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 2;
    this.messagesPerMinute = options.messagesPerMinute ?? 20;
    this.messagesPerDay = options.messagesPerDay ?? 500;
    this.concurrencyWaitMs = options.concurrencyWaitMs ?? CONCURRENCY_WAIT_MS;
  }

  /** 工具执行时写入上一条列表，供纯编号选择复用 */
  recordList(advisorId: string, scope: AdvisorSearchScope, items: AdvisorHitItem[]): void {
    if (items.length === 0) return;
    this.lastLists.set(advisorId, { scope, items, at: this.now() });
    if (this.lastLists.size > 2000) {
      const oldest = this.lastLists.keys().next().value;
      if (oldest !== undefined) this.lastLists.delete(oldest);
    }
  }

  /**
   * 记录本轮要补发的餐食原图，每张带发送前的标注文字（日期 + 餐次 + 时间）。
   * 只保留前 3 张，避免一次刷屏；路径与标注只在插件内部传递，不进入工具结果与日志。
   * 只有顾问明确要看某餐照片（调 patient_meal_photo）时才记录，绝不主动附图。
   */
  recordMealMedia(
    advisorId: string,
    items: Array<{ path: string; label: string }>,
  ): void {
    const kept = items.filter((item) => item.path.trim() !== '').slice(0, 3);
    if (kept.length === 0) return;
    this.pendingMedia.set(advisorId, kept);
  }

  lastList(advisorId: string): LastList | undefined {
    const list = this.lastLists.get(advisorId);
    if (!list) return undefined;
    if (this.now() - list.at > LIST_TTL_MS) {
      this.lastLists.delete(advisorId);
      return undefined;
    }
    return list;
  }

  /** 顾问当前的活动草稿元数据；无则为 undefined */
  activeDraft(advisorId: string): AdvisorActiveDraftView | undefined {
    return this.data.activeDraftFor(advisorId);
  }

  /** 待办快照：命令与工具共用的同一份数据 */
  snapshot(advisorId: string, now = this.now()): TodoSnapshot {
    return buildTodoSnapshot({
      drafts: this.data.draftsFor(advisorId),
      promises: this.data.promisesFor(advisorId),
      alerts: this.data.alertsFor(advisorId),
      pendingReplies: this.data.pendingRepliesFor?.(advisorId),
      now,
    });
  }

  /**
   * 一条 1:1 文本。fire-and-forget：所有失败都在内部降级，不向上抛。
   * @returns 是否真的发起了回合（false = 被限流 / 串行 / 并发满）
   */
  async handle(advisorId: string, text: string): Promise<boolean> {
    const started = this.now();
    const log = (line: string): void => this.logger?.(line);

    if (this.inflight.has(advisorId)) {
      void this.send(advisorId, '上一条还在处理，稍等一下。');
      return false;
    }
    const limited = this.checkRate(advisorId);
    if (limited !== undefined) {
      void this.send(advisorId, limited);
      return false;
    }

    // 全局并发满：排队一小段（真实时钟截止，不受业务时钟影响），仍满则提示稍后
    const deadline = Date.now() + this.concurrencyWaitMs;
    while (this.activeTurns >= this.maxConcurrentTurns) {
      if (Date.now() >= deadline) {
        void this.send(advisorId, '现在比较忙，请稍后再问。');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    this.inflight.set(advisorId, true);
    this.activeTurns += 1;
    // 新回合开始：上一轮没发完的图片不再补，避免串到这一轮
    this.pendingMedia.delete(advisorId);
    try {
      return await this.runTurn(advisorId, text, started);
    } finally {
      this.activeTurns -= 1;
      this.inflight.delete(advisorId);
    }
  }

  private async runTurn(advisorId: string, text: string, started: number): Promise<boolean> {
    const log = (line: string): void => this.logger?.(line);

    let record;
    try {
      record = await this.sessions.ensure(advisorId);
    } catch (error) {
      log(`顾问会话创建失败 advisor=${tailId(advisorId)}：${error instanceof Error ? error.message : 'UNKNOWN'}`);
      await this.send(advisorId, '我这边还没准备好，请稍后再试。');
      return false;
    }

    const now = this.now();
    const snapshot = this.snapshot(advisorId, now);
    const active = this.activeDraft(advisorId);
    const turnPrompt =
      buildAdvisorTurnPrefix({
        advisorName: this.data.advisorName(advisorId),
        advisorId,
        now,
        snapshot,
        activeDraft: active,
      }) + text;

    this.emit('advisor.turn.started', {
      advisorId: tailId(advisorId),
      sessionId: record.sessionId,
    });

    const outcome = await this.sessions.runTurn({
      sessionId: record.sessionId,
      prompt: turnPrompt,
      timeoutMs: this.turnTimeoutMs,
      onLateComplete: (lateText) => {
        // 超时但后来完成：补发，前缀固定
        void this.send(advisorId, `${LATE_PREFIX}${lateText}`).then((delivered) => {
          this.emit('advisor.turn.late', {
            advisorId: tailId(advisorId),
            delivered,
            durationMs: this.now() - started,
          });
        });
      },
    });

    await this.sendOutcome(advisorId, outcome, started);
    return true;
  }

  private async sendOutcome(
    advisorId: string,
    outcome: AdvisorTurnOutcome,
    started: number,
  ): Promise<void> {
    const durationMs = this.now() - started;
    if (outcome.status === 'completed' && outcome.text !== undefined) {
      this.emit('advisor.turn.completed', {
        advisorId: tailId(advisorId),
        durationMs,
        chars: outcome.text.length,
      });
      await this.send(advisorId, outcome.text);
      await this.flushMedia(advisorId);
      return;
    }
    if (outcome.status === 'interrupted' && outcome.text !== undefined) {
      this.emit('advisor.turn.interrupted', { advisorId: tailId(advisorId), durationMs });
      await this.send(advisorId, `${INTERRUPTED_PREFIX}${outcome.text}`);
      await this.flushMedia(advisorId);
      return;
    }
    if (outcome.status === 'timeout') {
      this.emit('advisor.turn.timeout', { advisorId: tailId(advisorId), durationMs });
      await this.send(advisorId, '这个问题要久一点，我查完直接发你。');
      return;
    }
    this.emit('advisor.turn.failed', {
      advisorId: tailId(advisorId),
      status: outcome.status,
      durationMs,
    });
    await this.send(advisorId, outcome.status === 'empty' ? EMPTY_TEXT : DEGRADE_TEXT);
  }

  /**
   * 补发本轮餐食原图：每张先发一条标注文字（【日期 · 餐次 · 时间】），再发原图。
   * 标注发送失败就不发这张图，避免出现「没有标注的原图」误导顾问。
   * 单张失败（超 2MB / 非 JPG·PNG / 读取失败）只跳过，不影响文字回复；
   * 路径不进日志，只记张数与失败数。
   */
  private async flushMedia(advisorId: string): Promise<void> {
    const items = this.pendingMedia.get(advisorId);
    if (!items || items.length === 0) return;
    this.pendingMedia.delete(advisorId);
    if (!this.data.sendImage) {
      this.logger?.(`顾问回复图片未发送：数据端口不支持发图 advisor=${tailId(advisorId)}`);
      return;
    }
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      if (item.label === '') continue;
      const labeled = await this.send(advisorId, `【${item.label}】`);
      if (!labeled) {
        failed += 1;
        continue;
      }
      try {
        if (await this.data.sendImage(advisorId, item.path)) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    this.emit('advisor.media.sent', { advisorId: tailId(advisorId), sent, failed });
    if (failed > 0) {
      this.logger?.(`顾问回复图片部分失败 advisor=${tailId(advisorId)} sent=${sent} failed=${failed}`);
    }
  }

  /** 拆条发送（≤2000 字节/条）；失败只记日志，不向上抛 */
  private async send(advisorId: string, text: string): Promise<boolean> {
    try {
      for (const chunk of splitForWecom(text)) {
        const delivered = await this.data.sendText(advisorId, chunk);
        if (!delivered) {
          this.emit('advisor.send.failed', { advisorId: tailId(advisorId) });
          return false;
        }
      }
      return true;
    } catch (error) {
      this.logger?.(
        `顾问回复发送失败 advisor=${tailId(advisorId)}：${error instanceof Error ? error.message : 'UNKNOWN'}`,
      );
      return false;
    }
  }

  /** 返回限流提示文案；未触发返回 undefined */
  private checkRate(advisorId: string): string | undefined {
    const now = this.now();
    const day = this.tick(this.dayBuckets, advisorId, now, 24 * 60 * 60_000);
    if (day.count > this.messagesPerDay) return '今天的用量已用完，明天再试。';
    const minute = this.tick(this.minuteBuckets, advisorId, now, 60_000);
    if (minute.count > this.messagesPerMinute) {
      const nextWindow = minute.at + 60_000;
      return `请求太频繁，请 ${Math.max(1, Math.ceil((nextWindow - now) / 1000))} 秒后再试。`;
    }
    return undefined;
  }

  private tick(
    buckets: Map<string, { at: number; count: number }>,
    advisorId: string,
    now: number,
    windowMs: number,
  ): { at: number; count: number } {
    const bucket = buckets.get(advisorId);
    if (!bucket || now - bucket.at >= windowMs) {
      const next = { at: now, count: 1 };
      buckets.set(advisorId, next);
      if (buckets.size > 2000) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      return next;
    }
    bucket.count += 1;
    return bucket;
  }
}
