/**
 * 真实 ArchivePort：调用 C++ 工具 archive_dump 拉取会话存档并解密。
 *
 * 链路：GetChatData（密文） → RSA 解 encrypt_random_key → DecryptData → 明文 JSON
 * 工具输出 --json：{"nextSeq":23,"count":2,"messages":[{...},{...}]}
 *
 * 设计要点：
 * - 主轮询只维护一个 seq 游标，按增量拉取，不重复解密历史。
 * - 每次 poll 最多拉 maxBatchesPerPoll 批，避免一次吃满。
 * - 内存缓存最近 cacheLimit 条，供 Verifier 按时间窗过滤。
 * - 重启后缓存为空、主游标只拉增量；Verifier 回读窗口内的历史消息
 *   由 listSentMessages 从持久化 seq 回退有界窗口补拉一次（不推进主游标）。
 */
import { execFile } from 'node:child_process';

import type { ArchiveHistoryRecord, ArchivePort } from '../ports.ts';
import { describeMessageMeta, tailId } from '../redact.ts';
import type { ArchivedInbound, SentMessage } from '../types.ts';
import {
  ArchiveDumpMediaSource,
  MediaDownloader,
  type MediaDownloaderConfig,
} from '../media.ts';

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
  /** 图片消息的媒体元数据（#54） */
  image?: { sdkfileid?: string; md5?: string; filesize?: number; [key: string]: unknown };
  /** 语音消息的媒体元数据；转写后 text 会被填入识别结果 */
  voice?: { sdkfileid?: string; md5sum?: string; voice_size?: number; play_length?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** 图片落盘 / 语音转写后写回缓存记录的字段，供服务流读取 */
export interface ArchiveMediaFields {
  mediaPath?: string;
  mediaMd5?: string;
  mediaSize?: number;
  mediaFailed?: boolean;
  /** 语音转写失败：消息不进入服务流，避免空上下文起回合 */
  voiceFailed?: boolean;
  /** 语音正文来自 ASR 转写 */
  voiceTranscript?: boolean;
}

/** #159 单聊消息：比群消息多一个 tolist（接收方数组），roomid 恒为空串 */
export interface ArchivedDmMessage extends ArchivedInbound {
  tolist?: string[];
}

/**
 * 外部成员 id 判定：企微外部联系人（wo）与外部群成员（wm）前缀。
 * 员工、内部应用与 AI 助手 id 都不在这两个前缀里。
 */
export function isExternalCustomerId(id: string): boolean {
  return id.startsWith('wm') || id.startsWith('wo');
}

/** #160 待回复索引接受的存档消息类型：文字 + 媒体（媒体没有正文，但同样欠回应） */
const SIDEBAR_MSGTYPES = new Set(['text', 'image', 'voice', 'video', 'file']);

export interface WeComArchiveMediaConfig {
  /** 媒体落盘根目录：<root>/<roomid>/<msgid>.<ext> */
  rootDir: string;
  /** archive_dump 路径；与 binaryPath 相同 */
  binaryPath?: string;
  /** archive_dump 的 corpid/secret 配置文件 */
  configPath?: string;
  retries?: number;
  maxBytes?: number;
  retryDelayMs?: number;
  /** 测试注入 */
  downloader?: MediaDownloader;
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
  /** 重启后回读历史：从持久化 seq 回退的最大记录数（默认 1000） */
  historyReplayRecords?: number;
  /** 重启后回读历史：每个回退窗口最多拉几批（默认 10） */
  historyReplayBatches?: number;
  /**
   * 服务群判定；默认全部视为非服务群，正文不落缓存、不进日志。
   * 真实判定（外部成员）由 #33 注入。
   */
  isServiceGroup?: (roomId: string) => boolean;
  /**
   * 受服务单聊判定（#159）：顾问与客户之间的单聊正文入缓存（供待回复索引），
   * 其余单聊只留元数据。媒体下载仍只对服务群生效。
   */
  isServedDm?: (record: ArchiveRecord) => boolean;
  /** #54：图片拉取配置；缺省只登记图片类型，不下载 */
  media?: WeComArchiveMediaConfig;
  /**
   * 语音转写；缺省时语音消息保持不处理（旧行为）。
   * 只有服务群的语音才会调用；音频字节只在内存里流转，不落盘。
   */
  transcribeVoice?: (audio: Buffer) => Promise<string>;
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
  historyReplayRecords: 1000,
  historyReplayBatches: 10,
};

function buildMediaDownloader(
  media: WeComArchiveMediaConfig,
  config: WeComArchiveConfig,
): MediaDownloader {
  if (media.downloader) return media.downloader;
  const downloaderConfig: MediaDownloaderConfig = {
    rootDir: media.rootDir,
    maxBytes: media.maxBytes,
    retries: media.retries,
    retryDelayMs: media.retryDelayMs,
  };
  const source = new ArchiveDumpMediaSource({
    binaryPath: media.binaryPath ?? config.binaryPath,
    configPath: media.configPath ?? config.configPath,
    timeoutMs: config.timeoutMs,
  });
  return new MediaDownloader(source, downloaderConfig);
}

export class WeComArchiveAdapter implements ArchivePort {
  private readonly config: WeComArchiveConfig;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly cacheLimit: number;
  private readonly historyReplayRecords: number;
  private readonly historyReplayBatches: number;
  private readonly run: (args: string[]) => Promise<string>;
  private readonly isServiceGroup: (roomId: string) => boolean;
  private readonly isServedDm?: (record: ArchiveRecord) => boolean;
  private readonly media?: MediaDownloader;

  private seq: number;
  private cache: ArchiveRecord[] = [];
  private known = new Set<string>();
  /** 本轮 pull 中只计数、未落正文的记录数 */
  private nonServiceCount = 0;
  /** 从持久化 seq 恢复时的起点；回读补拉一次后清空 */
  private restoredSeq?: number;

  constructor(config: WeComArchiveConfig) {
    this.config = config;
    this.batchSize = config.batchSize ?? DEFAULT_ARCHIVE_CONFIG.batchSize;
    this.maxBatches = config.maxBatchesPerPoll ?? DEFAULT_ARCHIVE_CONFIG.maxBatchesPerPoll;
    this.cacheLimit = config.cacheLimit ?? DEFAULT_ARCHIVE_CONFIG.cacheLimit;
    this.historyReplayRecords =
      config.historyReplayRecords ?? DEFAULT_ARCHIVE_CONFIG.historyReplayRecords;
    this.historyReplayBatches =
      config.historyReplayBatches ?? DEFAULT_ARCHIVE_CONFIG.historyReplayBatches;
    this.isServiceGroup = config.isServiceGroup ?? (() => false);
    this.isServedDm = config.isServedDm;
    this.seq = config.initialSeq ?? 0;
    if (this.seq > 0) this.restoredSeq = this.seq;
    this.run = config.run ?? ((args) => this.exec(args));
    this.media = config.media ? buildMediaDownloader(config.media, config) : undefined;
  }

  /** 当前游标，持久化后可在重启时恢复 */
  getSeq(): number {
    return this.seq;
  }

  setSeq(seq: number): void {
    this.seq = seq;
    // 线上启动时用持久化 seq 调 setSeq；标记为「恢复点」，供首次回读补历史
    this.restoredSeq = seq > 0 ? seq : undefined;
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
      added += await this.remember(out.messages);
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

    let messages = this.filterSent(params);
    // 重启后缓存被清空、主游标只拉增量，回读窗口里的历史消息不在缓存里。
    // 从持久化 seq 回退有界窗口补拉一次：不推进主游标、不触发回合。
    if (this.restoredSeq !== undefined && !this.cacheCovers(params.since)) {
      await this.replayHistory(params.since, params.until);
      messages = this.filterSent(params);
    }
    return messages;
  }

  private filterSent(params: {
    fromUser: string;
    since: number;
    until: number;
  }): SentMessage[] {
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

  /** 缓存里已有不晚于 since 的记录，说明这个时间窗已经被增量拉取覆盖 */
  private cacheCovers(since: number): boolean {
    return this.cache.some((r) => r.msgtime <= since);
  }

  /**
   * 重启后补拉回读窗口：从持久化 seq 回退，向前拉到覆盖 [since, until]。
   * 只写缓存，不改 this.seq；补拉失败由上层的回读重试兜底。
   */
  private async replayHistory(since: number, until: number): Promise<void> {
    const anchor = this.restoredSeq;
    if (anchor === undefined) return;

    let rewind = Math.max(1, this.historyReplayRecords);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const start = Math.max(0, anchor - rewind);
      this.log(`回读补拉历史：seq ${anchor} 回退到 ${start}，窗口 ${since}..${until}`);
      const coverage = await this.fetchWindow(start, since, until);
      // 首次成功补拉后不再重复回退；失败则保留恢复点，交给下次回读重试
      this.restoredSeq = undefined;
      // 回退点已早于窗口下界，或已到存档起点：补拉到此为止
      if (coverage.oldest <= since || start === 0) return;
      // 窗口内记录比预估多，回退范围翻倍再试一次
      rewind *= 2;
    }
  }

  /** 从 start 向前拉，直到覆盖 [since, until] 或达到批次上限 */
  private async fetchWindow(
    start: number,
    since: number,
    until: number,
  ): Promise<{ oldest: number; newest: number }> {
    let cursor = start;
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.historyReplayBatches; i += 1) {
      const out = await this.fetch(cursor);
      if (out.messages.length === 0) break;
      for (const message of out.messages) {
        oldest = Math.min(oldest, message.msgtime);
        newest = Math.max(newest, message.msgtime);
      }
      // 只补 Verifier 需要的「员工在服务群发出的文字」。
      // 不要把历史入站消息放回共享缓存：重启后 trigger 的 seen 为空，
      // 否则会把停机前已处理过的客户消息再触发一遍。
      const sentOnly = out.messages.filter(
        (message) =>
          message.action === 'send' &&
          message.msgtype === 'text' &&
          this.isServiceGroup(message.roomid ?? ''),
      );
      // 补拉历史不下载图片，也不打印正文
      await this.remember(sentOnly, { media: false, quiet: true });
      if (oldest <= since && newest >= until) break;
      if (out.messages.length < this.batchSize) break;
      if (out.nextSeq <= cursor) break;
      cursor = out.nextSeq;
    }
    return { oldest, newest };
  }

  async listInboundMessages(params: {
    roomIds: string[];
    excludeSender: string;
    since: number;
    until: number;
    /** #54：是否把图片消息也返回（默认只返回文字，保持原有触发逻辑不变） */
    includeMedia?: boolean;
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
      const mediaAllowed =
        params.includeMedia === true &&
        (record.msgtype === 'image' ||
          (record.msgtype === 'voice' && this.config.transcribeVoice !== undefined));
      if (record.msgtype !== 'text' && !mediaAllowed) {
        reject(record, `msgtype=${record.msgtype}`);
        continue;
      }
      if (record.msgtype === 'voice' && (record.voiceFailed === true || !record.text?.content)) {
        reject(record, '语音转写失败');
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
      const media = record as ArchiveRecord & ArchiveMediaFields;
      result.push({
        msgid: record.msgid,
        roomid,
        from: record.from,
        text: record.text?.content ?? '',
        msgtime: record.msgtime,
        action: record.action,
        msgtype: record.msgtype,
        mediaPath: media.mediaPath,
        mediaMd5: media.mediaMd5,
        mediaSize: media.mediaSize,
        mediaFailed: media.mediaFailed,
      });
    }
    return result;
  }

  /**
   * #63：返回群内全部文字/图片消息（含内部员工），用于「顾问直接回复」的上下文同步。
   * 与 listInboundMessages 的区别只有不排除发送者、不做 wm 判断。
   */
  async listGroupMessages(params: {
    roomIds: string[];
    since: number;
    until: number;
    includeMedia?: boolean;
  }): Promise<ArchivedInbound[]> {
    await this.pull();

    const rooms = new Set(params.roomIds);
    const result: ArchivedInbound[] = [];
    for (const record of this.cache) {
      const roomid = record.roomid ?? '';
      if (!this.isServiceGroup(roomid) || !rooms.has(roomid)) continue;
      const mediaAllowed =
        params.includeMedia === true &&
        (record.msgtype === 'image' ||
          (record.msgtype === 'voice' && this.config.transcribeVoice !== undefined));
      if (record.msgtype !== 'text' && !mediaAllowed) continue;
      if (record.msgtype === 'voice' && (record.voiceFailed === true || !record.text?.content)) continue;
      if (record.msgtime < params.since || record.msgtime > params.until) continue;
      const media = record as ArchiveRecord & ArchiveMediaFields;
      result.push({
        msgid: record.msgid,
        roomid,
        from: record.from,
        text: record.text?.content ?? '',
        msgtime: record.msgtime,
        action: record.action,
        msgtype: record.msgtype,
        mediaPath: media.mediaPath,
        mediaMd5: media.mediaMd5,
        mediaSize: media.mediaSize,
        mediaFailed: media.mediaFailed,
      });
    }
    return result;
  }

  /**
   * #159 单聊存档：返回员工与外部客户之间的单聊消息。
   *
   * 真实样本结论（2026-11-13）：单聊 `roomid` 为空串，`from` 是发送方、
   * `tolist` 是接收方数组；`action` 全为 `send`，方向只能按「from 是否员工」
   * 判断。`action=switch` 是会话切换事件，没有 `msgtime`，直接跳过。
   * 对端只接受 wm/wo 前缀的外部成员：AI 助手与应用会话不是客户单聊。
   *
   * 只扫缓存，不主动 pull：runtime 每轮先由 trigger 拉增量再调用本方法，
   * 缓存即最新；绕过 runtime 单独调用时请先 `await pull()`。
   */
  async listDmMessages(params: {
    staffUserIds: string[];
    since: number;
    until: number;
    includeMedia?: boolean;
  }): Promise<ArchivedDmMessage[]> {
    const staff = new Set(params.staffUserIds);
    const result: ArchivedDmMessage[] = [];
    for (const record of this.cache) {
      if (record.roomid !== undefined && record.roomid !== '') continue;
      if (typeof record.msgtime !== 'number') continue;
      if (record.msgtype !== 'text' && !(params.includeMedia && record.msgtype === 'image')) {
        continue;
      }
      if (record.msgtime < params.since || record.msgtime > params.until) continue;

      const from = record.from;
      const to = (record.tolist ?? []).filter(
        (id): id is string => typeof id === 'string' && id !== '',
      );
      const fromStaff = staff.has(from);
      // 员工发出：对端是 tolist[0]；外部发出：to 里必须有员工
      const matched = fromStaff
        ? isExternalCustomerId(to[0] ?? '')
        : to.some((id) => staff.has(id)) && isExternalCustomerId(from);
      if (!matched) continue;
      const counterpart = fromStaff ? (to[0] ?? '') : from;

      const media = record as ArchiveRecord & ArchiveMediaFields;
      result.push({
        msgid: record.msgid,
        roomid: '',
        from,
        text: record.text?.content ?? '',
        msgtime: record.msgtime,
        action: record.action,
        msgtype: record.msgtype,
        ...(media.mediaPath ? { mediaPath: media.mediaPath } : {}),
        ...(media.mediaMd5 ? { mediaMd5: media.mediaMd5 } : {}),
        ...(media.mediaSize !== undefined ? { mediaSize: media.mediaSize } : {}),
        ...(media.mediaFailed !== undefined ? { mediaFailed: media.mediaFailed } : {}),
        tolist: to,
      });
    }
    return result;
  }

  /** 缓存里的全部消息，调试用 */
  listCached(): ArchiveRecord[] {
    return [...this.cache];
  }

  /**
   * #160 重启后补建待回复索引：把 [since, until] 内的服务群与受服务单聊
   * 记录（含员工发言）读出来，按时间升序返回。
   *
   * 只读：不写共享缓存（否则 trigger 会把停机前已处理的客户消息再触发一遍
   * 草稿）、不下载媒体、不推进主游标。重启后缓存只覆盖本进程启动之后的
   * 增量，更早的记录走一次有界回读（与 Verifier 回读共用恢复点）。
   */
  async listSidebarHistory(params: {
    since: number;
    until: number;
  }): Promise<ArchiveHistoryRecord[]> {
    const seen = new Set<string>();
    const collected: ArchiveRecord[] = [];
    const take = (record: ArchiveRecord): void => {
      if (!record?.msgid || seen.has(record.msgid)) return;
      seen.add(record.msgid);
      collected.push(record);
    };
    for (const record of this.cache) take(record);
    if (!this.cacheCovers(params.since)) {
      for (const record of await this.replayForSidebar(params.since, params.until)) {
        take(record);
      }
    }
    return collected
      .filter((record) => {
        if (record.msgtime < params.since || record.msgtime > params.until) return false;
        // switch 是会话切换事件（没有正文），不进待回复
        if ((record.action as string | undefined) === 'switch') return false;
        // 文字与媒体都要进索引：客户发语音/图片同样是「欠一个回应」
        if (!SIDEBAR_MSGTYPES.has(record.msgtype ?? '')) return false;
        if (record.roomid) return this.isServiceGroup(record.roomid);
        return this.isServedDm?.(record) === true;
      })
      .sort((a, b) => a.msgtime - b.msgtime)
      .map((record) => ({
        msgid: record.msgid,
        roomId: record.roomid ?? '',
        from: record.from,
        tolist: record.tolist,
        text: record.text?.content,
        msgtime: record.msgtime,
        msgtype: record.msgtype,
      }));
  }

  /**
   * 从恢复点有界回退，向前拉到覆盖窗口；只收集、不入缓存。
   * 首次成功后清掉恢复点——与 Verifier 的回读共享这一次回退机会。
   */
  private async replayForSidebar(since: number, until: number): Promise<ArchiveRecord[]> {
    const anchor = this.restoredSeq;
    if (anchor === undefined) return [];

    const collected: ArchiveRecord[] = [];
    let rewind = Math.max(1, this.historyReplayRecords);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const start = Math.max(0, anchor - rewind);
      let cursor = start;
      let oldest = Number.POSITIVE_INFINITY;
      let newest = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < this.historyReplayBatches; i += 1) {
        const out = await this.fetch(cursor);
        if (out.messages.length === 0) break;
        for (const message of out.messages) {
          oldest = Math.min(oldest, message.msgtime);
          newest = Math.max(newest, message.msgtime);
          if (message.msgtime >= since && message.msgtime <= until) {
            collected.push(message);
          }
        }
        if (newest >= until) break;
        if (out.messages.length < this.batchSize) break;
        if (out.nextSeq <= cursor) break;
        cursor = out.nextSeq;
      }
      this.restoredSeq = undefined;
      this.log(`待回复补建回读：seq ${anchor} 回退到 ${start}，窗口 ${since}..${until}`);
      // 回退点已早于窗口下界，或已到存档起点：补拉到此为止
      if (oldest <= since || start === 0) return collected;
      // 窗口内记录比预估多，回退范围翻倍再试一次
      rewind *= 2;
    }
    return collected;
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

  private async remember(
    messages: ArchiveRecord[],
    options: { media?: boolean; quiet?: boolean } = {},
  ): Promise<number> {
    const withMedia = options.media !== false;
    const quiet = options.quiet === true;
    let added = 0;
    for (const message of messages) {
      if (!message?.msgid || this.known.has(message.msgid)) continue;
      this.known.add(message.msgid);
      const inRoom = this.isServiceGroup(message.roomid ?? '');
      // 受服务单聊（顾问↔客户）正文入缓存；其余单聊与正文不进任何存储，
      // 只留元数据；媒体下载仍只对服务群生效（#31 / #54 / #159）。
      const served = inRoom || this.isServedDm?.(message) === true;
      const record = served ? message : { ...message, text: undefined };
      this.cache.push(record);
      added += 1;
      if (inRoom) {
        if (!quiet) this.log(`  记录 ${describeRecord(message)}`);
        if (withMedia && message.msgtype === 'image') await this.fetchMedia(record);
        if (withMedia && message.msgtype === 'voice') await this.transcribeVoiceMessage(record);
      } else if (!served && !quiet) {
        this.nonServiceCount += 1;
      }
    }
    if (this.cache.length > this.cacheLimit) {
      // 补拉历史会把较早的记录追加到尾部；按时间裁掉最旧的，保留最新窗口
      this.cache.sort((a, b) => a.msgtime - b.msgtime);
      const dropped = this.cache.splice(0, this.cache.length - this.cacheLimit);
      for (const item of dropped) this.known.delete(item.msgid);
    }
    return added;
  }

  /** #54：图片落盘；失败只标记 media_failed，不中断整轮拉取 */
  private async fetchMedia(record: ArchiveRecord & ArchiveMediaFields): Promise<void> {
    if (!this.media) return;
    const image = record.image;
    const sdkfileid = typeof image?.sdkfileid === 'string' ? image.sdkfileid : '';
    if (sdkfileid === '') {
      record.mediaFailed = true;
      this.log(`  图片缺少 sdkfileid msgid=${tailId(record.msgid)}`);
      return;
    }
    try {
      const saved = await this.media.save({
        sdkfileid,
        roomId: record.roomid ?? '',
        msgId: record.msgid,
        expectedMd5: typeof image?.md5 === 'string' ? image.md5 : undefined,
        expectedSize: typeof image?.filesize === 'number' ? image.filesize : undefined,
      });
      record.mediaPath = saved.path;
      record.mediaMd5 = saved.md5;
      record.mediaSize = saved.size;
      // 只记大小，不记路径中的会话标识
      this.log(`  图片落盘 msgid=${tailId(record.msgid)} size=${saved.size}`);
    } catch (error) {
      record.mediaFailed = true;
      const code = error instanceof Error ? error.message : 'MEDIA_FAILED';
      this.log(`  图片下载失败 msgid=${tailId(record.msgid)}：${code}`);
    }
  }

  /**
   * 语音转写：只有服务群、且配置了 transcribeVoice 时才拉取音频。
   * 音频只在内存里转给 ASR，不落盘、不进日志；失败只记错误码。
   */
  private async transcribeVoiceMessage(record: ArchiveRecord & ArchiveMediaFields): Promise<void> {
    const transcribe = this.config.transcribeVoice;
    if (!transcribe) return;
    if (!this.media) {
      record.voiceFailed = true;
      this.log(`  语音缺少媒体下载器 msgid=${tailId(record.msgid)}`);
      return;
    }

    const voice = record.voice;
    const sdkfileid = typeof voice?.sdkfileid === 'string' ? voice.sdkfileid : '';
    if (sdkfileid === '') {
      record.voiceFailed = true;
      this.log(`  语音缺少 sdkfileid msgid=${tailId(record.msgid)}`);
      return;
    }

    let text: string;
    try {
      const audio = await this.media.download({
        sdkfileid,
        expectedMd5: typeof voice?.md5sum === 'string' ? voice.md5sum : undefined,
      });
      // 只记大小，不记音频内容
      this.log(`  语音拉取 msgid=${tailId(record.msgid)} size=${audio.size}`);
      text = (await transcribe(audio.buffer)).trim();
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'VOICE_FAILED';
      record.voiceFailed = true;
      this.log(`  语音转写失败 msgid=${tailId(record.msgid)}：${code}`);
      return;
    }

    if (text === '') {
      record.voiceFailed = true;
      this.log(`  语音识别结果为空 msgid=${tailId(record.msgid)}`);
      return;
    }

    record.text = { content: text };
    record.voiceTranscript = true;
    // 转写正文不落日志，只记长度
    this.log(`  语音转写完成 msgid=${tailId(record.msgid)} chars=${text.length}`);
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
