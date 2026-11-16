/**
 * zhiban-advisor 插件装配（#167）：假 DSH 上下文跑通
 * 领域打开 → 会话适配 → 工具注册 → provide → 数据链路（含越权门控与原文照抄）。
 * 真实 DSH Host 加载仍需真机验证（⏳）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply as applyAdvisor } from '../plugins/zhiban-advisor/index.ts';
import type { DshAdvisorContext } from '../plugins/zhiban-advisor/index.ts';
import type { RegisteredTool } from '../src/p1/reply-tools.ts';
import { emptyChronicProfile } from '../src/p1/chronic.ts';
import type { ChronicProfile } from '../src/p1/chronic.ts';
import type {
  AdvisorAlertView,
  AdvisorDraftView,
  AdvisorPromiseView,
  AdvisorWecomDataPort,
} from '../src/p1/advisor/types.ts';

class FakeDomain {
  readonly maps = new Map<string, Map<string, unknown>>();

  table(name: string): {
    entries(): IterableIterator<[string, unknown]>;
    put(key: string, value: unknown): Promise<void>;
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
    };
  }

  async close(): Promise<void> {}
}

const CHRONIC: ChronicProfile = {
  patientId: 'p1',
  tenantId: 'tn_test',
  conditions: ['高血压'],
  medications: [{ name: '氨氯地平', dose: '5mg', source: 'advisor', updatedAt: 0 }],
  measurements: [
    {
      id: 'm1',
      metric: 'glucose',
      value: 5.8,
      measuredAt: 1_700_000_000_000,
      source: 'advisor',
      recordedAt: 1_700_000_000_000,
    },
  ],
  updatedAt: 1_700_000_000_000,
};

const PATIENTS = [
  {
    id: 'p1',
    tenantId: 'tn_test',
    displayName: '汪女士',
    externalUserId: 'wm_001',
    advisorId: 'adv_1',
    tags: ['高血压'],
    consent: 'agreed',
    status: 'serving',
  },
  {
    id: 'p2',
    tenantId: 'tn_test',
    displayName: '别的顾问的患者',
    externalUserId: 'wm_002',
    advisorId: 'adv_2',
    tags: [],
    consent: 'agreed',
    status: 'serving',
  },
  {
    id: 'p3',
    tenantId: 'tn_test',
    displayName: 'ATHM_wb001',
    externalUserId: 'wm_003',
    // 存量数据常见：患者没有分配顾问
    tags: [],
    consent: 'agreed',
    status: 'serving',
  },
] as const;

/** 饮食记录时间：固定 2026-11-15 09:10（上海） */
const MEAL_AT = Date.UTC(2026, 10, 15, 1, 10);
const MEAL_DATE = '2026-11-15';

const KNOWLEDGE = [
  { id: 'kn_1', category: '饮食', title: '高血压饮食', content: '低盐低脂，控制主食总量。', enabled: true },
];

const SCRIPTS = [{ id: 'sc_1', category: '复诊', title: '复诊提醒话术', content: '您好，请按医嘱复诊。', tags: [] }];

const RULES = [{ id: 'r_1', kind: 'redline', name: '不承诺疗效', keywords: ['保证', '疗效'], riskLevel: 'high' as const, action: '提示' }];

const DRAFTS: AdvisorDraftView[] = [
  { id: 'd1', groupName: '群 1', riskLevel: 'medium', status: 'PUSHED', since: 1000 },
];

function fakeData(): AdvisorWecomDataPort {
  return {
    advisorName: () => '王顾问',
    draftsFor: (advisorId) => (advisorId === 'adv_1' ? DRAFTS : []),
    promisesFor: (): AdvisorPromiseView[] => [
      { groupName: '群 1', dueAt: 1_700_000_000_000 + 3_600_000, dueLabel: '今天 18:00' },
    ],
    alertsFor: (advisorId): AdvisorAlertView[] =>
      advisorId === 'adv_1'
        ? [{ id: 'a1', title: '员工发言命中红线', at: 900 }]
        : [],
    pendingRepliesFor: () => 2,
    activeDraftFor: (advisorId) =>
      advisorId === 'adv_1'
        ? { id: 'd1', groupName: '群 1', riskLevel: 'medium', status: 'PUSHED', version: 1 }
        : undefined,
    sendText: async () => true,
    canReadPatient: true,
  };
}

