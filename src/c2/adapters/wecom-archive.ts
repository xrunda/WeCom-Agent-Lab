/**
 * 真实 ArchivePort：调用 C++ 工具 archive_dump 拉取会话存档并解密。
 *
 * 链路：GetChatData（密文） → RSA 解 encrypt_random_key → DecryptData → 明文 JSON
 * 工具输出 --json：{"nextSeq":23,"count":2,"messages":[{...},{...}]}
 *
 * 设计要点：
 * - 只维护一个 seq 游标，按增量拉取，不重复解密历史。
 * - 每次 poll 最多拉 maxBatchesPerPoll 批，避免一次吃满。
 * - 内存缓存最近 cacheLimit 条，供 Verifier 按时间窗过滤。
 */
import { execFile } from 'node:child_process';

import type { ArchivePort } from '../ports.ts';
import { describeMessageMeta, tailId } from '../redact.ts';
import type { ArchivedInbound, SentMessage } from '../types.ts';

/** 存档解出来的消息（只声明 C2 用到的字段，其余透传） */
export interface ArchiveRecord {
  msgid: string;
  /** send = 企业成员发出，recv = 收到的 */
  action?: 'send' | 'recv';
  from: string;
  tolist?: string[];
  /** 群聊有值（wr 前缀），单聊为空串 */
  roomid?: string;
  /** 毫秒时间戳 */
  msgtime: number;
  msgtype: string;
  text?: { content: string };
  [key: string]: unknown;
}

export interface WeComArchiveConfig {
  /** archive_dump 可执行文件路径 */
  binaryPath: string;
  /** 消息加密私钥（PEM） */
  privateKeyPath: string;
  /** corpid + secret 的配置文件；每行一个 */
  configPath: string;
  /** 单批拉取条数，官方上限 1000 */
  batchSize?: number;
  /** 一次 poll 最多拉几批 */
  maxBatchesPerPoll?: number;
  /** 缓存上限 */
  cacheLimit?: number;
  /** 子进程超时 */
  timeoutMs?: number;
  /** 起始 seq；线上应从持久化存储恢复 */
  initialSeq?: number;
  /**
   * 服务群判定；默认全部视为非服务群，正文不落缓存、不进日志。
   * 真实判定（外部成员）由 #33 注入。
   */
  isServiceGroup?: (roomId: string) => boolean;
  logger?: (message: string) => void;
  /** 测试注入：返回 archive_dump 的 stdout */
  run?: (args: string[]) => Promise<string>;
}

export interface ArchiveDumpOutput {
  nextSeq: number;
  count?: number;
  messages: ArchiveRecord[];
}

/** 首个不同的位置与码点：抓肉眼看不见的形近字符 */
function firstDiff(a: string, b: string): string {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) {
      return (
        `第 ${i + 1} 位 U+${a.charCodeAt(i).toString(16).toUpperCase()}` +
        ` vs U+${b.charCodeAt(i).toString(16).toUpperCase()}`
      );
    }
  }
  if (a.length !== b.length) return `长度 ${a.length} vs ${b.length}`;
  return '码点相同（比较结果却不等，请检查代理对）';
}

/** 一条记录的关键元数据，用来判断它为什么没触发草稿；不含正文 */
export function describeRecord(record: ArchiveRecord): string {
  return describeMessageMeta(record);
}

export const DEFAULT_ARCHIVE_CONFIG = {
  batchSize: 100,
  maxBatchesPerPoll: 5,
  cacheLimit: 2000,
  timeoutMs: 30_000,
};

export class WeComArchiveAdapter implements ArchivePort {
  private readonly config: WeComArchiveConfig;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly cacheLimit: number;
  private readonly run: (args: string[]) => Promise<string>;
  private readonly isServiceGroup: (roomId: string) => boolean;

  private seq: number;
  private cache: ArchiveRecord[] = [];
  private known = new Set<string>();
  /** 本轮 pull 中只计数、未落正文的记录数 */
  private nonServiceCount = 0;

  constructor(config: WeComArchiveConfig) {
    this.config = config;
    this.batchSize = config.batchSize ?? DEFAULT_ARCHIVE_CONFIG.batchSize;
    this.maxBatches = config.maxBatchesPerPoll ?? DEFAULT_ARCHIVE_CONFIG.maxBatchesPerPoll;
    this.cacheLimit = config.cacheLimit ?? DEFAULT_ARCHIVE_CONFIG.cacheLimit;
    this.isServiceGroup = config.isServiceGroup ?? (() => false);
    this.seq = config.initialSeq ?? 0;
    this.run = config.run ?? ((args) => this.exec(args));
  }

  /** 当前游标，持久化后可在重启时恢复 */
  getSeq(): number {
    return this.seq;
  }

  setSeq(seq: number): void {
    this.seq = seq;
    this.cache = [];
    this.known.clear();
  }

