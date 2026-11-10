/**
 * 会话存档同意状态查询（msgaudit/check_room_agree）。
 *
 * 企微的「服务须知」由客户在企业微信里选择「已同意保存 / 不同意保存」。外部
 * 联系人不同意时，企业侧拿不到他发送的消息，直接影响患者 Agent 的上下文。
 * 存档消息本身不携带同意状态，所以这里用「会话内容存档应用 secret」换
 * access_token，按 roomid 查询群内所有外部联系人的 agree_status。
 *
 * 约束：
 * - 凭据默认复用存档 `config.txt`（第 1 行 corpid、第 2 行会话存档 Secret，
 *   与 archive_dump 一致）；Secret / Token 不进日志、不进错误信息。
 * - 只读；任何失败（无凭据、权限不足、超时、限流）都返回 undefined，由调用方
 *   保持原有状态，不阻塞存档轮询。
 * - 成功与失败都做短时缓存，避免每轮轮询都打接口。
 */
import { readFileSync } from 'node:fs';

import type { Clock } from '../../src/c2/ports.ts';
import { tailId } from '../../src/c2/redact.ts';
import type { ConsentStatus } from '../../src/p1/types.ts';

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const ROOM_AGREE_URL = 'https://qyapi.weixin.qq.com/cgi-bin/msgaudit/check_room_agree';

/** 同意状态变化不频繁；默认 5 分钟内复用结果 */
const DEFAULT_TTL_MS = 5 * 60_000;
/** 失败同样缓存，避免权限问题时每 5 秒打一次接口 */
const DEFAULT_FAILURE_TTL_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** access_token 提前 5 分钟过期，避免边界上拿到刚失效的 token */
const TOKEN_MARGIN_MS = 5 * 60_000;
const CACHE_PRUNE_THRESHOLD = 200;

/** 与 WeCom 接口只依赖这几个字段，方便测试注入假响应 */
export interface RoomAgreeResponse {
  errcode?: number;
  errmsg?: string;
  agreeinfo?: Array<{
    agree_status?: string;
    status_change_time?: number;
    /** 企微原文就是 exteranalopenid（少一个 n），不要“修正” */
    exteranalopenid?: string;
  }>;
}

export interface RoomAgreeTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

export interface RoomAgreeClientOptions {
  /** 存档 config.txt 路径；与 corpId/secret 二选一 */
  configPath?: string;
  corpId?: string;
  secret?: string;
  clock: Clock;
  logger?: (line: string) => void;
  /** 成功结果缓存时长，默认 5 分钟 */
  ttlMs?: number;
  /** 失败负缓存时长，默认 10 分钟 */
  failureTtlMs?: number;
  /** 单次 HTTP 超时，默认 8 秒 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 凭据文件读取；测试可注入 */
  readFile?: (path: string) => string;
}

/** 解析存档 config.txt：第 1 行 corpid，第 2 行会话存档 Secret */
export function parseArchiveConfig(text: string): { corpId?: string; secret?: string } {
  const lines = text.split(/\r?\n/);
  const corpId = (lines[0] ?? '').trim();
  const secret = (lines[1] ?? '').trim();
  return {
    corpId: corpId === '' ? undefined : corpId,
    secret: secret === '' ? undefined : secret,
  };
}

/** Agree → agreed；Disagree → disagreed；其他/缺省不写入 */
export function consentFromAgreeStatus(status: string | undefined): ConsentStatus | undefined {
  switch (status) {
    case 'Agree':
      return 'agreed';
    case 'Disagree':
      return 'disagreed';
    default:
      return undefined;
  }
}

export class RoomAgreeClient {
  readonly enabled: boolean;

  private readonly corpId?: string;
  private readonly secret?: string;
  private readonly clock: Clock;
  private readonly logger?: (line: string) => void;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string | undefined>;
  private tokenFailureUntil = 0;
  private readonly roomCache = new Map<
    string,
    { statuses: Record<string, ConsentStatus>; expiresAt: number }
  >();
  private readonly failureCache = new Map<string, number>();

  constructor(options: RoomAgreeClientOptions) {
    this.clock = options.clock;
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;

    let corpId = options.corpId?.trim();
    let secret = options.secret?.trim();
    if ((!corpId || !secret) && options.configPath) {
      try {
        const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
        const parsed = parseArchiveConfig(read(options.configPath));
        corpId ||= parsed.corpId;
        secret ||= parsed.secret;
      } catch {
        this.log('存档同意同步未启用：无法读取存档凭据文件');
      }
    }
    this.corpId = corpId || undefined;
    this.secret = secret || undefined;
    this.enabled = Boolean(this.corpId && this.secret);
  }

