/**
 * #41 认证原语：密码强哈希、口令校验、登录失败限流、业务限流。
 *
 * 只使用 node:crypto，不引入第三方依赖；哈希格式自带参数，便于将来调参。
 * 任何日志 / 响应都不应出现明文密码或哈希。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

/** 返回 `scrypt$N$r$p$salt$hash`，salt / hash 为 base64url */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltRaw!, 'base64url');
  const expected = Buffer.from(hashRaw!, 'base64url');
  if (expected.length === 0) return false;

  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      expected.length,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 口令要求：≥ 10 位，含字母与数字 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return '密码必须是字符串';
  if (password.length < 10) return '密码至少 10 位';
  if (!/[A-Za-z]/.test(password)) return '密码必须包含字母';
  if (!/[0-9]/.test(password)) return '密码必须包含数字';
  if (password.length > 128) return '密码不能超过 128 位';
  return null;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const SESSION_COOKIE = 'zhiban_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const BUSINESS_RATE_LIMIT = 120;
export const BUSINESS_RATE_WINDOW_MS = 60 * 1000;

/** 同 IP + 用户名 15 分钟 5 次失败；成功登录清零 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit = LOGIN_FAILURE_LIMIT, windowMs = LOGIN_FAILURE_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private key(ip: string, username: string): string {
    return `${ip}\u0000${username.toLowerCase()}`;
  }

  /** 返回 >0 表示还需等待的秒数 */
  retryAfterSeconds(ip: string, username: string, now: number): number {
    const key = this.key(ip, username);
    const list = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    this.failures.set(key, list);
    if (list.length < this.limit) return 0;
    const oldest = list[0]!;
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
  }

  fail(ip: string, username: string, now: number): void {
    const key = this.key(ip, username);
    const list = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    list.push(now);
    this.failures.set(key, list);
  }

  reset(ip: string, username: string): void {
    this.failures.delete(this.key(ip, username));
  }
}

/** 每账号 120 次/分钟，滑动窗口 */
export class BusinessRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit = BUSINESS_RATE_LIMIT, windowMs = BUSINESS_RATE_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  retryAfterSeconds(accountId: string, now: number): number {
    const list = (this.hits.get(accountId) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length < this.limit) {
      list.push(now);
      this.hits.set(accountId, list);
      return 0;
    }
    this.hits.set(accountId, list);
    const oldest = list[0]!;
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
  }

  reset(accountId: string): void {
    this.hits.delete(accountId);
  }
}

/** Origin 校验：无 Origin（curl / 服务端调用）时放行；有则必须与 Host 同源或在白名单 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
