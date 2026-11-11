import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import { buildGuardToolDefinitions, validateEscalate } from '../src/p1/guard-tools.ts';
import {
  builtinRules,
  GuardError,
  GuardService,
  maxRisk,
  REFERRAL_BODY,
} from '../src/p1/guard.ts';
import type {
  GuardAlertRecord,
  GuardBackend,
  RiskRuleRecord,
} from '../src/p1/guard.ts';
import { observeServiceGroup, setupRuntime } from './p1-helpers.ts';
import { apply as applyGuardPlugin } from '../plugins/zhiban-guard/index.ts';
import { parseGuardConfig } from '../plugins/zhiban-guard/config.ts';
import { LazyDraftGuard } from '../plugins/zhiban-patient/index.ts';

class MemoryGuardBackend implements GuardBackend {
  readonly rules = new Map<string, RiskRuleRecord>();
  readonly alerts = new Map<string, GuardAlertRecord>();
  readonly deleted: string[] = [];
  failWrites = false;

  loadRules(): RiskRuleRecord[] {
    return [...this.rules.values()];
  }

  loadAlerts(): GuardAlertRecord[] {
    return [...this.alerts.values()];
  }

  async putRule(rule: RiskRuleRecord): Promise<void> {
    if (this.failWrites) throw new Error('WRITE_FAILED');
    this.rules.set(rule.id, rule);
  }

  async deleteRule(id: string): Promise<void> {
    this.rules.delete(id);
    this.deleted.push(id);
  }

  async putAlert(alert: GuardAlertRecord): Promise<void> {
    if (this.failWrites) throw new Error('WRITE_FAILED');
    this.alerts.set(alert.id, alert);
  }
}

function harness() {
  const clock = new FakeClock(1_700_000_000_000);
  const backend = new MemoryGuardBackend();
  const events: Array<{ type: string; data: unknown }> = [];
  const service = new GuardService({
    tenantId: 'tn_test',
    backend,
    now: () => clock.now(),
    newId: (prefix) => `${prefix}_${clock.now()}_${Math.random().toString(36).slice(2, 6)}`,
    emit: (type, data) => events.push({ type, data }),
  });
  return { clock, backend, service, events };
}

test('#37 初始化即补齐四条内置规则，且不可改删', async () => {
  const h = harness();
  await h.service.flush();
  const rules = h.service.list();
  assert.equal(rules.length, 4);
  assert.deepEqual(
    rules.filter((rule) => rule.builtin).map((rule) => rule.id).sort(),
    builtinRules('tn_test', 0)
      .map((rule) => rule.id)
      .sort(),
  );
  assert.ok(rules.every((rule) => rule.builtin && rule.enabled));
  assert.equal(h.backend.rules.size, 4);

  assert.throws(() => h.service.update('rul_builtin_no_diagnosis', { enabled: false }), (error: unknown) => {
    return error instanceof GuardError && error.code === 'IMMUTABLE_RESOURCE';
  });
  assert.throws(() => h.service.remove('rul_builtin_emergency'), /IMMUTABLE_RESOURCE/);
});

test('#37 草稿命中关键词：取最高风险，累加命中并记审计，不阻断', async () => {
  const h = harness();
  const result = h.service.review({
    body: '您可以先停药观察两天。',
    riskLevel: 'low',
    patientId: 'pt_1',
    source: 'inbound',
  });
  assert.equal(result.riskLevel, 'high');
  assert.equal(result.escalate, false);
  assert.equal(result.guideOnly, false);
  assert.equal(result.referralBody, undefined);
  assert.ok(result.hits.includes('rul_builtin_no_medication'));
  assert.ok(
    h.service.audits().some((event) => event.action === 'risk_rule.hit' && event.target === 'rul_builtin_no_medication'),
  );
  assert.equal(h.service.get('rul_builtin_no_medication')?.hitCount, 1);
  assert.equal(h.service.alerts().length, 1);
  assert.equal(h.service.alerts()[0]?.kind, 'redline');

  const clean = h.service.review({
    body: '今晚吃点清淡的，早点休息。',
    riskLevel: 'low',
    patientId: 'pt_1',
    source: 'inbound',
    inboundText: '今晚吃什么？',
  });
  assert.equal(clean.hits.length, 0);
  assert.equal(clean.riskLevel, 'low');
});

