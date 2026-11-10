/**
 * 客户群昵称查询（客户联系 API）。
 *
 * 存档只带 roomid 与 userid，没有群名和成员昵称（F8）。这里用「客户联系」
 * Secret 调 externalcontact/groupchat/get?need_name=1，按 userid 取群昵称，
 * 供控制台显示「张女士」而不是「外部成员 …a1b2c3」。
 *
 * 约束：
 * - 只读，不改变草稿链路；任何失败（无凭据、90501 内部群、IP 未信任、超时）
 *   都返回 undefined，由调用方回退 id 尾号。
 * - 昵称是个人信息：不写日志、不进错误信息，只通过返回值交给患者域。
 * - Secret / Token 只在请求里出现，永远不打日志。
 */
import type { Clock } from '../../src/c2/ports.ts';
import { tailId } from '../../src/c2/redact.ts';

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const GROUPCHAT_URL = 'https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/get';

const DEFAULT_TTL_MS = 10 * 60_000;
/** 90501 内部群、IP 未信任等失败同样缓存，避免每轮轮询都打接口 */
const DEFAULT_FAILURE_TTL_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** access_token 提前 5 分钟过期，避免边界上拿到刚失效的 token */
const TOKEN_MARGIN_MS = 5 * 60_000;
const CACHE_PRUNE_THRESHOLD = 500;

/** 与 WeCom 接口只依赖这几个字段，方便测试注入假响应 */
export interface GroupChatResponse {
  errcode?: number;
  errmsg?: string;
  group_chat?: {
    name?: string;
    member_list?: Array<{ userid?: string; type?: number; name?: string }>;
  };
}

export interface TokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

export interface GroupInfoClientOptions {
  corpId?: string;
  contactSecret?: string;
  clock: Clock;
  logger?: (line: string) => void;
  /** 昵称缓存时长，默认 10 分钟 */
  ttlMs?: number;
  /** 失败负缓存时长，默认 10 分钟 */
  failureTtlMs?: number;
  /** 单次 HTTP 超时，默认 8 秒 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 同一次 groupchat/get 返回的群名与成员昵称；群名可能为空 */
export interface RoomInfo {
  name?: string;
  names: Map<string, string>;
}

export class GroupInfoClient {
  readonly enabled: boolean;

  private readonly corpId?: string;
  private readonly contactSecret?: string;
  private readonly clock: Clock;
  private readonly logger?: (line: string) => void;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string | undefined>;
  /** 凭据错误或网络故障时暂停取 token，避免每轮轮询都打接口 */
  private tokenFailureUntil = 0;
  private readonly roomCache = new Map<string, RoomInfo & { expiresAt: number }>();
  private readonly failureCache = new Map<string, number>();

  constructor(options: GroupInfoClientOptions) {
    this.corpId = options.corpId;
    this.contactSecret = options.contactSecret;
    this.clock = options.clock;
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.enabled = Boolean(this.corpId && this.contactSecret);
  }

  /**
   * 返回 roomId 内 userid → 群昵称。
   * 无凭据、内部群、权限不足或网络失败都返回 undefined（调用方回退 id 尾号）。
   */
  async memberNames(roomId: string): Promise<Map<string, string> | undefined> {
    return (await this.roomInfo(roomId))?.names;
  }

  /**
   * 返回群名与成员昵称（同一次 groupchat/get，天然同步群名）。
   * 失败返回 undefined；群名没设置时为 undefined，不覆盖已有名称。
   */
  async roomInfo(roomId: string): Promise<RoomInfo | undefined> {
    if (!this.enabled) return undefined;

    const now = this.clock.now();
    const cached = this.roomCache.get(roomId);
    if (cached) {
      if (cached.expiresAt > now) return cached;
      this.roomCache.delete(roomId);
    }
    const retryAt = this.failureCache.get(roomId);
    if (retryAt !== undefined) {
      if (retryAt > now) return undefined;
      this.failureCache.delete(roomId);
    }

    try {
      const token = await this.accessToken();
      if (!token) return undefined;

      const data = await this.postGroupChat(token, roomId);
      if (data.errcode !== undefined && data.errcode !== 0) {
        this.recordFailure(roomId, data.errcode, now);
        return undefined;
      }
      if (data.errcode === 0 || data.group_chat) {
        // 群名与昵称都不落日志
        const names = new Map<string, string>();
        for (const member of data.group_chat?.member_list ?? []) {
          if (member.userid && member.name) names.set(member.userid, member.name);
        }
        const name = data.group_chat?.name?.trim() || undefined;
        const info: RoomInfo = { name, names };
        this.roomCache.set(roomId, { ...info, expiresAt: now + this.ttlMs });
        this.failureCache.delete(roomId);
        this.prune(now);
        return info;
      }
      this.recordFailure(roomId, data.errcode, now);
      return undefined;
    } catch (error) {
      this.recordFailure(roomId, undefined, now);
      this.log(
        `群昵称查询异常 room=${tailId(roomId)}：${error instanceof Error ? error.name : 'UNKNOWN'}`,
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
      url.searchParams.set('corpsecret', this.contactSecret ?? '');
      const res = await this.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await res.json()) as TokenResponse;
      if (!data.access_token) {
        // 只打 errcode，不回显 errmsg 与请求
        this.tokenFailureUntil = now + this.failureTtlMs;
        this.log(`群昵称查询未启用：access_token 获取失败 errcode=${data.errcode ?? 'unknown'}`);
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
        `群昵称查询未启用：access_token 请求异常 ${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return undefined;
    }
  }

  private async postGroupChat(token: string, roomId: string): Promise<GroupChatResponse> {
    const res = await this.fetchImpl(
      `${GROUPCHAT_URL}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: roomId, need_name: 1 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const data = (await res.json()) as GroupChatResponse;
    // token 失效时下轮重新获取，不在这里递归重试，避免放大故障
    if (data.errcode === 40014 || data.errcode === 42001) this.token = undefined;
    return data;
  }

  private recordFailure(roomId: string, errcode: number | undefined, now: number): void {
    this.failureCache.set(roomId, now + this.failureTtlMs);
    this.log(`群昵称查询失败 room=${tailId(roomId)} errcode=${errcode ?? 'unknown'}`);
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