  /**
   * 返回 roomId 内 externalUserid → 同意状态。
   * 无凭据、权限不足或网络失败都返回 undefined（调用方保持原状态）。
   */
  async roomConsent(roomId: string): Promise<Record<string, ConsentStatus> | undefined> {
    if (!this.enabled) return undefined;

    const now = this.clock.now();
    const cached = this.roomCache.get(roomId);
    if (cached) {
      if (cached.expiresAt > now) return cached.statuses;
      this.roomCache.delete(roomId);
    }
    const retryAt = this.failureCache.get(roomId);
    if (retryAt !== undefined) {
      if (retryAt > now) return undefined;
      this.failureCache.delete(roomId);
    }

    try {
      let token = await this.accessToken();
      if (!token) return undefined;

      let data = await this.postRoomAgree(token, roomId);
      // token 失效：清缓存后立即重试一次，避免把一次过期当成整段时间失败
      if (data.errcode === 40014 || data.errcode === 42001) {
        this.token = undefined;
        token = await this.accessToken();
        if (!token) {
          this.recordFailure(roomId, data.errcode, now);
          return undefined;
        }
        data = await this.postRoomAgree(token, roomId);
      }

      if (data.errcode !== undefined && data.errcode !== 0) {
        this.recordFailure(roomId, data.errcode, now);
        return undefined;
      }

      const statuses: Record<string, ConsentStatus> = {};
      for (const item of data.agreeinfo ?? []) {
        const consent = consentFromAgreeStatus(item.agree_status);
        if (item.exteranalopenid && consent) statuses[item.exteranalopenid] = consent;
      }
      this.roomCache.set(roomId, { statuses, expiresAt: now + this.ttlMs });
      this.failureCache.delete(roomId);
      this.prune(now);
      // 只打数量和群 id 尾号，不打任何外部联系人 id / 昵称
      this.log(
        `存档同意状态已同步 room=${tailId(roomId)} 外部成员=${Object.keys(statuses).length}`,
      );
      return statuses;
    } catch (error) {
      this.recordFailure(roomId, undefined, now);
      this.log(
        `存档同意状态查询异常 room=${tailId(roomId)}：${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return undefined;
    }
  }

  private async accessToken(): Promise<string | undefined> {
    const now = this.clock.now();
    if (this.token && this.token.expiresAt > now) return this.token.value;
    if (now < this.tokenFailureUntil) return undefined;
    if (!this.pendingToken) {
      this.pendingToken = this.fetchToken(now).finally(() => {
        this.pendingToken = undefined;
      });
    }
    return this.pendingToken;
  }

  private async fetchToken(now: number): Promise<string | undefined> {
    try {
      const url = new URL(TOKEN_URL);
      url.searchParams.set('corpid', this.corpId ?? '');
      url.searchParams.set('corpsecret', this.secret ?? '');
      const res = await this.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await res.json()) as RoomAgreeTokenResponse;
      if (!data.access_token) {
        this.tokenFailureUntil = now + this.failureTtlMs;
        this.log(`存档同意同步未启用：access_token 获取失败 errcode=${data.errcode ?? 'unknown'}`);
        return undefined;
      }
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
      const ttl = Math.max(60_000, expiresIn * 1000 - TOKEN_MARGIN_MS);
      this.token = { value: data.access_token, expiresAt: now + ttl };
      this.tokenFailureUntil = 0;
      return data.access_token;
    } catch (error) {
      this.tokenFailureUntil = now + this.failureTtlMs;
      this.log(
        `存档同意同步未启用：access_token 请求异常 ${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return undefined;
    }
  }

  private async postRoomAgree(token: string, roomId: string): Promise<RoomAgreeResponse> {
    const res = await this.fetchImpl(
      `${ROOM_AGREE_URL}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomid: roomId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return (await res.json()) as RoomAgreeResponse;
  }

  private recordFailure(roomId: string, errcode: number | undefined, now: number): void {
    this.failureCache.set(roomId, now + this.failureTtlMs);
    this.log(`存档同意状态查询失败 room=${tailId(roomId)} errcode=${errcode ?? 'unknown'}`);
  }

  private log(line: string): void {
    this.logger?.(line);
  }

  /** 长跑进程里清掉过期项，避免缓存无限增长 */
  private prune(now: number): void {
    if (this.roomCache.size <= CACHE_PRUNE_THRESHOLD) return;
    for (const [roomId, entry] of this.roomCache) {
      if (entry.expiresAt <= now) this.roomCache.delete(roomId);
    }
    for (const [roomId, retryAt] of this.failureCache) {
      if (retryAt <= now) this.failureCache.delete(roomId);
    }
  }
}
