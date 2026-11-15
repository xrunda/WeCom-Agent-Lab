/**
 * #181 控制台企微扫码登录。
 *
 * 分工：**企微负责「你是谁、在不在职」，知伴负责「进来能做什么」**。
 * - 扫码后按自建应用「知伴顾问助手」的可见范围放行，换出 userid；
 * - userid 必须已在 accounts.wecomUserId 绑定，不自动建号、不自动升权；
 * - 会话仍是我们自己的 cookie，续期时回查成员状态（5 分钟缓存）。
 *
 * 安全：state 一次性、5 分钟有效；code / Secret / access_token / 完整 userid 不进日志。
 */
import { randomBytes } from 'node:crypto';

import type { ConsoleAuthService } from './auth.ts';
import type { ConsoleStore } from '../../src/p1/console-store.ts';
import { WecomOAuthError, buildWecomQrConnectUrl } from '../../src/p1/wecom-oauth.ts';
import type { WecomAgentScope, WecomOAuthClient } from '../../src/p1/wecom-oauth.ts';
import type { WecomLoginConfig } from './config.ts';

/** 扫码 URL 的有效期：够扫、够慢网回调 */
const STATE_TTL_MS = 5 * 60_000;
/** 成员状态复核缓存：避免每个会话每次续期都打企微 */
const MEMBERSHIP_CACHE_MS = 5 * 60_000;
/** 会话续期复核间隔（扫描周期由插件决定） */
export const RECHECK_INTERVAL_MS = 5 * 60_000;
/** 未使用的 state 上限：公开接口，防止被刷爆内存 */
const MAX_PENDING_STATES = 2000;
/** 企微明确表示「不是企业成员 / 账号停用」的错误码 */
const REMOVED_ERRCODES = new Set([60111, 46004]);
/** 可见范围不含该成员时的错误码 */
const NO_PRIVILEGE_ERRCODES = new Set([60011]);

export type WecomLoginFailure =
  | 'STATE_INVALID'
  | 'OUT_OF_SCOPE'
  | 'CODE_FAILED'
  | 'UNAVAILABLE';

export class WecomLoginError extends Error {
  readonly reason: WecomLoginFailure;

  constructor(reason: WecomLoginFailure, message: string) {
    super(message);
    this.name = 'WecomLoginError';
    this.reason = reason;
  }
}

export type MembershipVerdict = 'active' | 'removed' | 'unknown';

export interface WecomLoginOptions {
  oauth: WecomOAuthClient;
  config: WecomLoginConfig;
  tenantId: string;
  store: ConsoleStore;
  auth: ConsoleAuthService;
  now?: () => number;
  log?: (line: string) => void;
}

interface PendingState {
  returnTo: string;
  expiresAt: number;
}

/**
 * 只允许站内相对路径作为登录后跳转，避免开放重定向。
 * 不接受 `//evil.com`、`/\evil.com` 这类浏览器会当成协议相对 URL 的写法。
 */
