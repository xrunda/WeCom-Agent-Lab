/**
 * 企微自建应用 OAuth 与 JS-SDK 签名（#145 / #181）。
 *
 * - 授权换 userid：`snsapi_base` 静默授权，只拿成员身份；
 * - 网页扫码登录（#181）：浏览器打开 `qrConnect`，回调 code 与静默授权同一套换码接口；
 * - `wx.config` 用企业 jsapi_ticket，`wx.agentConfig` 用应用 ticket（type=agent_config），
 *   两者不是同一张票，混用会导致 agentConfig:fail；
 * - access_token / ticket / Secret 只存在服务端，不打印、不返回给前端。
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const USERINFO_URL = 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo';
/** 企业身份 ticket：wx.config 用。__TOKEN__ 由 loadTicket 填，漏了企微回 41022 */
const TICKET_URL = 'https://qyapi.weixin.qq.com/cgi-bin/get_jsapi_ticket?access_token=__TOKEN__';
/** 应用身份 ticket：wx.agentConfig 用 */
const AGENT_TICKET_URL = 'https://qyapi.weixin.qq.com/cgi-bin/ticket/get';
const AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize';
/** 网页扫码登录（仅在浏览器打开，企微内仍走 snsapi_base 静默授权） */
const QR_CONNECT_URL = 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect';
/** 成员资料：复核在职状态与所属部门 */
const USER_GET_URL = 'https://qyapi.weixin.qq.com/cgi-bin/user/get';
/** 应用详情：复核「可见范围」 */
const AGENT_GET_URL = 'https://qyapi.weixin.qq.com/cgi-bin/agent/get';

/** 提前 5 分钟过期，避免边界上拿到刚失效的 token / ticket */
const EARLY_EXPIRY_MS = 5 * 60_000;
const MIN_CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface WecomFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type WecomFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<WecomFetchResponse>;

export interface WecomOAuthOptions {
  corpId?: string;
  agentId?: string;
  agentSecret?: string;
  /** 侧边栏公网地址；用于拼回调与限制签名 URL */
  publicBaseUrl?: string;
  fetch?: WecomFetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** 自建应用的可见范围（agent/get 的 allow_userinfos / allow_partys / allow_tags） */
export interface WecomAgentScope {
  /** 三项同时为空 = 全企业可见 */
  allowUserIds: string[];
  allowPartyIds: number[];
  allowTags: number[];
  allowAll: boolean;
}

export interface AgentSignature {
  corpId: string;
  agentId: string;
  timestamp: string;
  nonceStr: string;
  signature: string;
}

export class WecomOAuthError extends Error {
  readonly code: string;
  /** 企微业务错误码；网络 / HTTP 异常时为空 */
  readonly errcode?: number;

  constructor(code: string, message: string, errcode?: number) {
    super(message);
    this.name = 'WecomOAuthError';
    this.code = code;
    if (errcode !== undefined) this.errcode = errcode;
  }
}

interface CachedValue {
  value: string;
  expiresAt: number;
}

export class WecomOAuthClient {
  private readonly corpId?: string;
  private readonly agentId?: string;
  private readonly agentSecret?: string;
  private readonly publicBaseUrl?: string;
  private readonly fetchImpl: WecomFetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private token?: CachedValue;
  private ticket?: CachedValue;
  private appTicket?: CachedValue;
  private tokenInFlight?: Promise<string>;
  private ticketInFlight?: Promise<string>;
  private appTicketInFlight?: Promise<string>;