function fakePatient(options: {
  /** 在职顾问列表；默认 2 人（模拟多顾问） */
  advisors?: Array<{ id: string; wecomUserId?: string; status?: string }>;
} = {}) {
  return {
    listPatients: () => [...PATIENTS],
    getPatientAdmin: (id: string) => PATIENTS.find((p) => p.id === id),
    getPatientBindings: (id: string) => [],
    listGroups: () => [],
    listAdvisors: () =>
      options.advisors ?? [
        { id: 'adv_1', wecomUserId: 'wang.guwen', status: 'active' },
        { id: 'adv_2', wecomUserId: 'li.si', status: 'active' },
      ],
    getChronicProfile: (patientId: string) => (patientId === 'p1' ? CHRONIC : emptyChronicProfile(patientId, 'tn_test')),
    listMealLogs: (patientId: string) =>
      patientId === 'p1'
        ? [
            {
              id: 'meal_1',
              tenantId: 'tn_test',
              patientId: 'p1',
              mealType: 'breakfast' as const,
              foods: [{ name: '燕麦粥' }, { name: '鸡蛋', portion: '1 个' }],
              mediaPath: '/var/lib/zhiban/media/meal-secret.jpg',
              confidence: 0.8,
              sandbox: false,
              createdAt: MEAL_AT,
            },
          ]
        : [],
  };
}

function harness() {
  const domain = new FakeDomain();
  const tools: RegisteredTool[] = [];
  const provided = new Map<string, unknown>();
  const events: Array<{ type: string; data: unknown }> = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const effects: Array<Promise<void>> = [];
  const listeners: Array<(...args: unknown[]) => void> = [];

  const ctx = {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
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
    on(_event: string, handler: (...args: unknown[]) => void) {
      listeners.push(handler);
      return undefined;
    },
    sessionController: {
      create: async (request: { sessionId: string }) => ({ sessionId: request.sessionId }),
      resolveAgent: async () => ({ agent: { whenIdle: async () => {}, inject: () => {} } }),
      prompt: async () => {},
    },
  } as unknown as DshAdvisorContext;

  applyAdvisor(ctx, {
    workspaceRoot: '/tmp/zhiban-ws-advisor',
    agentPreset: 'zhiban-advisor',
    turnTimeoutMs: 30_000,
    maxConcurrentTurns: 2,
    messagesPerMinute: 20,
    messagesPerDay: 500,
    enabled: true,
  });

  return {
    ctx,
    tools,
    provided,
    events,
    cleanups,
    listeners,
    ready: Promise.all(effects).then(() => undefined),
  };
}

test('装配：注册 4 个工具并提供 zhibanAdvisor 服务', async () => {
  const h = harness();
  await h.ready;
  const names = h.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'advisor_get',
    'advisor_overview',
    'advisor_search',
    'patient_chronic',
    'patient_meals',
  ]);
  assert.ok(h.provided.has('zhibanAdvisor'));
});

test('enabled：数据端口就绪后为 true', async () => {
  const h = harness();
  await h.ready;
  const advisor = h.provided.get('zhibanAdvisor') as {
    enabled(): boolean;
    handle(advisorId: string, text: string): Promise<boolean>;
  };
  assert.equal(advisor.enabled(), false, '数据端口未提供时不可用');
  h.ctx.provide('zhibanAdvisorData', fakeData());
  assert.equal(advisor.enabled(), true);
});

test('知识检索：原文逐字返回并带条目 id，未命中明确无命中', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanKnowledge', { list: () => KNOWLEDGE });
  await h.ready;
  const tool = h.tools.find((item) => item.name === 'advisor_search')!;
  const result = await tool.execute({ scope: 'knowledge', query: '高血压' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    status: string;
    found: number;
    items: Array<{ id: string; content: string }>;
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.found, 1);
  assert.equal(result.items[0]!.id, 'kn_1');
  assert.equal(result.items[0]!.content, '低盐低脂，控制主食总量。', '原文逐字返回');
});

