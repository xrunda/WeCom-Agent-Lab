/**
 * 患者端 H5 HTTP 接口（PH5-02 #231，契约 docs/PATIENT-H5-api.md §1–§3、§11）。
 *
 * 挂在 `/zhiban/h5` 前缀，由宿主 webServer 转发；不复用控制台会话
 * （`zhiban_session`）或侧边栏令牌（`zb_sidebar`）——患者与员工身份隔离。
 *
 * 隐私红线：日志与错误响应不含手机号、验证码、令牌、邀请 code；
 * 审计 detail 只含 id 与枚举（数据模型 §1.5）。
 */
import { BusinessRateLimiter, isOriginAllowed } from '../../src/p1/console-auth.ts';
import { H5Error } from '../../src/p1/patient-h5.ts';
import type {
  ConsentScope,
  PatientH5Service,
  SessionView,
} from '../../src/p1/patient-h5.ts';

export interface H5HttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data' | 'end' | 'error', listener: (...args: never[]) => void): unknown;
  destroy?(error?: Error): void;
}

export interface H5HttpResponse {
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  end(chunk?: string): unknown;
}

export interface H5WebServer {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: H5HttpRequest, res: H5HttpResponse) => unknown;
  }): unknown;
}

export const H5_SESSION_COOKIE = 'zb_h5_session';

export interface PatientH5HttpOptions {
  service: PatientH5Service;
  allowedOrigins: string[];
  /** 会话 Cookie 是否带 Secure；生产必须为 true（明文站点才关闭） */
  cookieSecure?: boolean;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * 域路由扩展（PH5-03 起，契约 §7.1 路径归属的装配点）：
   * 每个扩展处理自己的路径，返回 true 表示已响应。
   * 内置路由未命中时依次调用；错误统一按 §1.5 格式输出。
   */
  extensions?: H5RouteExtension[];
  /** /me 状态组合钩子（PH5-03 建档、PH5-04 计划注入状态） */
  composeMe?: (view: SessionView) => {
    status: string;
    profile: { completeness: number; safetyMissing: boolean; conflicts: unknown[] };
    /** 陪伴天数；缺省时 /me 返回 null */
    companionDays?: number | null;
  };
}

/** 域路由扩展的上下文：内置鉴权/响应工具复用，扩展不重造轮子 */
export interface H5RouteContext {
  method: string;
  path: string;
  query: URLSearchParams;
  requestId: string;
  /** Idempotency-Key 请求头（可选）；域路由自行决定是否使用 */
  idempotencyKey?: string;
  service: PatientH5Service;
  readJson(): Promise<Record<string, unknown>>;
  /** 读取原始请求体（图片上传用）；超过上限抛 VALIDATION_FAILED */
  readRawBody(maxBytes?: number): Promise<Buffer>;
  requireSession(): Promise<SessionView>;
  checkOrigin(): void;
  ok(status: number, body: unknown, extra?: Record<string, string | number>): void;
  fail(error: H5Error): void;
}

export type H5RouteExtension = (req: H5HttpRequest, res: H5HttpResponse, ctx: H5RouteContext) => Promise<boolean>;

const MAX_BODY = 16 * 1024;
const SESSION_RATE_LIMIT = 60;

function sendJson(
  res: H5HttpResponse,
  status: number,
  body: unknown,
  extra: Record<string, string | number> = {},
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function readRaw(req: H5HttpRequest, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy?.(new Error('BODY_TOO_LARGE'));
        reject(new H5Error('VALIDATION_FAILED', '上传内容过大'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error: Error) => reject(error));
  });
}

function readBody(req: H5HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy?.(new Error('BODY_TOO_LARGE'));
        reject(new H5Error('VALIDATION_FAILED', '请求体过大'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error: Error) => reject(error));
  });
}

async function readJson(req: H5HttpRequest): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new H5Error('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  } catch (error) {
    if (error instanceof H5Error) throw error;
    throw new H5Error('VALIDATION_FAILED', '请求体不是合法 JSON');
  }
}

