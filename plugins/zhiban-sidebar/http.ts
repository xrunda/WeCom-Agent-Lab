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
import {
  SESSION_COOKIE,
  sessionCookie,
  sessionFromCookie,
  signSession,
  signState,
  verifySession,
  verifyState,
} from './session.ts';
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

/** 企微 OAuth / JS-SDK 端口；由插件注入真实客户端，测试注入假实现 */
export interface SidebarOAuthPort {
  readonly configured: boolean;
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<{ userid?: string; openid?: string }>;
  signAgentConfig(url: string): Promise<{
    corpId: string;
    agentId: string;
    timestamp: string;
    nonceStr: string;
    signature: string;
  }>;
}

export interface SidebarHttpOptions {
  api: SidebarRuntimeApi;
  /** 未配置时不放行任何请求 */
  sessionSecret?: string;
  /** 会话令牌之外的认证入口（测试或后续 OAuth 回调注入） */
  authenticate?: (req: SidebarHttpRequest) => SidebarAdvisor | undefined;
  /** 由插件在运行时组装：群绑定、患者档案、待回复 */
  buildContext: (advisor: SidebarAdvisor, query: URLSearchParams) => unknown;
  oauth?: SidebarOAuthPort;
  /** OAuth 换到 userid 后映射顾问；未开通返回 undefined */
  resolveAdvisor?: (wecomUserId: string) => SidebarAdvisor | undefined;
  /** 侧边栏公网地址；用于设置 Secure Cookie 与回调地址 */
  publicBaseUrl?: string;
  /** 会话有效期（毫秒），默认 8 小时 */
  sessionTtlMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

const MAX_BODY = 4096;
const SIDEBAR_PAGE = '/sidebar/';
const JSAPI_LIST = ['getCurExternalContact', 'getCurExternalChat'];
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;

/** 前端可上报的事件；白名单外的一律丢弃。事件只带 id，不带正文 */
export type SidebarClientEvent =
  | 'sidebar.open'
  | 'pending.view'
  | 'pending.copy_excerpt'
  | 'draft.copy';

export const SIDEBAR_CLIENT_EVENTS: readonly SidebarClientEvent[] = [
  'sidebar.open',
  'pending.view',
  'pending.copy_excerpt',
  'draft.copy',
];

function isClientEvent(value: unknown): value is SidebarClientEvent {
  return (
    typeof value === 'string' &&
    (SIDEBAR_CLIENT_EVENTS as readonly string[]).includes(value)
  );
}

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

function sendHtml(res: SidebarHttpResponse, status: number, html: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
    // 侧边栏页面只应由 nginx 自己提供，错误页不允许被嵌入
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

function sendRedirect(
  res: SidebarHttpResponse,
  location: string,
  cookie?: string,
): void {
  if (res.headersSent) return;
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...(cookie ? { 'Set-Cookie': cookie } : {}),
  });
  res.end();
}