  constructor(options: WecomOAuthOptions) {
    this.corpId = options.corpId;
    this.agentId = options.agentId;
    this.agentSecret = options.agentSecret;
    this.publicBaseUrl = options.publicBaseUrl;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /** OAuth 与签名都需要三项凭据；缺一项就当未启用 */
  get configured(): boolean {
    return Boolean(this.corpId && this.agentId && this.agentSecret && this.publicBaseUrl);
  }

  authorizeUrl(state: string): string {
    if (!this.configured) throw new WecomOAuthError('OAUTH_UNAVAILABLE', 'OAuth 未配置');
    const redirectUri = `${this.publicBaseUrl}/zhiban/sidebar/auth/callback`;
    const params = new URLSearchParams({
      appid: this.corpId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'snsapi_base',
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}#wechat_redirect`;
  }

  /** 用 OAuth code 换成员 userid；非企业成员只有 openid，不签发会话 */
  async exchangeCode(code: string): Promise<{ userid?: string; openid?: string }> {
    const token = await this.accessToken();
    const data = await this.getJson(
      `${USERINFO_URL}?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`,
    );
    this.assertOk(data, 'OAUTH_CODE_FAILED', '授权码换取成员身份失败');
    const userid = typeof data.userid === 'string' ? data.userid : undefined;
    const openid = typeof data.openid === 'string' ? data.openid : undefined;
    return { ...(userid ? { userid } : {}), ...(openid ? { openid } : {}) };
  }

  /**
   * 成员资料回查（#181 会话复核）。不抛业务错：errcode 交给调用方判读，
   * 只有网络 / HTTP 异常才会抛出。
   */
  async lookupMember(userid: string): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    return this.getJson(
      `${USER_GET_URL}?access_token=${encodeURIComponent(token)}&userid=${encodeURIComponent(userid)}`,
    );
  }

  /**
   * 应用可见范围（#181 会话复核）。未配置 agentId 或接口不可用时返回 undefined，
   * 调用方据此降级为「无法判定」，不要当成「不在范围」。
   */
  async lookupAgentScope(): Promise<WecomAgentScope | undefined> {
    if (!this.configured) return undefined;
    const token = await this.accessToken();
    const data = await this.getJson(
      `${AGENT_GET_URL}?access_token=${encodeURIComponent(token)}&agentid=${encodeURIComponent(this.agentId!)}`,
    );
    if (data.errcode !== undefined && data.errcode !== 0) return undefined;
    return parseAgentScope(data);
  }

  /** wx.agentConfig 所需签名：用应用 ticket（type=agent_config） */
  async signAgentConfig(url: string): Promise<AgentSignature> {
    const signed = await this.sign(url, () => this.agentTicket());
    return { corpId: this.corpId!, agentId: this.agentId!, ...signed };
  }

  /** wx.config 所需签名：用企业 jsapi_ticket，和 agentConfig 不是同一张票 */
  async signConfig(url: string): Promise<Omit<AgentSignature, 'corpId' | 'agentId'>> {
    return this.sign(url, () => this.jsapiTicket());
  }

  private async sign(
    url: string,
    ticketOf: () => Promise<string>,
  ): Promise<{ timestamp: string; nonceStr: string; signature: string }> {
    if (!this.configured) throw new WecomOAuthError('OAUTH_UNAVAILABLE', 'JS-SDK 未配置');
    if (!isSameOrigin(url, this.publicBaseUrl!)) {
      throw new WecomOAuthError('URL_NOT_ALLOWED', '只能为侧边栏自己的页面签名');
    }
    const ticket = await ticketOf();
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonceStr = randomBytes(8).toString('hex');
    const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
    const signature = createHash('sha1').update(plain).digest('hex');
    return { timestamp, nonceStr, signature };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.loadAccessToken().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private async loadAccessToken(): Promise<string> {
    if (!this.corpId || !this.agentSecret) {
      throw new WecomOAuthError('OAUTH_UNAVAILABLE', '缺少 corpid 或 secret');
    }
    const data = await this.getJson(
      `${TOKEN_URL}?corpid=${encodeURIComponent(this.corpId)}` +
        `&corpsecret=${encodeURIComponent(this.agentSecret)}`,
    );
    this.assertOk(data, 'TOKEN_FAILED', '获取 access_token 失败');
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new WecomOAuthError('TOKEN_FAILED', '获取 access_token 失败');
    }
    const ttl = typeof data.expires_in === 'number' ? data.expires_in * 1000 : 7_200_000;
    this.token = {
      value: data.access_token,
      expiresAt: this.now() + Math.max(MIN_CACHE_MS, ttl - EARLY_EXPIRY_MS),
    };
    return data.access_token;
  }

  private async jsapiTicket(): Promise<string> {
    if (this.ticket && this.ticket.expiresAt > this.now()) return this.ticket.value;
    if (!this.ticketInFlight) {
      this.ticketInFlight = this.loadTicket(TICKET_URL).finally(() => {
        this.ticketInFlight = undefined;
      });
    }
    return this.ticketInFlight;
  }

  private async agentTicket(): Promise<string> {
    if (this.appTicket && this.appTicket.expiresAt > this.now()) return this.appTicket.value;
    if (!this.appTicketInFlight) {
      this.appTicketInFlight = this.loadTicket(
        `${AGENT_TICKET_URL}?access_token=__TOKEN__&type=agent_config`,
      ).finally(() => {
        this.appTicketInFlight = undefined;
      });
    }
    return this.appTicketInFlight;
  }

  /** urlTemplate 里的 __TOKEN__ 会替换成 access_token，其余参数原样保留 */
  private async loadTicket(urlTemplate: string): Promise<string> {
    // 模板漏占位符时不能静默发无 token 请求：企微只会回 41022，排查成本极高
    if (!urlTemplate.includes('__TOKEN__')) {
      throw new WecomOAuthError('TICKET_FAILED', 'ticket 地址缺少 access_token');
    }
    const token = await this.accessToken();
    const data = await this.getJson(
      urlTemplate.replace('__TOKEN__', encodeURIComponent(token)),
    );
    this.assertOk(data, 'TICKET_FAILED', '获取 jsapi_ticket 失败');
    if (typeof data.ticket !== 'string' || data.ticket === '') {
      throw new WecomOAuthError('TICKET_FAILED', '获取 jsapi_ticket 失败');
    }
    const ttl = typeof data.expires_in === 'number' ? data.expires_in * 1000 : 7_200_000;
    const cached = {
      value: data.ticket,
      expiresAt: this.now() + Math.max(MIN_CACHE_MS, ttl - EARLY_EXPIRY_MS),
    };
    if (urlTemplate.includes('type=agent_config')) this.appTicket = cached;
    else this.ticket = cached;
    return data.ticket;
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    let response: WecomFetchResponse;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : undefined;
      response = await this.fetchImpl(url, signal ? { signal } : undefined);
    } catch (error) {
      // 只报错误类型，不带 URL（URL 里有 token / code）
      const name = error instanceof Error ? error.name : 'UNKNOWN';
      throw new WecomOAuthError('NETWORK_FAILED', `企微接口请求失败（${name}）`);
    }
    if (!response.ok) {
      throw new WecomOAuthError('HTTP_FAILED', `企微接口返回 HTTP ${response.status}`);
    }
    const data = (await response.json()) as unknown;
    if (typeof data !== 'object' || data === null) {
      throw new WecomOAuthError('BAD_RESPONSE', '企微接口返回格式异常');
    }
    return data as Record<string, unknown>;
  }

