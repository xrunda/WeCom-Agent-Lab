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
  renderAction,
  renderGet,
  renderMealPhoto,
  renderMealSummary,
  renderPatients,
  renderPendingReplies,
  renderSearch,
  searchKnowledge,
  searchScripts,
  validateAdvisorChronic,
  validateAdvisorDiscard,
  validateAdvisorGet,
  validateAdvisorMealPhoto,
  validateAdvisorMealSummary,
  validateAdvisorMeals,
  validateAdvisorPromiseResolve,
  validateAdvisorSearch,
} from '../src/p1/advisor/tools.ts';
import { buildAdvisorAgentsMd } from '../src/p1/advisor/persona.ts';
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
    mealPhoto: async () => ({ status: 'forbidden' }),
    discardDraft: async () => ({ status: 'not-found' }),
    resolvePromise: async () => ({ status: 'not-found' }),
    patients: async () => ({ status: 'unconnected' }),
    mealSummary: async () => ({ status: 'unconnected' }),
    pendingReplies: async () => ({ status: 'unconnected' }),
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
    mealPhoto: async () => ({ status: 'forbidden' }),
    discardDraft: async () => ({ status: 'not-found' }),
    resolvePromise: async () => ({ status: 'not-found' }),
    patients: async () => ({ status: 'unconnected' }),
    mealSummary: async () => ({ status: 'unconnected' }),
    pendingReplies: async () => ({ status: 'unconnected' }),
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

test('patient_meal_photo 参数校验：patientId 与 mealType 必填，餐次闭集', () => {
  assert.ok(validateAdvisorMealPhoto({ patientId: 'p1', mealType: 'breakfast' }).ok);
  assert.ok(validateAdvisorMealPhoto({ patientId: 'p1', mealType: 'dinner', date: '2026-11-15' }).ok);
  assert.ok(!validateAdvisorMealPhoto({ patientId: '' , mealType: 'breakfast'}).ok);
  assert.ok(!validateAdvisorMealPhoto({ patientId: 'p1' }).ok, 'mealType 必填');
  assert.ok(!validateAdvisorMealPhoto({ patientId: 'p1', mealType: '宵夜' }).ok, '餐次闭集');
  assert.ok(!validateAdvisorMealPhoto({ patientId: 'p1', mealType: 'breakfast', date: '11-15' }).ok);
});

test('renderMealPhoto：有原图报「已发出」，无原图如实说没有', () => {
  const withPhoto = renderMealPhoto({
    status: 'ok',
    patientId: 'p1',
    displayName: '汪女士',
    date: '2026-11-15',
    mealType: 'breakfast',
    mealLabel: '11月15日 早餐',
    time: '09:10',
    hasPhoto: true,
  });
  assert.match(withPhoto, /已发出 11月15日 早餐 09:10 的原图/);

  const noPhoto = renderMealPhoto({
    status: 'ok',
    patientId: 'p1',
    displayName: '汪女士',
    date: '2026-11-15',
    mealType: 'dinner',
    mealLabel: '11月15日 晚餐',
    time: '18:30',
    hasPhoto: false,
  });
  assert.match(noPhoto, /11月15日 晚餐 18:30 只有文字记录，没有原图/);

  const noMeal = renderMealPhoto({
    status: 'ok',
    patientId: 'p1',
    displayName: '汪女士',
    date: '2026-11-15',
    mealType: 'dinner',
    mealLabel: '11月15日 晚餐',
    hasPhoto: false,
  });
  assert.match(noMeal, /11月15日 晚餐当天没有这条餐次记录，没有原图可发/);
  assert.match(renderMealPhoto({ status: 'forbidden' }), /没有权限/);
});

test('draft_discard / promise_resolve 参数校验：id 必填、outcome 闭集', () => {
  assert.ok(validateAdvisorDiscard({ draftId: 'd1' }).ok);
  assert.ok(!validateAdvisorDiscard({}).ok);
  assert.ok(validateAdvisorPromiseResolve({ promiseId: 'prom_1', outcome: 'done' }).ok);
  assert.ok(validateAdvisorPromiseResolve({ promiseId: 'prom_1', outcome: 'dismissed' }).ok);
  assert.ok(!validateAdvisorPromiseResolve({ promiseId: 'prom_1' }).ok, 'outcome 必填');
  assert.ok(!validateAdvisorPromiseResolve({ promiseId: 'prom_1', outcome: 'later' }).ok);
  assert.ok(!validateAdvisorPromiseResolve({ promiseId: '', outcome: 'done' }).ok);
});

test('renderAction：如实说做了什么，不编造', () => {
  assert.match(renderAction({ status: 'ok', message: '已作废草稿 d1。' }), /已作废草稿 d1/);
  assert.match(renderAction({ status: 'not-found' }), /没有找到/);
  assert.match(renderAction({ status: 'forbidden' }), /没有权限/);
  assert.match(renderAction({ status: 'not-actionable', reason: '已确认发送' }), /当前状态不能执行这个操作：已确认发送/);
  assert.match(renderAction({ status: 'unconnected' }), /还没接入/);
});