/** 可读错误页：不出现 code、token、userid 等任何凭据或内部 id */
function errorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { margin: 0; padding: 48px 20px; font: 15px/1.6 -apple-system, "PingFang SC", sans-serif;
         color: #1f2933; background: #f7f8f8; }
  main { max-width: 360px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { margin: 0 0 20px; color: #52606d; }
  a { color: #0f766e; text-decoration: none; }
</style></head>
<body><main><h1>${title}</h1><p>${detail}</p>
<p><a href="${SIDEBAR_PAGE}">重新加载</a></p></main></body></html>`;
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

    // —— 企微 OAuth（#145）：登录前可达，只做跳转，不返回任何业务数据 ——
    if (path === '/auth/start' && method === 'GET') {
      if (!options.oauth?.configured || !options.sessionSecret || !options.publicBaseUrl) {
        sendHtml(res, 503, errorPage('侧边栏未配置', '缺少企微应用凭据或公网地址，请联系管理员。'));
        return;
      }
      sendRedirect(res, options.oauth.authorizeUrl(signState(now(), options.sessionSecret)));
      return;
    }

    if (path === '/auth/callback' && method === 'GET') {
      const secret = options.sessionSecret;
      const oauth = options.oauth;
      if (!oauth?.configured || !secret) {
        sendHtml(res, 503, errorPage('侧边栏未配置', '缺少企微应用凭据或公网地址，请联系管理员。'));
        return;
      }
      if (!verifyState(url.searchParams.get('state') ?? undefined, secret, now())) {
        sendHtml(res, 400, errorPage('登录已失效', '请从企微聊天窗口重新打开侧边栏。'));
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      if (code === '') {
        sendHtml(res, 400, errorPage('未获得授权', '企微没有返回授权码，请重新打开侧边栏。'));
        return;
      }
      let userid: string | undefined;
      try {
        userid = (await oauth.exchangeCode(code)).userid;
      } catch (error) {
        // 不记录 code / token / URL，只记录错误类型与企微 errcode
        options.log?.(`OAuth 换取成员身份失败：${describeOAuthError(error)}`);
        sendHtml(res, 502, errorPage('登录失败', '企微授权暂时不可用，请稍后重试。'));
        return;
      }
      if (!userid) {
        sendHtml(res, 403, errorPage('无法识别成员', '侧边栏只对企业成员开放，请用顾问的企业微信打开。'));
        return;
      }
      const advisor = options.resolveAdvisor?.(userid);
      if (!advisor) {
        options.log?.('OAuth 通过但成员未开通侧边栏');
        sendHtml(res, 403, errorPage('未开通侧边栏', '你的账号还没有侧边栏权限，请联系管理员开通。'));
        return;
      }
      const ttl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
      const token = signSession(
        { advisorId: advisor.id, permissions: advisor.permissions, exp: now() + ttl },
        secret,
      );
      sendRedirect(
        res,
        SIDEBAR_PAGE,
        sessionCookie(token, {
          maxAgeSeconds: Math.floor(ttl / 1000),
          secure: (options.publicBaseUrl ?? '').startsWith('https://'),
        }),
      );
      return;
    }

    const advisor = resolveAdvisor(req, options);
    if (!advisor) {
      sendJson(res, 401, { code: 'UNAUTHENTICATED', message: '登录已失效，请从企微重新打开' });
      return;
    }

    if (path === '/jsapi-config' && method === 'GET') {
      if (!options.oauth?.configured) {
        sendJson(res, 503, { code: 'OAUTH_UNAVAILABLE', message: '侧边栏登录未配置' });
        return;
      }
      const target = url.searchParams.get('url') ?? '';
      if (target === '') {
        sendJson(res, 400, { code: 'VALIDATION_FAILED', message: '缺少 url' });
        return;
      }
      try {
        const signed = await options.oauth.signAgentConfig(target);
        sendJson(res, 200, { ...signed, jsApiList: JSAPI_LIST });
      } catch (error) {
        if (isOAuthError(error)) {
          sendJson(res, error.code === 'URL_NOT_ALLOWED' ? 400 : 503, {
            code: error.code,
            message: error.message,
          });
          return;
        }
        throw error;
      }
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
      if (reason !== 'handled' && reason !== 'dismissed' && reason !== 'transferred') {
        sendJson(res, 400, {
          code: 'VALIDATION_FAILED',
          message: 'reason 只能是 handled、dismissed 或 transferred',
        });
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
      sendJson(res, 200, { ok: true, id, status: reason });
      return;
    }

    // 埋点：只收白名单事件与条目 id；正文一律不进上报
    if (path === '/events' && method === 'POST') {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { code: 'BAD_REQUEST', message: '请求体不是合法 JSON' });
        return;
      }
      const event = (body as { event?: unknown })?.event;
      if (!isClientEvent(event)) {
        sendJson(res, 400, { code: 'VALIDATION_FAILED', message: '不支持的事件' });
        return;
      }
      const rawId = (body as { itemId?: unknown })?.itemId;
      const itemId = typeof rawId === 'string' && rawId !== '' ? rawId.slice(0, 64) : undefined;
      options.api.reportEvent(event, itemId);
      sendJson(res, 200, { ok: true });
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

function isOAuthError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'WecomOAuthError'
  );
}

/** 只描述错误类型与企微 errcode，绝不拼接 URL 或 code */
function describeOAuthError(error: unknown): string {
  if (isOAuthError(error)) return `${error.code} ${error.message}`;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export { SESSION_COOKIE };
