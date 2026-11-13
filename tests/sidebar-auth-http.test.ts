/**
 * #145 侧边栏登录链路：OAuth 跳转、回调签会话、JS-SDK 签名端点的权限。
 * 用假 webServer 与假 OAuth 端口，不接触企微。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PendingItem } from '../src/p1/sidebar.ts';
import { buildSidebarContext } from '../src/p1/sidebar-view.ts';
import type { SidebarViewDeps } from '../src/p1/sidebar-view.ts';
import { registerSidebarHttp } from '../plugins/zhiban-sidebar/http.ts';
import type { SidebarOAuthPort } from '../plugins/zhiban-sidebar/http.ts';
import { SESSION_COOKIE, sessionFromCookie, signState } from '../plugins/zhiban-sidebar/session.ts';
import type { SidebarRuntimeApi } from '../plugins/zhiban-sidebar/index.ts';

const NOW = 1_700_000_000_000;
const SECRET = 'test-secret';
const BASE = 'https://zhiban.example.com';

const item: PendingItem = {
  id: 'pend_1',
  convKey: 'room:room_1',
  kind: 'group',
  roomId: 'room_1',
  customerId: 'wm_a',
  firstAt: NOW - 60_000,
  lastAt: NOW - 60_000,
  messageCount: 1,
  excerpt: '明天几点复诊？',
  reason: 'question',
  status: 'open',
};

function api(): SidebarRuntimeApi {
  return {
    observe: () => ({ closed: [] }),
    openItems: () => [item],
    recentlyClosed: () => [],
    get: (id) => (id === item.id ? item : undefined),
    lastObservedAt: () => NOW,
    close: () => item,
    reportEvent: () => {},
    allItems: () => [item],
    prune: () => {},
    flush: async () => {},
  };
}

const viewDeps: SidebarViewDeps = {
  openItems: () => [item],
  recentlyClosed: () => [],
  lastObservedAt: () => NOW,
  listGroups: () => [
    { roomId: 'room_1', chatId: 'chat_1', name: '高血压管理 1 群', advisorId: 'adv_1' },
  ],
  patientIdsForRoom: () => ['pat_1'],
  getPatient: () => ({
    id: 'pat_1',
    displayName: '王阿姨',
    tags: [],
    consent: 'agreed',
    identityStatus: 'confirmed',
    lastActiveAt: NOW,
  }),
  patientNameFor: () => '王阿姨',
  getAdvisorName: () => '李医生',
  now: () => NOW,
};

interface Result {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  json(): any;
}

interface Booted {
  call(options: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
  }): Promise<Result>;
  logs: string[];
}

function boot(
  overrides: {
    oauth?: SidebarOAuthPort;
    resolveAdvisor?: (wecomUserId: string) => { id: string; permissions: string[] } | undefined;
  } = {},
): Booted {
  const routes: Array<{ handler: (req: never, res: never) => unknown }> = [];
  const logs: string[] = [];
  const oauth: SidebarOAuthPort =
    overrides.oauth ??
    {
      configured: true,
      authorizeUrl: (state) => `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`,
      exchangeCode: async (code) => (code === 'good' ? { userid: 'zhang.guwen' } : { openid: 'x' }),
      signAgentConfig: async () => ({
        corpId: 'corp_test',
        agentId: '1000212',
        timestamp: '1700000000',
        nonceStr: 'nonce',
        signature: 'sig',
      }),
    };

  registerSidebarHttp(
    {
      register: (route) => {
        routes.push(route);
        return undefined;
      },
    },
    {
      api: api(),
      sessionSecret: SECRET,
      publicBaseUrl: BASE,
      sessionTtlMs: 60 * 60_000,
      now: () => NOW,
      oauth,
      resolveAdvisor: overrides.resolveAdvisor ?? ((userid) =>
        userid === 'zhang.guwen' ? { id: 'adv_1', permissions: ['patient.read'] } : undefined),
      log: (line) => logs.push(line),
      buildContext: (advisor, query) =>
        buildSidebarContext(viewDeps, advisor, {
          ...(query.get('chatId') ? { chatId: query.get('chatId')! } : {}),
        }),
    },
  );

  return {
    logs,
    call: (options) =>
      new Promise<Result>((resolve) => {
        const listeners = new Map<string, Array<(arg: unknown) => void>>();
        const req = {
          method: options.method ?? 'GET',
          url: options.url,
          headers: options.headers ?? {},
          on(event: string, listener: (arg: unknown) => void) {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return req;
          },
          destroy() {},
        };
        const res = {
          headersSent: false,
          status: 0,
          headers: {} as Record<string, string | number>,
          writeHead(status: number, headers: Record<string, string | number>) {
            this.status = status;
            this.headers = headers;
            this.headersSent = true;
            return this;
          },
          end(chunk?: string) {
            const body = chunk ?? '';
            resolve({
              status: this.status,
              headers: this.headers,
              body,
              json: () => JSON.parse(body),
            });
          },
        };
        void routes[0]!.handler(req as never, res as never);
        setImmediate(() => {
          for (const listener of listeners.get('end') ?? []) listener(undefined);
        });
      }),
  };
}

test('未登录先跳企微授权，地址带签名 state', async () => {
  const h = boot();
  const result = await h.call({ url: '/zhiban/sidebar/auth/start' });
  assert.equal(result.status, 302);
  const location = String(result.headers.Location);
  assert.ok(location.startsWith('https://open.weixin.qq.com/'));
  assert.ok(location.includes('state='));
  assert.equal(result.headers['Set-Cookie'], undefined);
});

test('回调成功签发 HttpOnly 会话，随后能取首屏数据', async () => {
  const h = boot();
  const state = signState(NOW, SECRET);
  const callback = await h.call({
    url: `/zhiban/sidebar/auth/callback?code=good&state=${encodeURIComponent(state)}`,
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.Location, '/sidebar/');
  const cookie = String(callback.headers['Set-Cookie']);
  assert.ok(cookie.includes(`${SESSION_COOKIE}=`));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('Secure'));
  assert.ok(cookie.includes('SameSite=Lax'));

  const token = sessionFromCookie(cookie);
  const context = await h.call({
    url: '/zhiban/sidebar/context?chatId=chat_1',
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token!)}` },
  });
  assert.equal(context.status, 200);
  assert.equal(context.json().conv.name, '高血压管理 1 群');
});

test('state 过期或不合法时拒绝回调', async () => {
  const h = boot();
  const expired = signState(NOW - 60 * 60_000, SECRET);
  const result = await h.call({
    url: `/zhiban/sidebar/auth/callback?code=good&state=${encodeURIComponent(expired)}`,
  });
  assert.equal(result.status, 400);
  assert.ok(result.body.includes('登录已失效'));
});

test('非企业成员与未开通顾问都拿不到会话', async () => {
  const h = boot();
  const state = signState(NOW, SECRET);

  const external = await h.call({
    url: `/zhiban/sidebar/auth/callback?code=openid_only&state=${encodeURIComponent(state)}`,
  });
  assert.equal(external.status, 403);
  assert.equal(external.headers['Set-Cookie'], undefined);

  const unknown = await boot({
    oauth: {
      configured: true,
      authorizeUrl: () => 'https://open.weixin.qq.com/x',
      exchangeCode: async () => ({ userid: 'someone.else' }),
      signAgentConfig: async () => ({
        corpId: 'c', agentId: '1', timestamp: '1', nonceStr: 'n', signature: 's',
      }),
    },
  }).call({ url: `/zhiban/sidebar/auth/callback?code=good&state=${encodeURIComponent(state)}` });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.headers['Set-Cookie'], undefined);
});

test('换 code 失败返回 502，日志不含 code', async () => {
  const h = boot({
    oauth: {
      configured: true,
      authorizeUrl: () => 'https://open.weixin.qq.com/x',
      exchangeCode: async () => {
        const error = new Error('token failed');
        error.name = 'WecomOAuthError';
        throw error;
      },
      signAgentConfig: async () => ({
        corpId: 'c', agentId: '1', timestamp: '1', nonceStr: 'n', signature: 's',
      }),
    },
  });
  const state = signState(NOW, SECRET);
  const result = await h.call({
    url: `/zhiban/sidebar/auth/callback?code=SECRETCODE&state=${encodeURIComponent(state)}`,
  });
  assert.equal(result.status, 502);
  assert.ok(!result.body.includes('SECRETCODE'));
  assert.ok(h.logs.every((line) => !line.includes('SECRETCODE')));
});

test('JS-SDK 签名需要登录，且只签侧边栏页面', async () => {
  const h = boot();
  const anonymous = await h.call({
    url: `/zhiban/sidebar/jsapi-config?url=${encodeURIComponent(`${BASE}/sidebar/`)}`,
  });
  assert.equal(anonymous.status, 401);

  const state = signState(NOW, SECRET);
  const callback = await h.call({
    url: `/zhiban/sidebar/auth/callback?code=good&state=${encodeURIComponent(state)}`,
  });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionFromCookie(String(callback.headers['Set-Cookie']))!)}`;

  const ok = await h.call({
    url: `/zhiban/sidebar/jsapi-config?url=${encodeURIComponent(`${BASE}/sidebar/`)}`,
    headers: { cookie },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json().jsApiList, ['getCurExternalContact', 'getCurExternalChat']);
  assert.equal(ok.json().signature, 'sig');

  const missing = await h.call({
    url: '/zhiban/sidebar/jsapi-config',
    headers: { cookie },
  });
  assert.equal(missing.status, 400);
});

test('未配置 OAuth 时给可读提示，不裸跳', async () => {
  const routes: Array<{ handler: (req: never, res: never) => unknown }> = [];
  registerSidebarHttp(
    { register: (route) => { routes.push(route); return undefined; } },
    {
      api: api(),
      sessionSecret: SECRET,
      buildContext: () => ({}),
      now: () => NOW,
    },
  );
  const result = await new Promise<Result>((resolve) => {
    const req = {
      method: 'GET',
      url: '/zhiban/sidebar/auth/start',
      headers: {},
      on: () => req,
      destroy: () => {},
    };
    const res = {
      headersSent: false,
      status: 0,
      headers: {} as Record<string, string | number>,
      writeHead(status: number, headers: Record<string, string | number>) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
        return this;
      },
      end(chunk?: string) {
        resolve({ status: this.status, headers: this.headers, body: chunk ?? '', json: () => ({}) });
      },
    };
    void routes[0]!.handler(req as never, res as never);
  });
  assert.equal(result.status, 503);
  assert.ok(result.body.includes('侧边栏未配置'));
});
