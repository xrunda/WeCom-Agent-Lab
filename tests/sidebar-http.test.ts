/**
 * #147 侧边栏接口：401 / 403 / 200、roomId 剥离与关闭权限。
 * 用假 webServer 与假请求响应，不启动监听。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PendingItem } from '../src/p1/sidebar.ts';
import { buildSidebarContext } from '../src/p1/sidebar-view.ts';
import type { SidebarAdvisor, SidebarViewDeps } from '../src/p1/sidebar-view.ts';
import { registerSidebarHttp } from '../plugins/zhiban-sidebar/http.ts';
import { SESSION_COOKIE, signSession } from '../plugins/zhiban-sidebar/session.ts';
import type { SidebarRuntimeApi } from '../plugins/zhiban-sidebar/index.ts';

const NOW = 1_700_000_000_000;
const SECRET = 'test-secret';

function item(overrides: Partial<PendingItem> = {}): PendingItem {
  return {
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
    ...overrides,
  };
}

function makeApi(items: PendingItem[]) {
  const closed: Array<{ id: string; actor: string }> = [];
  const events: Array<{ type: string; itemId?: string }> = [];
  const api: SidebarRuntimeApi = {
    observe: () => ({ closed: [] }),
    openItems: (convKey) => items.filter((i) => i.convKey === convKey && i.status === 'open'),
    recentlyClosed: () => [],
    get: (id) => items.find((i) => i.id === id),
    lastObservedAt: () => NOW,
    close: (id, _reason, actor) => {
      const found = items.find((i) => i.id === id);
      if (found) closed.push({ id, actor });
      return found;
    },
    reportEvent: (type, itemId) => {
      events.push({ type, ...(itemId ? { itemId } : {}) });
    },
    allItems: () => items,
    prune: () => {},
    flush: async () => {},
  };
  return { api, closed, events };
}

const viewDeps: SidebarViewDeps = {
  openItems: () => [item()],
  recentlyClosed: () => [],
  lastObservedAt: () => NOW,
  listGroups: () => [
    { roomId: 'room_1', chatId: 'chat_1', name: '高血压管理 1 群', advisorId: 'adv_1' },
    { roomId: 'room_2', chatId: 'chat_2', name: '另一个群', advisorId: 'adv_2' },
  ],
  patientIdsForRoom: () => ['pat_1'],
  getPatient: () => ({
    id: 'pat_1',
    displayName: '王阿姨',
    tags: ['高血压'],
    consent: 'agreed',
    identityStatus: 'confirmed',
    lastActiveAt: NOW - 86_400_000,
  }),
  patientNameFor: (id) => (id === 'wm_a' ? '王阿姨' : undefined),
  getAdvisorName: () => '李医生',
  now: () => NOW,
};

interface Captured {
  handler: (
    req: never,
    res: never,
  ) => unknown;
}

function boot(items = [item()]) {
  const captured: Captured[] = [];
  const { api, closed, events } = makeApi(items);
  registerSidebarHttp(
    {
      register: (route) => {
        captured.push(route);
        return undefined;
      },
    },
    {
      api,
      sessionSecret: SECRET,
      now: () => NOW,
      buildContext: (advisor: SidebarAdvisor, query: URLSearchParams) =>
        buildSidebarContext(
          viewDeps,
          advisor,
          {
            ...(query.get('chatId') ? { chatId: query.get('chatId')! } : {}),
            ...(query.get('externalUserId')
              ? { externalUserId: query.get('externalUserId')! }
              : {}),
            ...(query.get('roomId') ? { roomId: query.get('roomId')! } : {}),
          },
        ),
    },
  );
  return { route: captured[0]!, closed, events };
}

function cookie(advisorId: string, exp = NOW + 60_000): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(
    signSession({ advisorId, permissions: ['patient.read'], exp }, SECRET),
  )}`;
}

function call(
  route: Captured,
  options: { method?: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
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
      writeHead(status: number) {
        this.status = status;
        this.headersSent = true;
        return this;
      },
      end(chunk?: string) {
        const payload = chunk ?? '';
        resolve({ status: this.status, body: payload === '' ? null : JSON.parse(payload) });
      },
    };
    void route.handler(req as never, res as never);
    setImmediate(() => {
      if (options.body !== undefined) {
        for (const listener of listeners.get('data') ?? []) listener(Buffer.from(options.body));
      }
      for (const listener of listeners.get('end') ?? []) listener(undefined);
    });
  });
}

test('没有会话令牌返回 401', async () => {
  const { route } = boot();
  const result = await call(route, { url: '/zhiban/sidebar/context?chatId=chat_1' });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'UNAUTHENTICATED');
});

test('绑定顾问带令牌拿到首屏数据', async () => {
  const { route } = boot();
  const result = await call(route, {
    url: '/zhiban/sidebar/context?chatId=chat_1',
    headers: { cookie: cookie('adv_1') },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.conv.name, '高血压管理 1 群');
  assert.equal(result.body.pending.openCount, 1);
  assert.equal(result.body.profile.name, '王阿姨');
});

test('前端传入 roomId 被忽略，只能按 chatId 查', async () => {
  const { route } = boot();
  const result = await call(route, {
    url: '/zhiban/sidebar/context?roomId=room_1',
    headers: { cookie: cookie('adv_1') },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.conv.served, false);
  assert.equal(result.body.conv.reason, 'DM_NOT_SUPPORTED');
});

test('非绑定顾问打开别人的群返回 403，且不带客户字段', async () => {
  const { route } = boot();
  const result = await call(route, {
    url: '/zhiban/sidebar/context?chatId=chat_1',
    headers: { cookie: cookie('adv_2') },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'FORBIDDEN');
  assert.equal(result.body.customerName, undefined);
});

test('手动关闭走同一条权限判断，成功后调用 close', async () => {
  const { route, closed } = boot();
  const result = await call(route, {
    method: 'POST',
    url: '/zhiban/sidebar/pending/pend_1/close',
    headers: { cookie: cookie('adv_1'), 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'dismissed' }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(closed, [{ id: 'pend_1', actor: 'adv_1' }]);
});

test('关闭他人群里的条目返回 403', async () => {
  const { route, closed } = boot([item({ id: 'pend_2', convKey: 'room:room_2', roomId: 'room_2' })]);
  const result = await call(route, {
    method: 'POST',
    url: '/zhiban/sidebar/pending/pend_2/close',
    headers: { cookie: cookie('adv_1') },
    body: JSON.stringify({ reason: 'dismissed' }),
  });
  assert.equal(result.status, 403);
  assert.equal(closed.length, 0);
});

test('非法 reason 返回 400', async () => {
  const { route } = boot();
  const result = await call(route, {
    method: 'POST',
    url: '/zhiban/sidebar/pending/pend_1/close',
    headers: { cookie: cookie('adv_1') },
    body: JSON.stringify({ reason: 'delete' }),
  });
  assert.equal(result.status, 400);
});

test('#149 已处理与转交都能关闭', async () => {
  for (const reason of ['handled', 'transferred']) {
    const { route, closed } = boot();
    const result = await call(route, {
      method: 'POST',
      url: '/zhiban/sidebar/pending/pend_1/close',
      headers: { cookie: cookie('adv_1') },
      body: JSON.stringify({ reason }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, reason);
    assert.deepEqual(closed, [{ id: 'pend_1', actor: 'adv_1' }]);
  }
});

test('#149 埋点只收白名单事件，id 截断且不带正文', async () => {
  const { route, events } = boot();
  const result = await call(route, {
    method: 'POST',
    url: '/zhiban/sidebar/events',
    headers: { cookie: cookie('adv_1') },
    body: JSON.stringify({ event: 'draft.copy', itemId: 'pend_1', body: '不该带上来的正文' }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(events, [{ type: 'draft.copy', itemId: 'pend_1' }]);

  const denied = await call(route, {
    method: 'POST',
    url: '/zhiban/sidebar/events',
    headers: { cookie: cookie('adv_1') },
    body: JSON.stringify({ event: 'message.body', itemId: 'pend_1' }),
  });
  assert.equal(denied.status, 400);
  assert.equal(events.length, 1);
});

test('#149 埋点接口同样需要登录', async () => {
  const { route, events } = boot();
  const result = await call(route, {
    method: 'POST',
    url: '/zhiban/sidebar/events',
    body: JSON.stringify({ event: 'sidebar.open' }),
  });
  assert.equal(result.status, 401);
  assert.equal(events.length, 0);
});
