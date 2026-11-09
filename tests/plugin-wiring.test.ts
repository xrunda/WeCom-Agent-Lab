/**
 * #35 / #36 插件装配测试：用假 DSH 上下文跑通
 * 领域打开 → 服务创建 → 工具注册 → provide → 卸载清理。
 *
 * 真实 DSH Host 的插件加载仍需真机验证（见 docs/P1-memory-care.md 的 ⏳ 项）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply as applyMemory } from '../plugins/zhiban-memory/index.ts';
import type { DshMemoryContext, MemoryRuntimeApi } from '../plugins/zhiban-memory/index.ts';
import { apply as applyCare } from '../plugins/zhiban-care/index.ts';
import type { CareRuntimeApi, DshCareContext } from '../plugins/zhiban-care/index.ts';
import type { RegisteredTool } from '../src/p1/reply-tools.ts';

class FakeDomain {
  readonly maps = new Map<string, Map<string, unknown>>();
  closed = false;

  table(name: string): {
    entries(): IterableIterator<[string, unknown]>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
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
      delete: async (key) => {
        target.delete(key);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  values(name: string): unknown[] {
    return [...(this.maps.get(name)?.values() ?? [])];
  }
}

interface Harness {
  ctx: DshMemoryContext & DshCareContext;
  ready: Promise<void>;
  tools: RegisteredTool[];
  provided: Map<string, unknown>;
  events: Array<{ type: string; data: unknown }>;
  cleanup(): Promise<void>;
}

function harness(domain: FakeDomain): Harness {
  const tools: RegisteredTool[] = [];
  const provided = new Map<string, unknown>();
  const events: Array<{ type: string; data: unknown }> = [];
  const effects: Array<Promise<void>> = [];
  const cleanups: Array<() => void | Promise<void>> = [];

  const ctx = {
    effect(fn: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>) {
      const promise = Promise.resolve(fn()).then((value) => {
        if (typeof value === 'function') cleanups.push(value);
      });
      effects.push(promise);
      return promise;
    },
    emit(type: string, data: unknown) {
      events.push({ type, data });
    },
    provide(name: string, value: unknown) {
      provided.set(name, value);
    },
    get<T = unknown>(name: string): T | undefined {
      return provided.get(name) as T | undefined;
    },
    storageDomain: {
      async open() {
        return domain;
      },
    },
    tools: {
      register(definition: unknown) {
        tools.push(definition as RegisteredTool);
      },
    },
  } as unknown as DshMemoryContext & DshCareContext;

  return {
    ctx,
    ready: Promise.all(effects).then(() => undefined),
    tools,
    provided,
    events,
    async cleanup() {
      for (const fn of cleanups) await fn();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test('#35 zhiban-memory 装配：注册工具、按会话患者写入并落盘、卸载关闭领域', async () => {
  const domain = new FakeDomain();
  const h = harness(domain);
  h.provided.set('zhibanPatient', {
    patientContextForSession: (sessionId: string) =>
      sessionId === 'session_pat_1'
        ? { patientId: 'pat_1', sourceMsgId: 'm_1', defaultSubject: 'self' }
        : sessionId === 'session_pat_2'
          ? { patientId: 'pat_2', sourceMsgId: 'm_2', defaultSubject: 'self' }
          : undefined,
  });

  applyMemory(h.ctx, { tenantId: 'tn_1', injectLimit: 10 });
  await h.ready;

  assert.deepEqual(
    h.tools.map((tool) => tool.name).sort(),
    ['memory_list', 'memory_update', 'memory_write'],
  );
  const api = h.provided.get('zhibanMemory') as MemoryRuntimeApi;
  assert.equal(api.available(), true);

  const write = h.tools.find((tool) => tool.name === 'memory_write')!;
  const result = (await write.execute(
    { category: 'dietary_taboo', content: '对海鲜过敏', subject: 'self', sourceText: '我对海鲜过敏' },
    { agent: { id: 'session_pat_1' } },
  )) as { id: string; content: string };
  assert.match(result.id, /^mem_/);
  assert.equal(result.content, '对海鲜过敏');

  await settle();
  const stored = domain.values('memories') as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].patientId, 'pat_1');
  assert.equal(stored[0].sourceMsgId, 'm_1');
  assert.equal(stored[0].sourceText, '我对海鲜过敏');
  assert.equal(api.count('pat_1'), 1);
  assert.ok(domain.values('audit').length >= 1);
  const created = h.events.find((event) => event.type === 'memory.created');
  assert.deepEqual(created?.data, {
    memoryId: result.id,
    patientId: 'pat_1',
    category: 'dietary_taboo',
    subject: 'self',
  });

  await assert.rejects(
    write.execute(
      { category: 'goal', content: '控糖', subject: 'self' },
      { agent: { id: 'session_unknown' } },
    ),
    /NO_PATIENT_CONTEXT|INVALID_TOOL_ARGS/,
  );

  const update = h.tools.find((tool) => tool.name === 'memory_update')!;
  await assert.rejects(
    update.execute(
      { id: result.id, content: '对虾蟹过敏' },
      { agent: { id: 'session_pat_2' } },
    ),
    /WRONG_PATIENT/,
  );

  await h.cleanup();
  assert.equal(domain.closed, true);
});

test('#36 zhiban-care 装配：schedule_create 建计划并落盘，卸载关闭领域', async () => {
  const domain = new FakeDomain();
  const h = harness(domain);
  h.provided.set('zhibanPatient', {
    patientContextForSession: (sessionId: string) =>
      sessionId === 'session_pat_1' ? { patientId: 'pat_1' } : undefined,
    startProactiveTurn: async () => ({ status: 'skipped' as const }),
  });

  applyCare(h.ctx, { tenantId: 'tn_1' });
  await h.ready;

  assert.deepEqual(h.tools.map((tool) => tool.name), ['schedule_create']);
  const api = h.provided.get('zhibanCare') as CareRuntimeApi;
  assert.equal(api.available(), true);

  const tool = h.tools[0];
  const result = (await tool.execute(
    { title: '提醒量血压', afterSeconds: 60 },
    { agent: { id: 'session_pat_1' } },
  )) as { planId: string; status: string; when: number };

  assert.match(result.planId, /^pln_/);
  assert.equal(result.status, 'pending');
  assert.ok(result.when > Date.now());
  assert.deepEqual(api.list('pat_1', 'pending').map((plan) => plan.id), [result.planId]);
  assert.ok(h.events.some((event) => event.type === 'care_plan.created'));

  await settle();
  const stored = domain.values('plans') as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].patientId, 'pat_1');
  assert.ok(domain.values('audit').length >= 1);

  await assert.rejects(
    tool.execute({ title: '提醒喝水', afterSeconds: 60 }, { agent: { id: 'session_unknown' } }),
    /INVALID_TOOL_ARGS .*没有关联患者/,
  );

  await h.cleanup();
  assert.equal(domain.closed, true);
});
