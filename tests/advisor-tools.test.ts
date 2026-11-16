/**
 * 顾问 Agent 工具层（#167）：身份解析、参数校验、检索、render 原文照抄。
 * 全部虚构数据，不依赖 DSH。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADVISOR_SESSION_PREFIX,
  advisorIdFromSession,
  buildAdvisorToolDefinitions,
  maskedDisplayName,
  rankKnowledge,
  renderGet,
  renderSearch,
  searchKnowledge,
  searchScripts,
  validateAdvisorChronic,
  validateAdvisorGet,
  validateAdvisorMeals,
  validateAdvisorSearch,
} from '../src/p1/advisor/tools.ts';
import type {
  AdvisorGetResult,
  AdvisorOverviewResult,
  AdvisorSearchResult,
} from '../src/p1/advisor/types.ts';

test('会话 id → 顾问 id：只认 zhiban-advisor- 前缀，参数里不出现 advisorId', () => {
  assert.equal(advisorIdFromSession(`${ADVISOR_SESSION_PREFIX}adv_1`), 'adv_1');
  assert.equal(advisorIdFromSession('zhiban-patient-p1'), undefined);
  assert.equal(advisorIdFromSession(undefined), undefined);
  assert.equal(advisorIdFromSession(`${ADVISOR_SESSION_PREFIX}`), undefined);
});

test('参数校验：scope 闭集、query 非空、patientId 非空', () => {
  assert.ok(validateAdvisorSearch({ scope: 'knowledge', query: '饮食' }).ok);
  assert.ok(!validateAdvisorSearch({ scope: 'rule', query: 'x' }).ok, 'rule 不能 search');
  assert.ok(!validateAdvisorSearch({ scope: 'knowledge', query: '' }).ok);
  assert.ok(!validateAdvisorSearch({ scope: 'draft', query: 'x' }).ok, 'draft 是 v2 scope');
  assert.ok(validateAdvisorGet({ scope: 'rule', id: 'r1' }).ok);
  assert.ok(!validateAdvisorGet({ scope: 'rule', id: '' }).ok);
  assert.ok(validateAdvisorChronic({ patientId: 'p1' }).ok);
  assert.ok(!validateAdvisorChronic({ patientId: '' }).ok);
});

test('知识检索：标题 > 分类 > 正文，未命中为空', () => {
  const records = [
    { id: 'k1', category: '饮食', title: '高血压患者的日常饮食', content: '低盐……', enabled: true },
    { id: 'k2', category: '饮食', title: '睡眠建议', content: '高血压患者应保证睡眠', enabled: true },
    { id: 'k3', category: '运动', title: '散步', content: '每天散步 30 分钟', enabled: true },
  ];
  const matched = searchKnowledge(records, '高血压');
  assert.equal(matched.length, 2);
  assert.equal(matched[0]!.id, 'k1', '标题命中排最前');
  assert.equal(rankKnowledge(records[2]!, '散步'), 3);
  assert.equal(searchKnowledge(records, '不存在的词').length, 0);
});

test('话术检索：分类名只返回该分类，标题优先', () => {
  const scripts = [
    { id: 's1', category: '饮食', title: '控糖饮食话术', content: '……', tags: [] },
    { id: 's2', category: '饮食', title: '降血压话术', content: '提到饮食搭配……', tags: [] },
    { id: 's3', category: '复诊', title: '复诊提醒话术', content: '……', tags: ['复诊'] },
  ];
  const byCategory = searchScripts(scripts, '饮食');
  assert.equal(byCategory.length, 2);
  const byTitle = searchScripts(scripts, '复诊提醒');
  assert.equal(byTitle[0]!.id, 's3');
});

test('患者名掩码：patient.read 未授权时只返回 id 尾号', () => {
  assert.equal(maskedDisplayName('汪女士', 'p_123456'), '汪女士');
  assert.equal(maskedDisplayName('', 'p_123456'), '患者 123456');
  assert.equal(maskedDisplayName(undefined, 'p_123456'), '患者 123456');
});

test('renderSearch：知识命中逐字输出原文并带条目 id', () => {
  const result: AdvisorSearchResult = {
    status: 'ok',
    scope: 'knowledge',
    query: '饮食',
    found: 1,
    items: [{ id: 'k1', title: '高血压饮食', category: '饮食', content: '低盐低脂，控制主食。' }],
  };
  const text = renderSearch(result);
  assert.match(text, /\[k1\]/);
  assert.match(text, /低盐低脂，控制主食。/);
  assert.match(text, /不得改写/);
});

test('renderSearch：未命中明确说没有，不造条目', () => {
  const text = renderSearch({ status: 'ok', scope: 'knowledge', query: 'xyz', found: 0, items: [] });
  assert.match(text, /没有找到/);
});

test('renderGet：规则原文逐字输出', () => {
  const result: AdvisorGetResult = {
    status: 'ok',
    scope: 'rule',
    id: 'r1',
    item: {
      id: 'r1',
      title: '不承诺疗效',
      category: 'redline',
      content: '规则名：不承诺疗效\n触发关键词：保证、疗效\n风险等级：高风险\n处理动作：提示',
    },
  };
  const text = renderGet(result);
  assert.match(text, /保证、疗效/);
  assert.match(text, /不得改写/);
});

test('renderGet：无权限 / 未命中如实说明', () => {
  assert.match(renderGet({ status: 'forbidden' }), /没有权限/);
  assert.match(renderGet({ status: 'not-found', scope: 'knowledge', id: 'k9' }), /没有找到/);
});

test('工具 execute：从 exec.agent.id 解析顾问身份并转发 handler', async () => {
  const called: Array<{ name: string; args: unknown }> = [];
  const tools = buildAdvisorToolDefinitions({
    overview: async () => ({ snapshot: {} as never }),
    search: async (advisorId, scope, query) => {
      called.push({ name: 'search', args: { advisorId, scope, query } });
      return { status: 'ok', scope, query, found: 0, items: [] };
    },
    get: async () => ({ status: 'not-found', scope: 'knowledge', id: 'x' }),
    chronic: async () => ({ status: 'forbidden' }),
    meals: async () => ({ status: 'unconnected' }),
  });
  const searchTool = tools.find((tool) => tool.name === 'advisor_search')!;
  await searchTool.execute({ scope: 'knowledge', query: '饮食' }, { agent: { id: 'zhiban-advisor-adv_1' } });
  assert.deepEqual(called[0]!.args, { advisorId: 'adv_1', scope: 'knowledge', query: '饮食' });
  await assert.rejects(
    searchTool.execute({ scope: 'knowledge', query: '饮食' }, { agent: { id: 'zhiban-patient-p1' } }),
    /INVALID_TOOL_ARGS/,
  );
});

test('overview render：待办输出与「我的待办」命令共用同一个函数', () => {
  const tools = buildAdvisorToolDefinitions({
    overview: async () => ({ snapshot: { drafts: [], promises: [], alerts: [], now: 0 } } as AdvisorOverviewResult),
    search: async () => ({ status: 'ok', scope: 'knowledge', query: '', found: 0, items: [] }),
    get: async () => ({ status: 'not-found', scope: 'knowledge', id: 'x' }),
    chronic: async () => ({ status: 'forbidden' }),
    meals: async () => ({ status: 'unconnected' }),
  });
  const overviewTool = tools.find((tool) => tool.name === 'advisor_overview')!;
  const rendered = overviewTool.output.render({}, { snapshot: { drafts: [], promises: [], alerts: [], now: 0 } });
  assert.equal(rendered[0]!.text, '现在没有待办：没有未完成草稿、今天没有到期承诺、也没有未处理告警。');
});

test('patient_meals 参数校验：patientId 必填，date 必须是 YYYY-MM-DD', () => {
  assert.ok(validateAdvisorMeals({ patientId: 'p1' }).ok);
  assert.ok(validateAdvisorMeals({ patientId: 'p1', date: '2026-11-15' }).ok);
  assert.ok(!validateAdvisorMeals({ patientId: '' }).ok);
  assert.ok(!validateAdvisorMeals({ patientId: 'p1', date: '11-15' }).ok);
});

test('patient_meals 渲染：按餐次列出食物，没记录如实说没有', () => {
  const tools = buildAdvisorToolDefinitions({
    overview: async () => ({ snapshot: {} as never }),
    search: async () => ({ status: 'ok', scope: 'knowledge', query: '', found: 0, items: [] }),
    get: async () => ({ status: 'not-found', scope: 'knowledge', id: 'x' }),
    chronic: async () => ({ status: 'forbidden' }),
    meals: async () => ({
      status: 'ok',
      patientId: 'p1',
      displayName: '汪女士',
      date: '2026-11-15',
      hasRecord: true,
      meals: [
        { mealType: 'breakfast', time: '08:10', foods: ['燕麦粥', '鸡蛋（1 个）'], confidence: 0.8 },
      ],
    }),
  });
  const tool = tools.find((item) => item.name === 'patient_meals')!;
  const rendered = tool.output.render(
    {},
    {
      status: 'ok',
      patientId: 'p1',
      displayName: '汪女士',
      date: '2026-11-15',
      hasRecord: true,
      meals: [
        { mealType: 'breakfast', time: '08:10', foods: ['燕麦粥', '鸡蛋（1 个）'], confidence: 0.8 },
      ],
    },
  );
  assert.match(rendered[0]!.text, /2026-11-15/);
  assert.match(rendered[0]!.text, /早餐 08:10/);
  assert.match(rendered[0]!.text, /燕麦粥/);
  assert.match(rendered[0]!.text, /80%/);

  const empty = tool.output.render(
    {},
    { status: 'ok', patientId: 'p1', displayName: '汪女士', date: '2026-11-15', hasRecord: false, meals: [] },
  );
  assert.match(empty[0]!.text, /没有饮食记录/);
});