function cookieValue(req: H5HttpRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function sessionCookieHeader(token: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${H5_SESSION_COOKIE}=${token}; Path=/zhiban/h5; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookieHeader(secure: boolean): string {
  return (
    `${H5_SESSION_COOKIE}=; Path=/zhiban/h5; HttpOnly; SameSite=Lax; Max-Age=0` +
    (secure ? '; Secure' : '')
  );
}

function headerValue(req: H5HttpRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestIdOf(req: H5HttpRequest): string {
  return headerValue(req, 'x-request-id') ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function ipOf(req: H5HttpRequest): string {
  return (headerValue(req, 'x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
}

function userAgentSummary(req: H5HttpRequest): string | undefined {
  const ua = headerValue(req, 'user-agent');
  if (!ua) return undefined;
  if (/iPhone|iPad/i.test(ua)) return /MicroMessenger/i.test(ua) ? 'iOS/WeChat' : 'iOS';
  if (/Android/i.test(ua)) return /MicroMessenger/i.test(ua) ? 'Android/WeChat' : 'Android';
  return 'Other';
}

function errorBody(error: H5Error, requestId: string): unknown {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId,
    },
  };
}

export function registerPatientH5Http(
  webServer: H5WebServer,
  options: PatientH5HttpOptions,
): unknown {
  const now = options.now ?? Date.now;
  const limiter = new BusinessRateLimiter(SESSION_RATE_LIMIT, 60 * 1000);
  const secureCookie = options.cookieSecure ?? true;

  return webServer.register({
    kind: 'prefix',
    path: '/zhiban/h5',
    handler: (req, res) => {
      void handle(req, res).catch((error: unknown) => {
        const requestId = requestIdOf(req);
        // 未预期错误：只记错误类型，不带任何请求内容
        options.log?.(`请求处理失败：${error instanceof Error ? error.name : 'UNKNOWN'}`);
        if (error instanceof H5Error) {
          sendJson(res, error.status, errorBody(error, requestId));
          return;
        }
        sendJson(res, 500, errorBody(new H5Error('INTERNAL', '服务暂时不可用'), requestId));
      });
    },
  });

  async function requireSession(
    req: H5HttpRequest,
    sessionOptions: { requireServiceBasic?: boolean } = {},
  ): Promise<SessionView> {
    const token = cookieValue(req, H5_SESSION_COOKIE);
    const resolved = await options.service.resolveSession(token);
    if (!resolved) {
      throw new H5Error('UNAUTHORIZED', '未登录或会话已过期');
    }
    const retryAfter = limiter.retryAfterSeconds(resolved.session.id, now());
    if (retryAfter > 0) {
      throw new H5Error('RATE_LIMITED', '请求过频，请稍后再试');
    }
    // 契约 §6.2：个人数据需要 service_basic 授权；授权页与隐私入口本身不设此门
    if (sessionOptions.requireServiceBasic !== false) {
      const status = options.service.consentStatus(resolved.session.patientId, 'service_basic');
      if (status !== 'granted') {
        throw new H5Error('CONSENT_REQUIRED', '需要先开启「进入个人服务」授权', [
          { field: 'scope', issue: 'service_basic' },
        ]);
      }
    }
    return resolved;
  }

  function checkOrigin(req: H5HttpRequest): void {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return;
    const origin = headerValue(req, 'origin');
    const host = headerValue(req, 'host');
    if (!isOriginAllowed(origin, host, options.allowedOrigins)) {
      throw new H5Error('FORBIDDEN', '来源不被允许');
    }
  }

  async function handle(req: H5HttpRequest, res: H5HttpResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://h5.local');
    const path = url.pathname.replace(/^\/zhiban\/h5/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const requestId = requestIdOf(req);

    const fail = (error: H5Error): void => {
      sendJson(res, error.status, errorBody(error, requestId), { 'X-Request-Id': requestId });
    };
    const ok = (status: number, body: unknown, extra: Record<string, string | number> = {}): void => {
      sendJson(res, status, body, { 'X-Request-Id': requestId, ...extra });
    };

    // ---------- 公开接口 ----------
    if (path === '/health' && method === 'GET') {
      ok(200, { ok: true, at: now() });
      return;
    }
    if (path === '/server-time' && method === 'GET') {
      ok(200, { serverTime: now(), timezone: 'Asia/Shanghai' });
      return;
    }

    if (path === '/auth/verify-code' && method === 'POST') {
      checkOrigin(req);
      try {
        const body = await readJson(req);
        const result = await options.service.requestVerifyCode({
          ...(typeof body.invitationCode === 'string' ? { invitationCode: body.invitationCode } : {}),
          ...(typeof body.phone === 'string' ? { phone: body.phone } : {}),
        });
        ok(202, result);
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/auth/redeem' && method === 'POST') {
      checkOrigin(req);
      try {
        const body = await readJson(req);
        const ua = userAgentSummary(req);
        const result = await options.service.redeem({
          invitationCode: String(body.invitationCode ?? ''),
          phone: String(body.phone ?? ''),
          code: String(body.code ?? ''),
          ...(ua ? { userAgentSummary: ua } : {}),
        });
        const maxAge = Math.floor((result.session.expiresAt - now()) / 1000);
        ok(
          200,
          {
            session: {
              patientId: result.session.patientId,
              issuedAt: result.session.issuedAt,
              expiresAt: result.session.expiresAt,
            },
            binding: { phoneTail: result.binding.phoneTail, boundAt: result.binding.boundAt },
            me: { status: result.meStatus },
          },
          { 'Set-Cookie': sessionCookieHeader(result.sessionToken, maxAge, secureCookie) },
        );
        // 邀请兑换成功后前端清理 URL；code 不进日志
        options.log?.(`邀请兑换成功：ip=${ipOf(req)}`);
      } catch (error) {
        if (error instanceof H5Error) {
          // 兑换失败只记错误码，不记手机号与 code
          options.log?.(`邀请兑换失败：code=${error.code} ip=${ipOf(req)}`);
          fail(error);
        } else throw error;
      }
      return;
    }

    if (path === '/auth/login' && method === 'POST') {
      checkOrigin(req);
      try {
        const body = await readJson(req);
        const ua = userAgentSummary(req);
        const result = await options.service.login({
          phone: String(body.phone ?? ''),
          code: String(body.code ?? ''),
          ...(ua ? { userAgentSummary: ua } : {}),
        });
        const maxAge = Math.floor((result.session.expiresAt - now()) / 1000);
        ok(
          200,
          {
            session: {
              patientId: result.session.patientId,
              issuedAt: result.session.issuedAt,
              expiresAt: result.session.expiresAt,
            },
            binding: { phoneTail: result.binding.phoneTail, boundAt: result.binding.boundAt },
            me: { status: result.meStatus },
          },
          { 'Set-Cookie': sessionCookieHeader(result.sessionToken, maxAge, secureCookie) },
        );
      } catch (error) {
        if (error instanceof H5Error) {
          options.log?.(`患者登录失败：code=${error.code} ip=${ipOf(req)}`);
          fail(error);
        } else throw error;
      }
      return;
    }

    // ---------- 需要患者会话 ----------
    if (path === '/auth/logout' && method === 'POST') {
      checkOrigin(req);
      const token = cookieValue(req, H5_SESSION_COOKIE);
      if (token) await options.service.logout(token);
      ok(204, '', { 'Set-Cookie': clearSessionCookieHeader(secureCookie) });
      return;
    }

    if (path === '/auth/session' && method === 'GET') {
      try {
        const view = await requireSession(req, { requireServiceBasic: false });
        ok(200, {
          patientId: view.session.patientId,
          issuedAt: view.session.issuedAt,
          expiresAt: view.session.expiresAt,
          lastSeenAt: view.session.lastSeenAt,
        });
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/me' && method === 'GET') {
      try {
        const view = await requireSession(req);
        const composed = options.composeMe?.(view) ?? {
          status: options.service.meStatus(view.patient),
          profile: { completeness: 0, safetyMissing: false, conflicts: [] },
        };
        ok(200, {
          status: composed.status,
          displayName: view.patient.displayName ?? null,
          profile: composed.profile,
          plan: null,
          team: view.patient.advisorId ? { advisorId: view.patient.advisorId } : null,
          reminderEnabled: options.service.consentStatus(view.session.patientId, 'reminder') === 'granted',
          companionDays: composed.companionDays ?? null,
          serverTime: now(),
        });
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/consents' && method === 'GET') {
      try {
        const view = await requireSession(req, { requireServiceBasic: false });
        ok(200, options.service.consentOverview(view.session.patientId));
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/consents/decide' && method === 'POST') {
      checkOrigin(req);
      try {
        const view = await requireSession(req, { requireServiceBasic: false });
        const body = await readJson(req);
        const scope = String(body.scope ?? '') as ConsentScope;
        const action = body.action === 'grant' || body.action === 'withdraw' ? body.action : null;
        if (!action) {
          throw new H5Error('VALIDATION_FAILED', 'action 只能是 grant 或 withdraw', [
            { field: 'action', issue: 'invalid' },
          ]);
        }
        const result = await options.service.decideConsent({
          patientId: view.session.patientId,
          scope,
          action,
          decidedVia: view.session.id,
        });
        // service_basic 撤回会撤销当前会话：清 Cookie
        const cleared =
          scope === 'service_basic' && action === 'withdraw' && result.changed;
        ok(
          200,
          { scope: result.record.scope, status: result.record.status, version: result.record.version },
          cleared ? { 'Set-Cookie': clearSessionCookieHeader(secureCookie) } : {},
        );
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/privacy/summary' && method === 'GET') {
      try {
        const view = await requireSession(req, { requireServiceBasic: false });
        ok(200, options.service.privacySummary(view.session.patientId));
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/privacy/requests' && method === 'POST') {
      checkOrigin(req);
      try {
        const view = await requireSession(req, { requireServiceBasic: false });
        const body = await readJson(req);
        const idempotencyKey = headerValue(req, 'idempotency-key') ?? undefined;
        const record = await options.service.createPrivacyRequest({
          patientId: view.session.patientId,
          kind: ((): 'export' | 'correction' | 'deletion' => {
            if (body.kind === 'export' || body.kind === 'correction' || body.kind === 'deletion') {
              return body.kind;
            }
            throw new H5Error('VALIDATION_FAILED', 'kind 非法', [
              { field: 'kind', issue: 'invalid' },
            ]);
          })(),
          ...(typeof body.targetType === 'string' ? { targetType: body.targetType } : {}),
          ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : {}),
          detail: String(body.detail ?? ''),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        ok(201, record);
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    if (path === '/events' && method === 'POST') {
      checkOrigin(req);
      try {
        const view = await requireSession(req, { requireServiceBasic: false });
        const body = await readJson(req);
        await options.service.recordEvent(
          view.session.patientId,
          String(body.event ?? ''),
          typeof body.itemId === 'string' ? body.itemId : undefined,
          typeof body.durationMs === 'number' ? { durationMs: body.durationMs } : undefined,
        );
        ok(200, { ok: true });
      } catch (error) {
        if (error instanceof H5Error) fail(error);
        else throw error;
      }
      return;
    }

    // ---------- 域路由扩展（PH5-03 起：profile / plan / calendar / ...） ----------
    if (options.extensions?.length) {
      const routeCtx: H5RouteContext = {
        method,
        path,
        query: url.searchParams,
        requestId,
        ...(headerValue(req, 'idempotency-key')
          ? { idempotencyKey: headerValue(req, 'idempotency-key')! }
          : {}),
        service: options.service,
        readJson: () => readJson(req),
        readRawBody: (maxBytes) => readRaw(req, maxBytes ?? MAX_BODY),
        requireSession: () => requireSession(req),
        checkOrigin: () => checkOrigin(req),
        ok: (status, body, extra) => ok(status, body, extra),
        fail: (error) => fail(error),
      };
      for (const extension of options.extensions) {
        let handled = false;
        try {
          handled = await extension(req, res, routeCtx);
        } catch (error) {
          if (error instanceof H5Error) {
            fail(error);
            return;
          }
          throw error;
        }
        if (handled) return;
      }
    }

    // 未匹配路由
    fail(new H5Error('NOT_FOUND', '接口不存在'));
  }
}