export function safeReturnTo(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (value === '' || value.length > 300) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

/** 日志里只留 userid 尾号；同一租户内仍可定位到人 */
export function maskUserid(userid: string): string {
  return userid.length <= 4 ? '***' : `***${userid.slice(-4)}`;
}

export class WecomLoginService {
  private readonly oauth: WecomOAuthClient;
  private readonly config: WecomLoginConfig;
  private readonly tenantId: string;
  private readonly store: ConsoleStore;
  private readonly auth: ConsoleAuthService;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly states = new Map<string, PendingState>();
  private readonly membership = new Map<string, { verdict: MembershipVerdict; expiresAt: number }>();

  constructor(options: WecomLoginOptions) {
    this.oauth = options.oauth;
    this.config = options.config;
    this.tenantId = options.tenantId;
    this.store = options.store;
    this.auth = options.auth;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  get configured(): boolean {
    return this.oauth.configured;
  }

  /** 回调地址必须在企微后台「授权回调域」内，且与控制台同源 */
  get redirectUri(): string {
    return `${this.config.publicBaseUrl}/zhiban/api/auth/wecom/callback`;
  }

  /** 生成一次性 state + 扫码 URL；每次点击「扫码登录」重新生成 */
  createQrUrl(returnTo: string | null): string {
    if (!this.configured) {
      throw new WecomLoginError('UNAVAILABLE', '企微扫码登录未配置');
    }
    const now = this.now();
    for (const [key, value] of this.states) {
      if (value.expiresAt <= now) this.states.delete(key);
    }
    // 公开接口：只保留最近 2000 个未使用的 state，防止被刷爆内存
    while (this.states.size >= MAX_PENDING_STATES) {
      const oldest = this.states.keys().next();
      if (oldest.done) break;
      this.states.delete(oldest.value);
    }
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { returnTo: safeReturnTo(returnTo), expiresAt: now + STATE_TTL_MS });
    return buildWecomQrConnectUrl({
      corpId: this.config.corpId,
      agentId: this.config.agentId,
      redirectUri: this.redirectUri,
      state,
    });
  }

  /** 消费 state：一次性，过期或未知一律视为失效 */
  consumeState(state: string | null): string {
    if (!state) throw new WecomLoginError('STATE_INVALID', '登录状态无效，请重新扫码');
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.expiresAt <= this.now()) {
      throw new WecomLoginError('STATE_INVALID', '登录状态已失效，请重新扫码');
    }
    return pending.returnTo;
  }

  /**
   * 校验 state 并换 userid。
   * 不在应用可见范围时企微会在扫码或换码阶段直接拒绝，这里统一归为 OUT_OF_SCOPE。
   */
  async completeCallback(
    code: string | null,
    state: string | null,
  ): Promise<{ userid: string; returnTo: string }> {
    const returnTo = this.consumeState(state);
    if (!code) throw new WecomLoginError('STATE_INVALID', '缺少授权码，请重新扫码');
    if (!this.configured) {
      throw new WecomLoginError('UNAVAILABLE', '企微扫码登录未配置');
    }
    let userid: string | undefined;
    try {
      const result = await this.oauth.exchangeCode(code);
      userid = result.userid;
    } catch (error) {
      if (error instanceof WecomOAuthError) {
        if (error.errcode !== undefined && NO_PRIVILEGE_ERRCODES.has(error.errcode)) {
          this.log('企微扫码登录失败：成员不在自建应用可见范围');
          throw new WecomLoginError('OUT_OF_SCOPE', '你不在知伴顾问助手的可见范围内');
        }
        this.log(`企微扫码登录失败：换码异常 ${error.code}`);
        throw new WecomLoginError('CODE_FAILED', '企微接口暂时不可用，请稍后重试');
      }
      throw error;
    }
    if (!userid) {
      // 外部联系人只有 openid：不是企业成员，不能进控制台
      this.log('企微扫码登录失败：换码结果不含 userid');
      throw new WecomLoginError('OUT_OF_SCOPE', '不是企业成员，无法登录控制台');
    }
    return { userid, returnTo };
  }

  /**
   * 成员是否仍在应用可见范围内。
   * - `removed` 只用于企微明确答复：不是成员、已停用、或不在可见范围；
   * - 接口失败 / 只有标签可见无法判定时返回 `unknown`，宁可下次再查，也不要在一批抖动里踢光所有人。
   */
  async checkMembership(userid: string): Promise<MembershipVerdict> {
    const cached = this.membership.get(userid);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.verdict;

    const verdict = await this.resolveMembership(userid);
    this.membership.set(userid, { verdict, expiresAt: now + MEMBERSHIP_CACHE_MS });
    return verdict;
  }

  private async resolveMembership(userid: string): Promise<MembershipVerdict> {
    let member: Record<string, unknown>;
    try {
      member = await this.oauth.lookupMember(userid);
    } catch {
      return 'unknown';
    }
    const errcode = typeof member.errcode === 'number' ? member.errcode : 0;
    if (errcode !== 0) {
      return REMOVED_ERRCODES.has(errcode) ? 'removed' : 'unknown';
    }
    // status: 1=已激活 2=已禁用 4=未激活 5=退出企业
    if (member.status !== 1) return 'removed';
    const departments = Array.isArray(member.department)
      ? member.department.filter((item): item is number => typeof item === 'number')
      : [];

    let scope: WecomAgentScope | undefined;
    try {
      scope = await this.oauth.lookupAgentScope();
    } catch {
      return 'unknown';
    }
    if (!scope) return 'unknown';
    if (scope.allowAll || scope.allowUserIds.includes(userid)) return 'active';
    if (departments.some((id) => scope.allowPartyIds.includes(id))) return 'active';
    // 只按标签授权的应用，user/get 拿不到成员标签，无法判定
    if (scope.allowTags.length > 0) return 'unknown';
    return 'removed';
  }

  /**
   * 续期复核：把已被移出可见范围 / 已离职的扫码会话作废。
   * 由插件定时调用（默认 5 分钟一轮），单轮内同一成员只查一次。
   */
  async recheckSessions(now = this.now()): Promise<number> {
    let revoked = 0;
    for (const session of this.store.listSessions()) {
      if (session.method !== 'wecom' || !session.wecomUserId) continue;
      if (session.expiresAt <= now) continue;
      if (session.recheckedAt !== undefined && now - session.recheckedAt < RECHECK_INTERVAL_MS) {
        continue;
      }
      const verdict = await this.checkMembership(session.wecomUserId);
      if (verdict === 'removed') {
        this.store.deleteSession(session.tokenHash);
        revoked += 1;
        this.log(`扫码会话已失效：成员 ${maskUserid(session.wecomUserId)} 不在可见范围`);
        continue;
      }
      this.store.saveSession({ ...session, recheckedAt: now });
    }
    return revoked;
  }

}