test('话术检索与规则 get：机构原文照抄', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanScripts', { listEnabled: () => SCRIPTS });
  h.ctx.provide('zhibanGuard', { getRule: (id: string) => RULES.find((rule) => rule.id === id) });
  await h.ready;
  const search = h.tools.find((item) => item.name === 'advisor_search')!;
  const scriptResult = await search.execute({ scope: 'script', query: '复诊' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    items: Array<{ content: string }>;
  };
  assert.equal(scriptResult.items[0]!.content, '您好，请按医嘱复诊。');

  const get = h.tools.find((item) => item.name === 'advisor_get')!;
  const ruleResult = await get.execute({ scope: 'rule', id: 'r_1' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    item: { content: string };
  };
  assert.match(ruleResult.item.content, /不承诺疗效/);
  assert.match(ruleResult.item.content, /保证、疗效/);
});

test('患者档案：本人名下可查，别人的患者只回无权限', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const chronic = h.tools.find((item) => item.name === 'patient_chronic')!;
  const mine = await chronic.execute({ patientId: 'p1' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    status: string;
    hasRecord: boolean;
    displayName: string;
  };
  assert.equal(mine.status, 'ok');
  assert.equal(mine.hasRecord, true);
  assert.equal(mine.displayName, '汪女士');

  const others = await chronic.execute({ patientId: 'p2' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as { status: string };
  assert.equal(others.status, 'forbidden', '越权访问别人的患者必须被拒');
});

test('overview 工具：与「我的待办」命令共用待办快照', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  await h.ready;
  const overview = h.tools.find((item) => item.name === 'advisor_overview')!;
  const rendered = overview.output.render({}, await overview.execute({}, { agent: { id: 'zhiban-advisor-adv_1' } }));
  assert.match(rendered[0]!.text, /待处理草稿 1 条/);
  assert.match(rendered[0]!.text, /今日到期承诺 1 条/);
  assert.match(rendered[0]!.text, /待回复会话 2 个/);
});

test('卸载：清理会话存储并关闭领域', async () => {
  const h = harness();
  await h.ready;
  for (const cleanup of h.cleanups) await cleanup();
});

test('未分配顾问的患者：单顾问部署可见，多顾问部署不泄露', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const chronic = h.tools.find((item) => item.name === 'patient_chronic')!;
  // 两个在职顾问：未分配的 p3 不归任何人，不可见
  const multi = await chronic.execute({ patientId: 'p3' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as { status: string };
  assert.equal(multi.status, 'forbidden');

  const single = harness();
  single.ctx.provide('zhibanAdvisorData', fakeData());
  single.ctx.provide(
    'zhibanPatient',
    fakePatient({ advisors: [{ id: 'adv_1', wecomUserId: 'wang.guwen', status: 'active' }] }),
  );
  await single.ready;
  const chronic2 = single.tools.find((item) => item.name === 'patient_chronic')!;
  const ok = await chronic2.execute({ patientId: 'p3' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    status: string;
    hasRecord: boolean;
  };
  assert.equal(ok.status, 'ok');
  assert.equal(ok.hasRecord, false, '无档案如实说没有');
});

test('患者检索：支持按外部联系人 id 查（单顾问部署）', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide(
    'zhibanPatient',
    fakePatient({ advisors: [{ id: 'adv_1', wecomUserId: 'wang.guwen', status: 'active' }] }),
  );
  await h.ready;
  const search = h.tools.find((item) => item.name === 'advisor_search')!;
  const result = await search.execute({ scope: 'patient', query: 'ATHM_wb001' }, {
    agent: { id: 'zhiban-advisor-adv_1' },
  }) as { status: string; found: number; items: Array<{ id: string }> };
  assert.equal(result.status, 'ok');
  assert.equal(result.found, 1);
  assert.equal(result.items[0]!.id, 'p3');
});

test('patient_meals：按日期返回当天餐次，逐条列出食物', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const meals = h.tools.find((item) => item.name === 'patient_meals')!;
  const value = await meals.execute(
    { patientId: 'p1', date: MEAL_DATE },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  ) as { status: string; hasRecord: boolean; meals: Array<{ foods: string[] }> };
  assert.equal(value.status, 'ok');
  assert.equal(value.hasRecord, true);
  const text = meals.output.render({}, value)[0]!.text;
  assert.match(text, /早餐/);
  assert.match(text, /燕麦粥/);
  assert.match(text, /鸡蛋（1 个）/);
  // 原图路径只在插件内部传递，不得进工具结果（隐私）
  assert.equal(JSON.stringify(value).includes('/var/lib/zhiban/media'), false);

  // 没有记录的一天如实说没有
  const empty = await meals.execute(
    { patientId: 'p1', date: '2026-11-14' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  ) as { hasRecord: boolean };
  assert.equal(empty.hasRecord, false);
});