  /** 拉取增量并写入缓存；失败时抛错，由调用方决定退避 */
  async pull(): Promise<number> {
    let added = 0;
    this.nonServiceCount = 0;
    for (let i = 0; i < this.maxBatches; i += 1) {
      const before = this.seq;
      const out = await this.fetch(this.seq);
      added += this.remember(out.messages);
      this.seq = Math.max(this.seq, out.nextSeq);

      if (out.messages.length < this.batchSize) break;
      if (this.seq === before) break;
    }
    if (added > 0) {
      const nonService = this.nonServiceCount > 0 ? `（非服务群 ${this.nonServiceCount} 条仅计数）` : '';
      this.log(`存档拉入 ${added} 条${nonService}，seq=${this.seq}`);
    }
    return added;
  }

  async listSentMessages(params: {
    fromUser: string;
    since: number;
    until: number;
  }): Promise<SentMessage[]> {
    await this.pull();

    return this.cache
      .filter(
        (r) =>
          this.isServiceGroup(r.roomid ?? '') &&
          r.action === 'send' &&
          r.msgtype === 'text' &&
          r.from === params.fromUser &&
          r.msgtime >= params.since &&
          r.msgtime <= params.until,
      )
      .map((r) => ({
        msgid: r.msgid,
        roomid: r.roomid ?? '',
        from: r.from,
        text: r.text?.content ?? '',
        msgtime: r.msgtime,
      }));
  }

  async listInboundMessages(params: {
    roomIds: string[];
    excludeSender: string;
    since: number;
    until: number;
  }): Promise<ArchivedInbound[]> {
    await this.pull();

    const rooms = new Set(params.roomIds);
    const result: ArchivedInbound[] = [];
    // 近 2 分钟内的记录才打「未采纳」原因，避免历史记录刷屏
    const debugFloor = params.since - 120_000;
    const reject = (record: ArchiveRecord, reason: string) => {
      if (record.msgtime >= debugFloor) this.log(`  未采纳 msgid=${tailId(record.msgid)}：${reason}`);
    };
    for (const record of this.cache) {
      const roomid = record.roomid ?? '';
      if (!this.isServiceGroup(roomid)) {
        reject(record, '非服务群');
        continue;
      }
      if (record.msgtype !== 'text') {
        reject(record, `msgtype=${record.msgtype}`);
        continue;
      }
      if (roomid === '' || !rooms.has(roomid)) {
        const expected = params.roomIds[0];
        const detail =
          params.roomIds.length === 1 && expected
            ? `；与配置对比 ${firstDiff(roomid, expected)}`
            : '';
        reject(record, `群不符 room=${tailId(roomid)}${detail}`);
        continue;
      }
      if (record.from === params.excludeSender) {
        reject(record, '发送者是员工本人');
        continue;
      }
      if (record.msgtime < params.since) {
        reject(record, `早于起始时刻 ${params.since - record.msgtime}ms`);
        continue;
      }
      if (record.msgtime > params.until) {
        reject(record, `晚于本轮轮询时刻 ${record.msgtime - params.until}ms`);
        continue;
      }
      result.push({
        msgid: record.msgid,
        roomid,
        from: record.from,
        text: record.text?.content ?? '',
        msgtime: record.msgtime,
        action: record.action,
      });
    }
    return result;
  }

  /** 缓存里的全部消息，调试用 */
  listCached(): ArchiveRecord[] {
    return [...this.cache];
  }

  private async fetch(seq: number): Promise<ArchiveDumpOutput> {
    const stdout = await this.run([
      '--json',
      String(seq),
      String(this.batchSize),
      this.config.privateKeyPath,
      this.config.configPath,
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (err) {
      throw new Error(`ARCHIVE_BAD_OUTPUT ${(err as Error).message}`);
    }

    const out = parsed as Partial<ArchiveDumpOutput>;
    return {
      nextSeq: typeof out.nextSeq === 'number' ? out.nextSeq : seq,
      count: out.count,
      messages: Array.isArray(out.messages) ? (out.messages as ArchiveRecord[]) : [],
    };
  }

  private remember(messages: ArchiveRecord[]): number {
    let added = 0;
    for (const message of messages) {
      if (!message?.msgid || this.known.has(message.msgid)) continue;
      this.known.add(message.msgid);
      const service = this.isServiceGroup(message.roomid ?? '');
      // 非服务群的正文不写入任何存储：缓存里只留元数据，正文置空
      this.cache.push(service ? message : { ...message, text: undefined });
      added += 1;
      if (service) {
        this.log(`  记录 ${describeRecord(message)}`);
      } else {
        this.nonServiceCount += 1;
      }
    }
    if (this.cache.length > this.cacheLimit) {
      const dropped = this.cache.splice(0, this.cache.length - this.cacheLimit);
      for (const item of dropped) this.known.delete(item.msgid);
    }
    return added;
  }

  private exec(args: string[]): Promise<string> {
    const timeout = this.config.timeoutMs ?? DEFAULT_ARCHIVE_CONFIG.timeoutMs;
    return new Promise((resolve, reject) => {
      execFile(this.config.binaryPath, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new Error(`ARCHIVE_EXEC_FAILED ${detail}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private log(message: string): void {
    this.config.logger?.(message);
  }
}
