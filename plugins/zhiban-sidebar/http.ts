/**
 * 侧边栏 HTTP 接口（#147）。
 *
 * 挂在 `/zhiban/sidebar` 前缀下，由宿主 webServer 转发；不复用控制台
 * 的管理员会话，也不进控制台路由，避免把顾问入口做成后台接口。
 *
 * 认证：Cookie 里的签名令牌（由 #145 的企微 OAuth 回调签发）。
 * 未配置 Secret 时一律 401：宁可打不开，也不能裸奔。
 */
import type { SidebarRuntimeApi } from './index.ts';
import { SESSION_COOKIE, sessionFromCookie, verifySession } from './session.ts';
import type { SidebarAdvisor } from '../../src/p1/sidebar-view.ts';

export interface SidebarHttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data' | 'end' | 'error', listener: (...args: never[]) => void): unknown;
  destroy?(error?: Error): void;
}

export interface SidebarHttpResponse {
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  end(chunk?: string): unknown;
}

export interface SidebarWebServer {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: SidebarHttpRequest, res: SidebarHttpResponse) => unknown;
  }): unknown;
}

export interface SidebarHttpOptions {
  api: SidebarRuntimeApi;
  /** 未配置时不放行任何请求 */
  sessionSecret?: string;
  /** 会话令牌之外的认证入口（测试或后续 OAuth 回调注入） */
  authenticate?: (req: SidebarHttpRequest) => SidebarAdvisor | undefined;
  /** 由插件在运行时组装：群绑定、患者档案、待回复 */
  buildContext: (advisor: SidebarAdvisor, query: URLSearchParams) => unknown;
  now?: () => number;
}

const MAX_BODY = 4096;

function sendJson(
  res: SidebarHttpResponse,
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

function readBody(req: SidebarHttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy?.(new Error('BODY_TOO_LARGE'));
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error: Error) => reject(error));
  });
}

function parseCookies(req: SidebarHttpRequest): string | undefined {
  return sessionFromCookie(req.headers.cookie) ??
    (typeof req.headers['x-sidebar-session'] === 'string'
      ? req.headers['x-sidebar-session']
      : undefined);
}

function resolveAdvisor(
  req: SidebarHttpRequest,
  options: SidebarHttpOptions,
): SidebarAdvisor | undefined {
  const injected = options.authenticate?.(req);
  if (injected) return injected;
  if (!options.sessionSecret) return undefined;
  const payload = verifySession(parseCookies(req), options.sessionSecret, options.now?.() ?? Date.now());
  return payload ? { id: payload.advisorId, permissions: payload.permissions } : undefined;
}

export function registerSidebarHttp(webServer: SidebarWebServer, options: SidebarHttpOptions): unknown {
  const now = options.now ?? (() => Date.now());

  return webServer.register({
    kind: 'prefix',
    path: '/zhiban/sidebar',
    handler: (req, res) => {
      void handle(req, res).catch(() => {
        sendJson(res, 500, { code: 'INTERNAL', message: '服务暂时不可用' });
      });
    },
  });

  async function handle(req: SidebarHttpRequest, res: SidebarHttpResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sidebar.local');
    const path = url.pathname.replace(/^\/zhiban\/sidebar/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === '/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, at: now() });
      return;
    }

    const advisor = resolveAdvisor(req, options);
    if (!advisor) {
      sendJson(res, 401, { code: 'UNAUTHENTICATED', message: '登录已失效，请从企微重新打开' });
      return;
    }

    if (path === '/context' && method === 'GET') {
      // 只接受 chatId / externalUserId；roomId 只允许内部关闭路径反查
      const params = new URLSearchParams();
      const chatId = url.searchParams.get('chatId');
      const externalUserId = url.searchParams.get('externalUserId');
      if (chatId) params.set('chatId', chatId);
      if (externalUserId) params.set('externalUserId', externalUserId);
      try {
        sendJson(res, 200, options.buildContext(advisor, params));
      } catch (error) {
        if (isAccessError(error)) {
          sendJson(res, 403, { code: error.code, message: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const closeMatch = /^\/pending\/([^/]+)\/close$/.exec(path);
    if (closeMatch && method === 'POST') {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { code: 'BAD_REQUEST', message: '请求体不是合法 JSON' });
        return;
      }
      const reason = (body as { reason?: unknown })?.reason;
      if (reason !== 'dismissed' && reason !== 'transferred') {
        sendJson(res, 400, { code: 'VALIDATION_FAILED', message: 'reason 只能是 dismissed 或 transferred' });
        return;
      }
      const id = decodeURIComponent(closeMatch[1]!);
      const item = options.api.get(id);
      if (!item) {
        sendJson(res, 404, { code: 'NOT_FOUND', message: '待回复条目不存在' });
        return;
      }
      try {
        options.buildContext(advisor, new URLSearchParams(itemQuery(item.convKey)));
      } catch (error) {
        if (isAccessError(error)) {
          sendJson(res, 403, { code: error.code, message: error.message });
          return;
        }
        throw error;
      }
      options.api.close(id, reason, advisor.id);
      sendJson(res, 200, { ok: true, id });
      return;
    }

    sendJson(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });
  }
}

/** 用会话键反查 context，确保关闭动作也走同一条权限判断 */
function itemQuery(convKey: string): Array<[string, string]> {
  if (convKey.startsWith('room:')) return [['roomId', convKey.slice('room:'.length)]];
  return [];
}

function isAccessError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'SidebarAccessError'
  );
}

export { SESSION_COOKIE };
