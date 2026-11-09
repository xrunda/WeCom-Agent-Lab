/**
 * #41 极简 HTTP 路由：挂在 `/zhiban/api` 前缀下，不依赖框架。
 *
 * 负责：方法 + 路径匹配、Cookie 解析、JSON 读取、统一错误体、
 * X-Request-Id、Cache-Control、Idempotency-Key 缓存。
 * 认证 / 鉴权 / 限流由 index.ts 注入，路由本身不碰业务。
 */
import { randomUUID } from 'node:crypto';

import { ConsoleError } from '../../src/p1/console-error.ts';

export interface HttpRequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  on(event: 'data' | 'end' | 'error' | 'close', listener: (...args: never[]) => void): unknown;
  destroy?(error?: Error): void;
}

export interface HttpResponseLike {
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  write(chunk: string | Buffer): boolean;
  end(chunk?: string | Buffer): unknown;
  on?(event: 'close' | 'error', listener: (...args: never[]) => void): unknown;
  destroy?(error?: Error): void;
}

export interface RouteContext {
  req: HttpRequestLike;
  res: HttpResponseLike;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  ip: string;
  json<T = Record<string, unknown>>(): Promise<T>;
  rawBody(): Promise<Buffer>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface RouteOptions {
  /** 默认 true；login 等公开接口设 false */
  auth?: boolean;
  permission?: string;
}

interface RouteEntry extends RouteOptions {
  method: string;
  segments: string[];
  handler: RouteHandler;
  pattern: string;
}

export interface RouterOptions {
  auth: (req: HttpRequestLike) => { accountId: string } | undefined;
  authorize?: (accountId: string, permission: string) => boolean;
  rateLimit?: (accountId: string) => void;
  checkOrigin?: (req: HttpRequestLike, method: string) => void;
  /** 挂载前缀；req.url 带前缀时先剥掉，兼容宿主是否重写路径 */
  basePath?: string;
}

export function header(req: HttpRequestLike, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseCookies(req: HttpRequestLike): Record<string, string> {
  const raw = header(req, 'cookie');
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export function setCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader(name: string, secure: boolean): string {
  return setCookieHeader(name, '', 0, secure);
}

export function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const parsed = new URL(url, 'http://localhost');
  return { path: parsed.pathname.replace(/\/+$/, '') || '/', query: parsed.searchParams };
}

export function requestIp(req: HttpRequestLike): string {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? '127.0.0.1';
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function jsonResponse(
  res: HttpResponseLike,
  status: number,
  value: unknown,
  requestId: string,
  extraHeaders: Record<string, string | number> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

export function emptyResponse(
  res: HttpResponseLike,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string | number> = {},
): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end();
}

export function errorResponse(
  res: HttpResponseLike,
  error: unknown,
  requestId: string,
): void {
  const consoleError =
    error instanceof ConsoleError
      ? error
      : new ConsoleError('INTERNAL', '服务器内部错误');
  jsonResponse(
    res,
    consoleError.status,
    {
      error: {
        code: consoleError.code,
        message: consoleError.message,
        ...(consoleError.details ? { details: consoleError.details } : {}),
        requestId,
      },
    },
    requestId,
    consoleError.code === 'RATE_LIMITED' || consoleError.code === 'LIMIT_EXCEEDED'
      ? { 'retry-after': '60' }
      : {},
  );
}

/** 读原始请求体，超过上限抛 VALIDATION_FAILED */
export function readRawBody(req: HttpRequestLike, maxBytes = 1 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', ((chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        fail(new ConsoleError('VALIDATION_FAILED', '请求体过大'));
        return;
      }
      chunks.push(buffer);
    }) as never);
    req.on('end', (() => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    }) as never);
    req.on('error', ((error: Error) => fail(error)) as never);
  });
}

export async function readJsonBody<T = Record<string, unknown>>(
  req: HttpRequestLike,
  maxBytes = 1024 * 1024,
): Promise<T> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new ConsoleError('VALIDATION_FAILED', '请求体必须是合法 JSON');
  }
}

/** 10 分钟幂等缓存；只对写操作使用 */
export class IdempotencyCache {
  private readonly entries = new Map<
    string,
    { at: number; status: number; body: unknown; headers: Record<string, string | number> }
  >();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(
    key: string,
    now: number,
  ): { status: number; body: unknown; headers: Record<string, string | number> } | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    if (now - found.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return { status: found.status, body: found.body, headers: found.headers };
  }

  set(
    key: string,
    now: number,
    status: number,
    body: unknown,
    headers: Record<string, string | number> = {},
  ): void {
    this.entries.set(key, { at: now, status, body, headers });
  }
}

export class Router {
  private readonly routes: RouteEntry[] = [];
  private readonly options: RouterOptions;

  constructor(options: RouterOptions) {
    this.options = options;
  }

  add(method: string, pattern: string, handler: RouteHandler, options: RouteOptions = {}): this {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments,
      handler,
      auth: options.auth ?? true,
      permission: options.permission,
    });
    return this;
  }

  async handle(req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
    const requestId = header(req, 'x-request-id') ?? newRequestId();
    const { path: fullPath, query } = parseQuery(req.url ?? '/');
    const base = this.options.basePath?.replace(/\/+$/, '');
    const path =
      base && (fullPath === base || fullPath.startsWith(`${base}/`))
        ? fullPath.slice(base.length) || '/'
        : fullPath;
    const parts = path.split('/').filter(Boolean);
    const method = (req.method ?? 'GET').toUpperCase();

    let matchedPath = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      matchedPath = true;
      if (route.method !== method) continue;

      const ctx: RouteContext = {
        req,
        res,
        params,
        query,
        requestId,
        ip: requestIp(req),
        json: <T>() => readJsonBody<T>(req),
        rawBody: () => readRawBody(req),
      };

      try {
        if (route.auth) {
          const session = this.options.auth(req);
          if (!session) throw new ConsoleError('UNAUTHORIZED', '未登录或会话已过期');
          if (
            route.permission &&
            !this.options.authorize?.(session.accountId, route.permission)
          ) {
            throw new ConsoleError('FORBIDDEN', '当前角色无权执行该操作');
          }
          this.options.rateLimit?.(session.accountId);
        }
        if (method !== 'GET' && method !== 'HEAD') {
          this.options.checkOrigin?.(req, method);
        }
        await route.handler(ctx);
      } catch (error) {
        if (res.headersSent) {
          res.destroy?.(error instanceof Error ? error : undefined);
          return;
        }
        errorResponse(res, error, requestId);
      }
      return;
    }

    if (matchedPath) {
      errorResponse(res, new ConsoleError('METHOD_NOT_ALLOWED', '方法不允许'), requestId);
      return;
    }
    errorResponse(res, new ConsoleError('NOT_FOUND', '接口不存在'), requestId);
  }
}

function matchSegments(pattern: string[], path: string[]): Record<string, string> | undefined {
  if (pattern.length !== path.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    const actual = path[index]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}
