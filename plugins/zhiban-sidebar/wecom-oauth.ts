/**
 * 企微自建应用 OAuth 与 JS-SDK 签名（#145）。
 *
 * - 授权换 userid：`snsapi_base` 静默授权，只拿成员身份；
 * - `wx.agentConfig` 签名：jsapi_ticket 缓存在进程内，失效前复用；
 * - access_token / ticket / Secret 只存在服务端，不打印、不返回给前端。
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const USERINFO_URL = 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo';
const TICKET_URL = 'https://qyapi.weixin.qq.com/cgi-bin/get_jsapi_ticket';
const AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize';

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

export interface AgentSignature {
  corpId: string;
  agentId: string;
  timestamp: string;
  nonceStr: string;
  signature: string;
}

export class WecomOAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WecomOAuthError';
    this.code = code;
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
  private tokenInFlight?: Promise<string>;
  private ticketInFlight?: Promise<string>;

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

  /** wx.agentConfig 所需签名；url 必须是侧边栏自己的地址 */
  async signAgentConfig(url: string): Promise<AgentSignature> {
    if (!this.configured) throw new WecomOAuthError('OAUTH_UNAVAILABLE', 'JS-SDK 未配置');
    if (!isSameOrigin(url, this.publicBaseUrl!)) {
      throw new WecomOAuthError('URL_NOT_ALLOWED', '只能为侧边栏自己的页面签名');
    }
    const ticket = await this.jsapiTicket();
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonceStr = randomBytes(8).toString('hex');
    const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
    const signature = createHash('sha1').update(plain).digest('hex');
    return {
      corpId: this.corpId!,
      agentId: this.agentId!,
      timestamp,
      nonceStr,
      signature,
    };
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
      this.ticketInFlight = this.loadTicket().finally(() => {
        this.ticketInFlight = undefined;
      });
    }
    return this.ticketInFlight;
  }

  private async loadTicket(): Promise<string> {
    const token = await this.accessToken();
    const data = await this.getJson(
      `${TICKET_URL}?access_token=${encodeURIComponent(token)}`,
    );
    this.assertOk(data, 'TICKET_FAILED', '获取 jsapi_ticket 失败');
    if (typeof data.ticket !== 'string' || data.ticket === '') {
      throw new WecomOAuthError('TICKET_FAILED', '获取 jsapi_ticket 失败');
    }
    const ttl = typeof data.expires_in === 'number' ? data.expires_in * 1000 : 7_200_000;
    this.ticket = {
      value: data.ticket,
      expiresAt: this.now() + Math.max(MIN_CACHE_MS, ttl - EARLY_EXPIRY_MS),
    };
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
    throw new WecomOAuthError(code, `${message}（errcode=${String(errcode)}${detail}）`);
  }
}

/** 只允许为同一来源的页面签名，避免签出任意 URL */
export function isSameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