test('#37 急症：只看患者输入也能升级，正文改写为就医引导，告警不带正文', async () => {
  const h = harness();
  const inboundText = '我爸刚才胸口很痛，喘不上气，现在躺着。';
  const result = h.service.review({
    body: '先别紧张，让叔叔休息一下，我帮你问问顾问。',
    riskLevel: 'medium',
    patientId: 'pt_2',
    sessionId: 's_2',
    source: 'inbound',
    inboundText,
  });
  assert.equal(result.escalate, true);
  assert.equal(result.guideOnly, true);
  assert.equal(result.riskLevel, 'high');
  assert.equal(result.referralBody, REFERRAL_BODY);
  assert.ok(result.hits.includes('rul_builtin_emergency'));

  const alerts = h.service.alerts('pt_2');
  assert.equal(alerts.length, 1);
  const alert = alerts[0]!;
  assert.equal(alert.kind, 'escalate');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.sessionId, 's_2');
  assert.ok(alert.ruleIds.includes('rul_builtin_emergency'));
  assert.equal(alert.message.includes('我爸刚才胸口很痛'), false);
  assert.equal(alert.sandbox, false);
});

test('#37 自定义规则：CRUD、guide 改写、停用后不再命中', async () => {
  const h = harness();
  const created = h.service.create({
    name: '心慌需就医',
    keywords: ['心慌', '心悸'],
    riskLevel: 'medium',
    action: 'guide',
    enabled: false,
  });
  assert.equal(created.action, 'guide');
  assert.equal(created.builtin, false);
  assert.equal(created.enabled, false);

  const off = h.service.review({
    body: '您心慌的话先坐一下。',
    riskLevel: 'low',
    patientId: 'pt_3',
    source: 'inbound',
    inboundText: '我今天有点心慌。',
  });
  assert.equal(off.hits.includes(created.id), false);

  h.service.update(created.id, { enabled: true });
  const on = h.service.review({
    body: '您心慌的话先坐一下。',
    riskLevel: 'low',
    patientId: 'pt_3',
    source: 'inbound',
    inboundText: '我今天有点心慌。',
  });
  assert.ok(on.hits.includes(created.id));
  assert.equal(on.guideOnly, true);

  // guide 规则同样只看患者输入：草稿里出现关键词不触发改写
  const bodyOnly = h.service.review({
    body: '您心慌的话先坐一下。',
    riskLevel: 'low',
    patientId: 'pt_3',
    source: 'inbound',
  });
  assert.equal(bodyOnly.hits.includes(created.id), false);
  assert.equal(on.referralBody, REFERRAL_BODY);

  h.service.remove(created.id);
  await h.service.flush();
  assert.equal(h.service.get(created.id), undefined);
  assert.ok(h.backend.deleted.includes(created.id));
});

test('#37 规则校验：名称 / 关键词 / 等级 / 动作', () => {
  const h = harness();
  assert.throws(() => h.service.create({ name: ' ', keywords: ['x'], riskLevel: 'low' }), /EMPTY_NAME/);
  assert.throws(
    () => h.service.create({ name: '规则', keywords: [], riskLevel: 'low' }),
    /EMPTY_KEYWORDS/,
  );
  assert.throws(
    () =>
      h.service.create({
        name: '规则',
        keywords: Array.from({ length: 21 }, (_, index) => `k${index}`),
        riskLevel: 'low',
      }),
    /TOO_MANY_KEYWORDS/,
  );
  assert.throws(
    () => h.service.create({ name: '规则', keywords: ['x'.repeat(31)], riskLevel: 'low' }),
    /INVALID_KEYWORD/,
  );
  assert.throws(
    () => h.service.create({ name: '规则', keywords: ['x'], riskLevel: 'normal' as never }),
    /INVALID_RISK_LEVEL/,
  );
  assert.throws(
    () => h.service.create({ name: '规则', keywords: ['x'], riskLevel: 'low', action: 'block' as never }),
    /INVALID_ACTION/,
  );
});