  private assertOk(
    data: Record<string, unknown>,
    code: string,
    message: string,
  ): void {
    const errcode = data.errcode;
    if (errcode === undefined || errcode === 0) return;
    // errcode 与 errmsg 是企微的排障信息，不含凭据
    const detail = typeof data.errmsg === 'string' ? `：${data.errmsg}` : '';
    this.log(`企微接口失败 errcode=${String(errcode)}`);
    throw new WecomOAuthError(
      code,
      `${message}（errcode=${String(errcode)}${detail}）`,
      typeof errcode === 'number' ? errcode : undefined,
    );
  }
}

/**
 * 网页扫码登录 URL（#181）。
 *
 * `agentid` 必须是自建应用：扫码后企微按该应用的**可见范围**放行，
 * 不在范围内的成员连 code 都换不出 userid。智能机器人没有 agentid 语义，不能用于登录。
 */
export function buildWecomQrConnectUrl(input: {
  corpId: string;
  agentId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    appid: input.corpId,
    agentid: input.agentId,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${QR_CONNECT_URL}?${params.toString()}`;
}

/**
 * 从 agent/get 的可见范围字段里取 id 列表。
 * 成员是对象数组（`user: [{userid}]`），部门 / 标签是数字数组（`partyid: [1,2]`）。
 */
function scopeIds(value: unknown, key: string, objectKey?: string): string[] {
  if (value === null || typeof value !== 'object') return [];
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  const result: string[] = [];
  for (const item of list) {
    const picked =
      objectKey && item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>)[objectKey]
        : item;
    if (typeof picked === 'string' && picked !== '') result.push(picked);
    else if (typeof picked === 'number' && Number.isFinite(picked)) result.push(String(picked));
  }
  return result;
}

/** agent/get 响应 → 可见范围；字段缺失按「全企业可见」处理，避免误删会话 */
export function parseAgentScope(data: Record<string, unknown>): WecomAgentScope {
  const allowUserIds = scopeIds(data.allow_userinfos, 'user', 'userid');
  const allowPartyIds = scopeIds(data.allow_partys, 'partyid').map(Number).filter(Number.isFinite);
  const allowTags = scopeIds(data.allow_tags, 'tagid').map(Number).filter(Number.isFinite);
  return {
    allowUserIds,
    allowPartyIds,
    allowTags,
    allowAll: allowUserIds.length === 0 && allowPartyIds.length === 0 && allowTags.length === 0,
  };
}

/** 只允许为同一来源的页面签名，避免签出任意 URL */
export function isSameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
