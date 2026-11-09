/**
 * #41 路由与 HTTP 基础设施单测：路径匹配、鉴权、错误体、Cookie、幂等缓存。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConsoleError } from '../src/p1/console-error.ts';
import {
  clearCookieHeader,
  errorResponse,
  header,
  IdempotencyCache,
  jsonResponse,
  parseCookies,
  readJsonBody,
  requestIp,
  Router,
  setCookieHeader,
  type HttpRequestLike,
  type HttpResponseLike,
  type RouteContext,
} from '../plugins/zhiban-console/http.ts';

type Listener = (...args: never[]) => void;

class FakeRequest implements HttpRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket = { remoteAddress: '127.0.0.1' };
  private readonly listeners = new Map<string, Listener[]>();

  constructor(init: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
  } = {}) {
    this.method = init.method ?? 'GET';
    this.url = init.url ?? '/';
    this.headers = init.headers ?? {};
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

class FakeResponse implements HttpResponseLike {
  status = 0;
  headers: Record<string, string | number> = {};
  body = '';
  headersSent = false;

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.status = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.body += chunk.toString();
    this.headersSent = true;
    return this;
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

function buildRouter(overrides: {
  auth?: (req: HttpRequestLike) => { accountId: string } | undefined;
  authorize?: (accountId: string, permission: string) => boolean;
  rateLimit?: (accountId: string) => void;
  checkOrigin?: (req: HttpRequestLike, method: string) => void;
} = {}) {
  return new Router({
    auth: overrides.auth ?? (() => ({ accountId: 'acc_1' })),
    authorize: overrides.authorize,
    rateLimit: overrides.rateLimit,
    checkOrigin: overrides.checkOrigin,
    basePath: '/zhiban/api',
  });
}

test('Cookie 序列化包含 HttpOnly / SameSite / Max-Age，解析可还原', () => {
  const cookie = setCookieHeader('zhiban_session', 'a b+', 604_800, true);
  assert.match(cookie, /^zhiban_session=a%20b%2B; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
  const cleared = clearCookieHeader('zhiban_session', false);
  assert.match(cleared, /Max-Age=0/);
  assert.equal(cleared.includes('Secure'), false);

  const request = new FakeRequest({
    headers: { cookie: 'a=1; zhiban_session=abc%2Fdef; empty=' },
  });
  assert.deepEqual(parseCookies(request), { a: '1', zhiban_session: 'abc/def', empty: '' });
});

test('requestIp 优先 X-Forwarded-For，header 兼容数组', () => {
  const forwarded = new FakeRequest({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } });
  assert.equal(requestIp(forwarded), '203.0.113.5');
  assert.equal(requestIp(new FakeRequest()), '127.0.0.1');
  assert.equal(header(new FakeRequest({ headers: { 'x-request-id': ['a', 'b'] } }), 'x-request-id'), 'a');
});

test('Router 剥掉 /zhiban/api 前缀，匹配参数与查询串', async () => {
  const router = buildRouter();
  let captured: RouteContext | undefined;
  router.add('GET', '/alerts/:id', (ctx) => {
    captured = ctx;
    jsonResponse(ctx.res, 200, { id: ctx.params.id }, ctx.requestId);
  });

  const res = new FakeResponse();
  await router.handle(new FakeRequest({ url: '/zhiban/api/alerts/alert_9?x=1&x=2' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { id: 'alert_9' });
  assert.equal(captured?.query.getAll('x').join(','), '1,2');
  assert.match(String(res.headers['x-request-id']), /^req_/);

  // 宿主已剥前缀时也能匹配
  const stripped = new FakeResponse();
  await router.handle(new FakeRequest({ url: '/alerts/alert_10' }), stripped);
  assert.deepEqual(stripped.json(), { id: 'alert_10' });
});

test('未登录返回 401，权限不足返回 403，错误体含 requestId', async () => {
  const router = buildRouter({
    auth: () => undefined,
    authorize: () => false,
  });
  router.add('GET', '/tenant', (ctx) => jsonResponse(ctx.res, 200, {}, ctx.requestId));
  router.add('PATCH', '/tenant', (ctx) => jsonResponse(ctx.res, 200, {}, ctx.requestId), {
    permission: 'tenant.write',
  });

  const unauthenticated = new FakeResponse();
  await router.handle(new FakeRequest({ url: '/zhiban/api/tenant' }), unauthenticated);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers['cache-control'], 'no-store');
  const body = unauthenticated.json() as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, 'UNAUTHORIZED');
  assert.equal(body.error.requestId, unauthenticated.headers['x-request-id']);

  const routerWithAuth = buildRouter({ authorize: () => false });
  routerWithAuth.add('PATCH', '/tenant', (ctx) => jsonResponse(ctx.res, 200, {}, ctx.requestId), {
    permission: 'tenant.write',
  });
  const forbidden = new FakeResponse();
  await routerWithAuth.handle(new FakeRequest({ method: 'PATCH', url: '/zhiban/api/tenant' }), forbidden);
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
});

test('路径存在但方法不符返回 405，未知路径返回 404', async () => {
  const router = buildRouter();
  router.add('GET', '/alerts', (ctx) => jsonResponse(ctx.res, 200, [], ctx.requestId));

  const methodNotAllowed = new FakeResponse();
  await router.handle(new FakeRequest({ method: 'POST', url: '/zhiban/api/alerts' }), methodNotAllowed);
  assert.equal(methodNotAllowed.status, 405);
  assert.equal((methodNotAllowed.json() as { error: { code: string } }).error.code, 'METHOD_NOT_ALLOWED');

  const missing = new FakeResponse();
  await router.handle(new FakeRequest({ url: '/zhiban/api/unknown' }), missing);
  assert.equal(missing.status, 404);
  assert.equal((missing.json() as { error: { code: string } }).error.code, 'NOT_FOUND');
});

test('写操作做 Origin 校验并计入业务限流，读操作不校验 Origin', async () => {
  const calls: string[] = [];
  const router = buildRouter({
    rateLimit: (accountId) => calls.push(`rate:${accountId}`),
    checkOrigin: (_req, method) => calls.push(`origin:${method}`),
  });
  router.add('GET', '/tenant', (ctx) => jsonResponse(ctx.res, 200, {}, ctx.requestId));
  router.add('POST', '/tenant', (ctx) => jsonResponse(ctx.res, 200, {}, ctx.requestId));

  await router.handle(new FakeRequest({ url: '/zhiban/api/tenant' }), new FakeResponse());
  await router.handle(new FakeRequest({ method: 'POST', url: '/zhiban/api/tenant' }), new FakeResponse());
  assert.deepEqual(calls, ['rate:acc_1', 'rate:acc_1', 'origin:POST']);
});

test('Origin 校验抛错时返回 403 而不是 500', async () => {
  const router = buildRouter({
    checkOrigin: () => {
      throw new ConsoleError('FORBIDDEN', '来源不合法');
    },
  });
  router.add('POST', '/auth/login', (ctx) => jsonResponse(ctx.res, 200, {}, ctx.requestId), {
    auth: false,
  });
  const res = new FakeResponse();
  await router.handle(new FakeRequest({ method: 'POST', url: '/zhiban/api/auth/login' }), res);
  assert.equal(res.status, 403);
});

test('读取 JSON 体：空体为 {}，坏 JSON 与超限抛 VALIDATION_FAILED', async () => {
  const empty = new FakeRequest();
  const emptyRead = readJsonBody(empty);
  empty.emit('end');
  assert.deepEqual(await emptyRead, {});

  const bad = new FakeRequest();
  const badRead = readJsonBody(bad);
  bad.emit('data', Buffer.from('{oops'));
  bad.emit('end');
  await assert.rejects(
    () => badRead,
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );

  const huge = new FakeRequest();
  const hugeRead = readJsonBody(huge, 4);
  huge.emit('data', Buffer.from('{"a":1}'));
  huge.emit('end');
  await assert.rejects(
    () => hugeRead,
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
});

test('未知异常统一返回 INTERNAL，不泄漏堆栈', async () => {
  const res = new FakeResponse();
  errorResponse(res, new Error('数据库密码是 hunter2'), 'req_test');
  assert.equal(res.status, 500);
  const body = res.json() as { error: { code: string; message: string; requestId: string } };
  assert.equal(body.error.code, 'INTERNAL');
  assert.equal(body.error.message, '服务器内部错误');
  assert.equal(res.body.includes('hunter2'), false);
});

test('IdempotencyCache 10 分钟内命中，过期后失效', () => {
  const cache = new IdempotencyCache(10 * 60 * 1000);
  const now = 1_000;
  assert.equal(cache.get('k1', now), undefined);
  cache.set('k1', now, 202, { ok: true }, { 'x-test': '1' });
  assert.deepEqual(cache.get('k1', now + 59_000), {
    status: 202,
    body: { ok: true },
    headers: { 'x-test': '1' },
  });
  assert.equal(cache.get('k1', now + 10 * 60 * 1000), undefined);
  assert.equal(cache.get('k1', now + 10 * 60 * 1000 + 1), undefined);
});
