/**
 * 侧边栏会话令牌（#147 / #145）。
 *
 * 企微 OAuth 回调在 #145 里签发；这里只做签发与校验，避免 H5 直接
 * 携带企微 code 访问业务接口。令牌放在 HttpOnly Cookie 里，带过期时间，
 * 用 HMAC-SHA256 签名；Secret 只从插件配置读取，不写日志。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'zb_sidebar';

export interface SidebarSessionPayload {
  advisorId: string;
  permissions: string[];
  /** 过期时刻（毫秒） */
  exp: number;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signSession(payload: SidebarSessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): SidebarSessionPayload | undefined {
  if (!token || secret === '') return undefined;
  const index = token.lastIndexOf('.');
  if (index <= 0) return undefined;
  const body = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as Partial<SidebarSessionPayload>;
    if (typeof value.advisorId !== 'string' || value.advisorId === '') return undefined;
    if (!Array.isArray(value.permissions) || value.permissions.some((p) => typeof p !== 'string')) {
      return undefined;
    }
    if (typeof value.exp !== 'number' || value.exp <= now) return undefined;
    return {
      advisorId: value.advisorId,
      permissions: value.permissions as string[],
      exp: value.exp,
    };
  } catch {
    return undefined;
  }
}

/** 会话 Cookie：HttpOnly + SameSite=Lax，HTTPS 下加 Secure */
export function sessionCookie(
  token: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 清空会话 Cookie（退出或授权失败时用） */
export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', { maxAgeSeconds: 0, secure });
}

const STATE_TTL_MS = 10 * 60_000;

/**
 * OAuth state：只带时间戳与签名，防止把授权码回调当成 CSRF 跳板。
 * 不绑定具体顾问——回调前还没拿到 userid。
 */
export function signState(at: number, secret: string): string {
  const sig = sign(secret, `state.${at}`);
  return `${at}.${sig}`;
}

export function verifyState(
  state: string | undefined,
  secret: string,
  now = Date.now(),
  ttlMs = STATE_TTL_MS,
): boolean {
  if (!state) return false;
  const index = state.indexOf('.');
  if (index <= 0) return false;
  const at = Number(state.slice(0, index));
  const signature = state.slice(index + 1);
  if (!Number.isFinite(at) || at <= 0) return false;
  if (at > now + 60_000 || now - at > ttlMs) return false;
  const expected = sign(secret, `state.${at}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 从 Cookie 头里取会话令牌；不做 URL 解码之外的处理 */
export function sessionFromCookie(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
