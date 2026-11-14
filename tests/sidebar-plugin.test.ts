/**
 * #146 插件装配：打开领域 → 提供服务 → 观察消息 → 卸载落盘。
 * 用假 DSH 上下文，不接触真实存储。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../plugins/zhiban-sidebar/index.ts';
import type { DshSidebarContext, SidebarRuntimeApi } from '../plugins/zhiban-sidebar/index.ts';
import { groupConvKey } from '../src/p1/sidebar.ts';

class FakeDomain {
  readonly maps = new Map<string, Map<string, unknown>>();
  closed = false;

  table(name: string): {
    entries(): IterableIterator<[string, unknown]>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  } {
    let map = this.maps.get(name);
    if (!map) {
      map = new Map();
      this.maps.set(name, map);
    }
    const target = map;
    return {
      entries: () => target.entries(),
      put: async (key, value) => {
        target.set(key, value);
      },
      delete: async (key) => target.delete(key),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function harness(): {
  ctx: DshSidebarContext;
  ready: Promise<unknown>;
  provided: Map<string, unknown>;
  events: Array<{ type: string; data: unknown }>;
  cleanup(): Promise<void>;
} {
  const domain = new FakeDomain();
  const provided = new Map<string, unknown>();
  const events: Array<{ type: string; data: unknown }> = [];
  const registeredRoutes: unknown[] = [];
  let cleanupFn: EffectCleanup = undefined;

  type EffectCleanup = void | (() => void | Promise<void>);

  const ctx: DshSidebarContext = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => {
      const result = fn();
      if (result instanceof Promise) {
        ready = result.then((cleanup) => {
          cleanupFn = cleanup;
        });
      } else {
        cleanupFn = result;
      }
      return undefined;
    },
    emit: (type, data) => {
      events.push({ type, data });
    },
    provide: (name, value) => {
      provided.set(name, value);
    },
    get: () => undefined,
    storageDomain: {
      open: async () => domain as never,
    },
    webServer: {
      register: (route) => {
        registeredRoutes.push(route);
        return undefined;
      },
    },
  };

  let ready: Promise<unknown> = Promise.resolve();
  apply(ctx, { tenantId: 'test', botUserIds: ['bot_1'] });

  return {
    ctx,
    ready,
    provided,
    events,
    cleanup: async () => {
      await ready;
      if (typeof cleanupFn === 'function') await cleanupFn();
    },
  };
}

test('插件提供 zhibanSidebar，观察后能查到开放条目', async () => {
  const h = harness();
  await h.ready;

  const api = h.provided.get('zhibanSidebar') as SidebarRuntimeApi | undefined;
  assert.ok(api, '应提供 zhibanSidebar');

  const convKey = groupConvKey('room_plugin_test');
  const result = api.observe({
    msgid: 'm1',
    convKey,
    kind: 'group',
    roomId: 'room_plugin_test',
    senderId: 'wm_customer',
    msgtype: 'text',
    text: '明天几点复诊？',
    at: 1_700_000_000_000,
  });

  assert.ok(result.item);
  assert.equal(api.openItems(convKey).length, 1);
  await api.flush();
  await h.cleanup();
});

test('机器人 userid 来自插件配置，其发言不关闭条目', async () => {
  const h = harness();
  await h.ready;
  const api = h.provided.get('zhibanSidebar') as SidebarRuntimeApi;
  const convKey = groupConvKey('room_plugin_test');

  api.observe({
    msgid: 'm1',
    convKey,
    kind: 'group',
    senderId: 'wm_customer',
    msgtype: 'text',
    text: '明天几点复诊？',
    at: 1_700_000_000_000,
  });
  api.observe({
    msgid: 'm2',
    convKey,
    kind: 'group',
    senderId: 'bot_1',
    msgtype: 'text',
    text: '已收到',
    at: 1_700_000_001_000,
  });

  assert.equal(api.openItems(convKey).length, 1);
  await api.flush();
  await h.cleanup();
});