test('#37 升级工具：只收原因枚举，患者从会话反查，告警不带正文', async () => {
  assert.equal(validateEscalate({ reason: 'patient_request' }).ok, true);
  assert.equal(validateEscalate({ reason: 'emergency' }).ok, false);
  assert.equal(validateEscalate({ body: '胸痛' }).ok, false);

  const h = harness();
  const tools = buildGuardToolDefinitions({
    patientForSession: (sessionId) => (sessionId === 's_ok' ? 'pt_9' : undefined),
    escalate: (sessionId, patientId, reason) => h.service.escalate(patientId, reason, sessionId),
  });
  const tool = tools[0]!;
  assert.equal(tool.name, 'escalate_to_human');

  const output = (await tool.execute(
    { reason: 'patient_request' },
    { agent: { id: 's_ok' } },
  )) as { alertId: string; reason: string };
  assert.equal(output.reason, 'patient_request');
  const alert = h.service.alerts('pt_9')[0]!;
  assert.equal(alert.id, output.alertId);
  assert.equal(alert.kind, 'escalate');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.sessionId, 's_ok');

  await assert.rejects(
    tool.execute({ reason: 'other' }, { agent: { id: 's_unknown' } }),
    /INVALID_TOOL_ARGS/,
  );
  await assert.rejects(tool.execute({ reason: 'nope' }, { agent: { id: 's_ok' } }), /INVALID_TOOL_ARGS/);
  await assert.rejects(tool.execute({ reason: 'other' }, {}), /INVALID_TOOL_ARGS/);
});

test('#37 风险等级取最高值', () => {
  assert.equal(maxRisk('low', 'medium'), 'medium');
  assert.equal(maxRisk('high', 'low'), 'high');
  assert.equal(maxRisk('medium', 'medium'), 'medium');
});