test('patient_meal_summary 参数校验：date 必须是 YYYY-MM-DD', () => {
  assert.ok(validateAdvisorMealSummary({}).ok);
  assert.ok(validateAdvisorMealSummary({ date: '2026-11-15' }).ok);
  assert.ok(!validateAdvisorMealSummary({ date: '11-15' }).ok);
});

test('renderPatients：列出本人患者，无患者如实说没有', () => {
  const text = renderPatients({
    status: 'ok',
    items: [
      { patientId: 'p1', displayName: '汪女士', tags: ['高血压'] },
      { patientId: 'p3', displayName: 'ATHM_wb001', tags: [] },
    ],
  });
  assert.match(text, /2 位患者/);
  assert.match(text, /汪女士（p1） · 标签：高血压/);
  assert.match(text, /ATHM_wb001（p3）/);
  assert.match(renderPatients({ status: 'ok', items: [] }), /还没有患者/);
});

test('renderMealSummary：按天汇总患者，无记录如实说没有', () => {
  const text = renderMealSummary({
    status: 'ok',
    date: '2026-11-15',
    items: [
      {
        patientId: 'p1',
        displayName: '汪女士',
        meals: ['早餐 09:10', '午餐 12:20'],
        hasPhoto: true,
      },
    ],
  });
  assert.match(text, /2026-11-15 有 1 位患者上传了饮食记录/);
  assert.match(text, /早餐 09:10、午餐 12:20/);
  assert.match(text, /有原图/);
  assert.match(
    renderMealSummary({ status: 'ok', date: '2026-11-14', items: [] }),
    /2026-11-14 没有患者上传饮食记录/,
  );
});

test('renderPendingReplies：列出待回复会话与摘要', () => {
  const text = renderPendingReplies({
    status: 'ok',
    items: [
      { convKey: 'room:r1', customerId: 'wm_1', excerpt: '我今天有点头晕', reason: 'ambiguous', lastAt: 0 },
      { convKey: 'dm:a:b', customerId: 'wm_2', excerpt: '[图片]', reason: 'media', lastAt: 0 },
    ],
  });
  assert.match(text, /2 个会话等你回复/);
  assert.match(text, /我今天有点头晕（待回应）/);
  assert.match(text, /\[图片\]（发了图片\/语音）/);
  assert.match(renderPendingReplies({ status: 'ok', items: [] }), /现在没有待回复的会话/);
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
    mealPhoto: async () => ({ status: 'forbidden' }),
    discardDraft: async () => ({ status: 'not-found' }),
    resolvePromise: async () => ({ status: 'not-found' }),
    patients: async () => ({ status: 'unconnected' }),
    mealSummary: async () => ({ status: 'unconnected' }),
    pendingReplies: async () => ({ status: 'unconnected' }),
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

test('人设：点名患者侧工具在顾问会话不可用，且饮食记录只在控制台看', () => {
  const md = buildAdvisorAgentsMd();
  assert.match(md, /reply_draft/);
  assert.match(md, /meal_log_write/);
  assert.match(md, /控制台患者页/);
  assert.match(md, /不得.*编造|绝不补数值/);
});

test('人设：回答先结论后明细，问有没有先直接答有/没有，禁止分节把结论埋中间', () => {
  const md = buildAdvisorAgentsMd();
  assert.match(md, /第一行先给直接答案/);
  assert.match(md, /有没有上报.*第一句直接写「有」或「没有」|问「有没有上报/);
  assert.match(md, /禁止.*「一、事实」「二、说明」「三、建议」|禁止.*一、事实/);
});

test('人设：默认不发餐食照片，只有显式要看某餐原图才调 patient_meal_photo', () => {
  const md = buildAdvisorAgentsMd();
  assert.match(md, /默认不发餐食照片/);
  assert.match(md, /patient_meal_photo/);
  assert.match(md, /patient_meals.*只返回文字，不附图/);
  assert.match(md, /图片一定出现在文字回复之后/);
});

test('人设：待办提示必须可行动，草稿/承诺详情可读、处置需顾问确认', () => {
  const md = buildAdvisorAgentsMd();
  assert.match(md, /每轮前缀里的「今日：」会带待办的计数和 id/);
  assert.match(md, /绝不能说「我缺 id，请你把 id 贴给我」/);
  assert.match(md, /advisor_get\(scope=draft \/ scope=promise\)/);
  assert.match(md, /draft_discard/);
  assert.match(md, /promise_resolve/);
  assert.match(md, /未经顾问逐条确认.*不得.*批量/);
  assert.match(md, /不要替顾问判断承诺有没有兑现/);
});

test('人设：工具清单只列已有工具，不编造 schedule_create 等', () => {
  const md = buildAdvisorAgentsMd();
  assert.match(md, /工具清单/);
  assert.match(md, /schedule_create.*是患者会话的工具/);
  assert.match(md, /没有.*schedule_create/);
});

test('人设：按天跨患者问题先调汇总工具，不逐个患者查、不问「你要查谁」', () => {
  const md = buildAdvisorAgentsMd();
  assert.match(md, /patient_meal_summary/);
  assert.match(md, /不要逐个患者查、更不要问顾问「你要查谁」/);
  assert.match(md, /advisor_patients/);
  assert.match(md, /advisor_pending_replies/);
});
