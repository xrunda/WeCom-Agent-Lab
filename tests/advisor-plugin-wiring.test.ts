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
  heightCm: 170,
  weightKg: 65,
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

function fakeData() {
  const discarded = new Set<string>();
  const resolved = new Set<string>();
  const port: AdvisorWecomDataPort = {
    advisorName: () => '王顾问',
    draftsFor: (advisorId) => (advisorId === 'adv_1' ? DRAFTS : []),
    promisesFor: (advisorId): AdvisorPromiseView[] =>
      advisorId === 'adv_1'
        ? [
            {
              id: 'prom_1',
              groupName: '群 1',
              excerpt: '明天提醒我量血压',
              dueAt: 1_700_000_000_000 + 3_600_000,
              dueLabel: '今天 18:00',
            },
          ]
        : [],
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
    draftDetail: (advisorId, draftId) => {
      if (advisorId !== 'adv_1' || draftId !== 'd1') return undefined;
      return {
        id: 'd1',
        groupName: '群 1',
        riskLevel: 'medium',
        status: 'PUSHED',
        body: '您好，您血压有点高，记得明天复诊。',
        since: 1000,
      };
    },
    promiseDetail: (advisorId, promiseId) => {
      if (advisorId !== 'adv_1' || promiseId !== 'prom_1') return undefined;
      return {
        id: 'prom_1',
        groupName: '群 1',
        excerpt: '明天提醒我量血压',
        dueAt: 1_700_000_000_000 + 3_600_000,
        dueLabel: '今天 18:00',
        status: 'pending',
        remindCount: 0,
      };
    },
    pendingReplies: (advisorId) =>
      advisorId === 'adv_1'
        ? [
            {
              convKey: 'room:room1',
              customerId: 'wm_001',
              excerpt: '我今天有点头晕',
              reason: 'ambiguous',
              lastAt: 1_700_000_000_000 - 60_000,
            },
          ]
        : [],
    discardDraft: async (advisorId, draftId) => {
      if (advisorId !== 'adv_1' || draftId !== 'd1') return false;
      if (discarded.has(draftId)) return false;
      discarded.add(draftId);
      return true;
    },
    resolvePromise: async (advisorId, promiseId, action) => {
      if (advisorId !== 'adv_1' || promiseId !== 'prom_1') return false;
      if (resolved.has(promiseId)) return false;
      resolved.add(promiseId);
      return true;
    },
  };
  return port;
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

test('装配：注册 11 个工具并提供 zhibanAdvisor 服务', async () => {
  const h = harness();
  await h.ready;
  const names = h.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'advisor_get',
    'advisor_overview',
    'advisor_patients',
    'advisor_pending_replies',
    'advisor_search',
    'draft_discard',
    'patient_chronic',
    'patient_meal_photo',
    'patient_meal_summary',
    'patient_meals',
    'promise_resolve',
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

test('patient_meal_photo：有原图的餐次返回标注，无原图如实说没有', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const photo = h.tools.find((item) => item.name === 'patient_meal_photo')!;

  // 早餐有原图：返回餐次标注与时间
  const breakfast = await photo.execute(
    { patientId: 'p1', date: MEAL_DATE, mealType: 'breakfast' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  ) as { status: string; mealLabel: string; time: string; hasPhoto: boolean };
  assert.equal(breakfast.status, 'ok');
  assert.equal(breakfast.mealLabel, '11月15日 早餐', '标注由系统生成：日期 + 餐次');
  assert.equal(breakfast.time, '09:10');
  assert.equal(breakfast.hasPhoto, true);
  const text = photo.output.render({}, breakfast)[0]!.text;
  assert.match(text, /已发出 11月15日 早餐 09:10 的原图/);
  // 原图路径不得进入工具结果（隐私）
  assert.equal(JSON.stringify(breakfast).includes('/var/lib/zhiban/media'), false);

  // 晚餐没有记录：没有时间、没有原图
  const dinner = await photo.execute(
    { patientId: 'p1', date: MEAL_DATE, mealType: 'dinner' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  ) as { status: string; mealLabel: string; time?: string; hasPhoto: boolean };
  assert.equal(dinner.status, 'ok');
  assert.equal(dinner.time, undefined);
  assert.equal(dinner.hasPhoto, false);
  const dinnerText = photo.output.render({}, dinner)[0]!.text;
  assert.match(dinnerText, /11月15日 晚餐当天没有这条餐次记录，没有原图可发/);

  // 越权：别人的患者拒绝
  const others = await photo.execute(
    { patientId: 'p2', date: MEAL_DATE, mealType: 'breakfast' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  ) as { status: string };
  assert.equal(others.status, 'forbidden');
});

test('advisor_get(scope=draft / promise)：本人名下返回正文与承诺原话，别人的不泄露', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  await h.ready;
  const get = h.tools.find((item) => item.name === 'advisor_get')!;

  const draft = await get.execute({ scope: 'draft', id: 'd1' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    status: string;
    item: { content: string; title: string };
  };
  assert.equal(draft.status, 'ok');
  assert.match(draft.item.title, /草稿 · 群 1/);
  assert.match(draft.item.content, /复诊/);

  const promise = await get.execute({ scope: 'promise', id: 'prom_1' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as {
    status: string;
    item: { content: string };
  };
  assert.equal(promise.status, 'ok');
  assert.match(promise.item.content, /量血压/);

  // 不存在的草稿 / 承诺如实说没有
  const miss = await get.execute({ scope: 'draft', id: 'd9' }, { agent: { id: 'zhiban-advisor-adv_1' } }) as { status: string };
  assert.equal(miss.status, 'not-found');
});

test('draft_discard：顾问确认后作废本人草稿，重复作废 / 不存在如实说明', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  await h.ready;
  const discard = h.tools.find((item) => item.name === 'draft_discard')!;

  const ok = await discard.execute({ draftId: 'd1' }, { agent: { id: 'zhiban-advisor-adv_1' } });
  assert.match(discard.output.render({}, ok)[0]!.text, /已作废草稿 d1/);

  const again = await discard.execute({ draftId: 'd1' }, { agent: { id: 'zhiban-advisor-adv_1' } });
  assert.match(discard.output.render({}, again)[0]!.text, /状态不能执行/);

  const missing = await discard.execute({ draftId: 'd9' }, { agent: { id: 'zhiban-advisor-adv_1' } });
  assert.match(discard.output.render({}, missing)[0]!.text, /没有找到/);
});

test('promise_resolve：兑现本人承诺，越权 / 已处理如实说明', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  await h.ready;
  const resolve = h.tools.find((item) => item.name === 'promise_resolve')!;

  const ok = await resolve.execute(
    { promiseId: 'prom_1', outcome: 'done' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  );
  assert.match(resolve.output.render({}, ok)[0]!.text, /承诺 prom_1（群 1：「明天提醒我量血压」）已兑现/);

  const again = await resolve.execute(
    { promiseId: 'prom_1', outcome: 'dismissed' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  );
  assert.match(resolve.output.render({}, again)[0]!.text, /状态不能执行/);

  const missing = await resolve.execute(
    { promiseId: 'prom_9', outcome: 'done' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  );
  assert.match(resolve.output.render({}, missing)[0]!.text, /没有找到/);
});

test('advisor_patients：只返回本人名下患者，不带客户正文', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const patients = h.tools.find((item) => item.name === 'advisor_patients')!;
  const value = await patients.execute({}, { agent: { id: 'zhiban-advisor-adv_1' } });
  const text = patients.output.render({}, value)[0]!.text;
  // 单顾问部署下 p1（本人）与 p3（未分配）可见；p2（别人顾问）不可见
  assert.match(text, /汪女士/);
  assert.match(text, /p1/);
  assert.equal(text.includes('别的顾问的患者'), false, '越权患者不泄露');
});

test('patient_meal_summary：按天汇总本人名下患者，无记录如实说没有', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const summary = h.tools.find((item) => item.name === 'patient_meal_summary')!;
  // p1 在 MEAL_DATE 有早餐原图
  const value = await summary.execute(
    { date: MEAL_DATE },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  );
  const text = summary.output.render({}, value)[0]!.text;
  assert.match(text, /2026-11-15 有 1 位患者上传了饮食记录/);
  assert.match(text, /早餐 09:10/);
  assert.match(text, /有原图/);

  // 没有记录的一天如实说没有
  const empty = await summary.execute(
    { date: '2026-11-14' },
    { agent: { id: 'zhiban-advisor-adv_1' } },
  );
  assert.match(summary.output.render({}, empty)[0]!.text, /没有患者上传饮食记录/);
});

test('advisor_pending_replies：列出本人名下的待回复会话', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  await h.ready;
  const pending = h.tools.find((item) => item.name === 'advisor_pending_replies')!;
  const value = await pending.execute({}, { agent: { id: 'zhiban-advisor-adv_1' } });
  const text = pending.output.render({}, value)[0]!.text;
  assert.match(text, /1 个会话等你回复/);
  assert.match(text, /我今天有点头晕/);
});

test('patient_chronic 返回事实卡：身高体重、最近饮食与长期记忆都带上', async () => {
  const h = harness();
  h.ctx.provide('zhibanAdvisorData', fakeData());
  h.ctx.provide('zhibanPatient', fakePatient());
  h.ctx.provide('zhibanMemory', {
    render: () => [
      '【患者长期记忆（引用时把方括号里的 id 填进 citedMemoryIds）】',
      '- 饮食禁忌/过敏',
      '  - [mem_1] 海鲜过敏（患者本人）',
      '- 偏好',
      '  - [mem_2] 口味清淡（患者本人）',
    ],
  });
  await h.ready;
  const chronic = h.tools.find((item) => item.name === 'patient_chronic')!;
  const value = await chronic.execute({ patientId: 'p1' }, { agent: { id: 'zhiban-advisor-adv_1' } });
  const text = chronic.output.render({}, value)[0]!.text;
  assert.match(text, /身高体重：170 cm \/ 65 kg/);
  assert.match(text, /最近饮食/);
  assert.match(text, /燕麦粥/);
  assert.match(text, /海鲜过敏/);
  assert.match(text, /口味清淡/);
});