test('#37 运行链路：急症输入让草稿改写为就医引导，并通知顾问', async () => {
  const h = harness();
  const runtimeHarness = setupRuntime({ guard: h.service });
  const group = observeServiceGroup(runtimeHarness, { status: 'serving', advisorId: 'adv_1' });
  runtimeHarness.sessions.onPrompt = async (sessionId) => {
    await runtimeHarness.runtime.replyDraft(sessionId, {
      body: '先别紧张，让叔叔休息一下，我帮你问问顾问。',
      inboundSummary: '家属描述胸痛',
      riskLevel: 'medium',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  runtimeHarness.runtime.routeInbound({
    msgid: 'm_emergency',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '我爸刚才胸口很痛，喘不上气。',
    msgtime: 1_700_000_000_000,
  });
  runtimeHarness.clock.advance(30_000);
  await runtimeHarness.runtime.flushDue();

  assert.equal(runtimeHarness.bridge.enqueued.length, 1);
  const enqueued = runtimeHarness.bridge.enqueued[0]!;
  assert.equal(enqueued.body, REFERRAL_BODY);
  assert.equal(enqueued.riskLevel, 'high');
  // #37：命中规则要落进草稿，卡片才能显示规则名而不是「无」
  assert.deepEqual(enqueued.ruleIds, ['rul_builtin_emergency']);
  assert.deepEqual(enqueued.ruleNames, ['急症只引导就医']);
  const event = runtimeHarness.events.find((item) => item.type === 'draft.guard.hit');
  assert.ok(event);
  const data = event!.data as {
    ruleIds: string[];
    guideOnly: boolean;
    escalated: boolean;
  };
  assert.ok(data.ruleIds.includes('rul_builtin_emergency'));
  assert.equal(data.guideOnly, true);
  assert.equal(data.escalated, true);
  assert.ok(runtimeHarness.bridge.notices.some((text) => text.includes('急症只引导就医')));
  assert.equal(runtimeHarness.bridge.notices.some((text) => text.includes('我爸刚才')), false);

  const created = runtimeHarness.events.find((event) => event.type === 'draft.created');
  assert.ok(created);
  const draftId = (created!.data as { draftId: string }).draftId;
  const alert = h.service.alerts().find((item) => item.draftId === draftId);
  assert.ok(alert);
  assert.equal(alert!.draftId, draftId);
  assert.equal(alert!.groupId, group.id);
});

test('#37 急症规则不因草稿里的条件式提醒自触发', () => {
  const h = harness();
  const result = h.service.review({
    body: '另外要提醒一句：如果胸闷同时伴有胸痛、明显呼吸困难、出汗，请立即拨打 120。',
    riskLevel: 'low',
    patientId: 'pt_4',
    sessionId: 's_4',
    source: 'inbound',
    inboundText: '我平时有高血压，偶尔会胸闷气短。',
  });
  assert.equal(result.escalate, false);
  assert.equal(result.guideOnly, false);
  assert.equal(result.riskLevel, 'low');
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.hitNames, []);
  assert.equal(result.referralBody, undefined);
  assert.equal(h.service.alerts().length, 0);
  assert.equal(h.service.get('rul_builtin_emergency')?.hitCount, 0);

  // flag 规则仍然只看草稿正文：Agent 自己说出「停药」必须抬风险
  const flagged = h.service.review({
    body: '您可以先停药观察。',
    riskLevel: 'low',
    patientId: 'pt_4',
    source: 'inbound',
    inboundText: '我血压有点高。',
  });
  assert.deepEqual(flagged.hits, ['rul_builtin_no_medication']);
  assert.equal(flagged.riskLevel, 'high');
});

test('#37 运行链路：改稿分支同样过门禁', async () => {
  const h = harness();
  const runtimeHarness = setupRuntime({ guard: h.service });
  observeServiceGroup(runtimeHarness, { status: 'serving', advisorId: 'adv_1' });

  // 先走一轮普通入站，让患者与群绑定建立起来
  runtimeHarness.sessions.onPrompt = async (sessionId) => {
    await runtimeHarness.runtime.replyDraft(sessionId, {
      body: '今晚吃点清淡的，早点休息。',
      inboundSummary: '家属描述胸痛',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };
  runtimeHarness.runtime.routeInbound({
    msgid: 'm_setup',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '我爸刚才胸口很痛，喘不上气。',
    msgtime: 1_700_000_000_000,
  });
  runtimeHarness.clock.advance(30_000);
  await runtimeHarness.runtime.flushDue();

  runtimeHarness.bridge.seedDraft({
    id: 'draft_old',
    advisorId: 'adv_1',
    groupRoomId: 'wr_g1',
    customerId: 'wm_patient',
  });

  runtimeHarness.sessions.onPrompt = async (sessionId) => {
    await runtimeHarness.runtime.replyDraft(sessionId, {
      body: '您可以停药试试。',
      inboundSummary: '改稿',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  const handled = await runtimeHarness.runtime.handleAdvisorText('wang.guwen', '语气再温和一点');
  assert.equal(handled, true);
  assert.equal(runtimeHarness.bridge.revisions.length, 1);
  const revised = runtimeHarness.bridge.revisions[0]!;
  assert.equal(revised.draftId, 'draft_old');
  assert.equal(revised.input.riskLevel, 'high');
  // 改稿回合没有新消息，但患者上一轮的急症描述仍会复核，正文保持就医引导
  assert.equal(revised.input.body, REFERRAL_BODY);
  assert.deepEqual(revised.input.ruleIds, ['rul_builtin_no_medication', 'rul_builtin_emergency']);
  assert.deepEqual(revised.input.ruleNames, ['不调药', '急症只引导就医']);
  assert.ok(runtimeHarness.events.some((event) => event.type === 'draft.guard.hit'));
});

// ---------- 插件装配 ----------

class FakeTable {
  readonly map = new Map<string, unknown>();

  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries();
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

class FakeDomain {
  readonly tables = new Map<string, FakeTable>();
  closed = false;

  table(name: string): FakeTable {
    const table = this.tables.get(name) ?? new FakeTable();
    this.tables.set(name, table);
    return table;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function pluginHarness(patientForSession?: (sessionId: string) => string | undefined) {
  const domain = new FakeDomain();
  const provided = new Map<string, unknown>();
  const events: Array<{ type: string; data: unknown }> = [];
  const tools: Array<{ name: string; execute(args: unknown, exec: unknown): Promise<unknown> }> = [];
  const logs: string[] = [];
  const effects: Array<Promise<unknown>> = [];

  const ctx = {
    logger: { info: (line: string) => logs.push(line) },
    effect: (fn: () => unknown) => {
      const promise = Promise.resolve().then(fn);
      effects.push(promise);
      return promise;
    },
    emit: (type: string, data: unknown) => events.push({ type, data }),
    provide: (name: string, value: unknown) => provided.set(name, value),
    get: (name: string) =>
      name === 'zhibanPatient' && patientForSession ? { patientForSession } : undefined,
    storageDomain: {
      async open() {
        return domain;
      },
    },
    tools: {
      register: (definition: unknown) => {
        tools.push(definition as (typeof tools)[number]);
      },
    },
  };

  return { domain, provided, events, tools, logs, effects, ctx };
}

test('#37 插件装配：内置规则落盘、escalate_to_human 注册、会话反查患者', async () => {
  const h = pluginHarness((sessionId) => (sessionId === 's_1' ? 'pt_1' : undefined));
  applyGuardPlugin(h.ctx as never, { tenantId: 'tn_test' });
  const cleanups = await Promise.all(h.effects);
  const cleanup = cleanups[0] as () => Promise<void>;

  const api = h.provided.get('zhibanGuard') as {
    listRules(): RiskRuleRecord[];
    review(input: {
      body: string;
      riskLevel: 'low' | 'medium' | 'high';
      patientId: string;
      source: 'inbound' | 'proactive';
    }): { hitNames: string[] };
    alerts(patientId?: string): GuardAlertRecord[];
    flush(): Promise<void>;
  };
  assert.ok(api);
  assert.equal(api.listRules().length, 4);
  assert.equal(h.tools.length, 1);
  assert.equal(h.tools[0]!.name, 'escalate_to_human');
  assert.equal(h.domain.tables.get('rules')?.map.size, 4);

  const reviewed = api.review({
    body: '这个可以保证根治。',
    riskLevel: 'low',
    patientId: 'pt_1',
    source: 'inbound',
  });
  assert.ok(reviewed.hitNames.includes('不承诺疗效'));

  const result = (await h.tools[0]!.execute(
    { reason: 'patient_request' },
    { agent: { id: 's_1' } },
  )) as { alertId: string; reason: string };
  assert.equal(result.reason, 'patient_request');
  assert.ok(api.alerts('pt_1').some((alert) => alert.id === result.alertId));

  await assert.rejects(
    h.tools[0]!.execute({ reason: 'other' }, { agent: { id: 's_2' } }),
    /INVALID_TOOL_ARGS/,
  );

  const alertRows = h.domain.tables.get('alerts');
  await api.flush();
  assert.ok((alertRows?.map.size ?? 0) >= 2);
  await cleanup();
  assert.equal(h.domain.closed, true);
});

test('#37 LazyDraftGuard：guard 未就绪时返回未命中，就绪后转发', () => {
  const input = {
    body: '可以停药。',
    riskLevel: 'low' as const,
    patientId: 'pt_1',
    source: 'inbound' as const,
  };
  const lazy = new LazyDraftGuard(() => undefined);
  const empty = lazy.review(input);
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.riskLevel, 'low');
  assert.equal(empty.guideOnly, false);

  const h = harness();
  const withGuard = new LazyDraftGuard(() => h.service);
  const result = withGuard.review(input);
  assert.ok(result.hits.includes('rul_builtin_no_medication'));
  assert.equal(result.riskLevel, 'high');
});

test('#37 配置：tenantId 必填，sandbox 默认 false', () => {
  assert.throws(() => parseGuardConfig({}), /缺少配置项 tenantId/);
  assert.throws(() => parseGuardConfig(null), /插件配置必须是对象/);
  assert.throws(() => parseGuardConfig({ tenantId: 'tn', sandbox: 'yes' }), /sandbox 必须是布尔值/);
  assert.deepEqual(parseGuardConfig({ tenantId: 'tn' }), { tenantId: 'tn', sandbox: false });
  assert.deepEqual(parseGuardConfig({ tenantId: 'tn', sandbox: true }), {
    tenantId: 'tn',
    sandbox: true,
  });
});
