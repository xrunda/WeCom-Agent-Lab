/**
 * PH5-04 方案生成接入测试：提示词约束、草稿校验、医疗红线、失败不降级。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPlanPrompts,
  FORBIDDEN_MEDICAL_TERMS,
  LlmPlanGenerator,
  parsePlanDraft,
  stripTimePrefix,
} from '../src/p1/patient-h5-plan-ai.ts';
import type { PlanChatPort } from '../src/p1/patient-h5-plan-ai.ts';

const VALID = {
  stageGoal: '把三餐吃规律，晚餐清淡一点',
  foodTherapyRationale: '先从规律三餐开始，再逐步减少晚餐油腻。',
  focusPoints: ['三餐按时', '晚餐不过饱'],
  actions: [
    {
      title: '早餐记录',
      purpose: '看看早餐够不够丰富',
      method: '拍照或写一句吃了什么',
      schedule: { kind: 'daily', time: '07:30' },
      feedbackKind: 'record_meal',
    },
  ],
  feedbackRequirements: ['每晚回顾睡眠'],
};

test('提示词包含禁止诊断/用药的约束，且不预设固定周期', () => {
  const { systemPrompt, userPrompt } = buildPlanPrompts({
    startDate: '2026-12-01',
    endDate: '2026-12-21',
    profile: [{ fieldKey: 'goal', valueText: '改善睡眠' }],
  });
  assert.match(systemPrompt, /禁止诊断/);
  assert.match(systemPrompt, /剂量/);
  assert.match(systemPrompt, /不要自行假设固定周期/);
  assert.match(userPrompt, /2026-12-01 至 2026-12-21/);
  assert.match(userPrompt, /改善睡眠/);
});

test('合法草稿通过校验，actionId 由服务端生成', () => {
  const parsed = parsePlanDraft(VALID);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.draft.actions[0]?.actionId, 'act_1');
  assert.equal(parsed.draft.actions[0]?.schedule.time, '07:30');
});

test('结构性错误被逐条指出（缺字段、时间格式、行动数量）', () => {
  const parsed = parsePlanDraft({
    stageGoal: '',
    foodTherapyRationale: 'x',
    focusPoints: ['只有一条'],
    actions: [
      { title: 'a', purpose: 'b', method: 'c', schedule: { kind: 'daily', time: '7点' }, feedbackKind: 'checkin' },
    ],
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.violations.some((item) => item.includes('stageGoal')));
  assert.ok(parsed.violations.some((item) => item.includes('focusPoints')));
  assert.ok(parsed.violations.some((item) => item.includes('time')));
});

test('命中医疗红线（诊断/剂量/mg 等）整份拒绝，不交给审核人兜底', () => {
  for (const term of ['诊断', '剂量', 'mg']) {
    const parsed = parsePlanDraft({ ...VALID, stageGoal: `按医嘱${term}调整` });
    assert.equal(parsed.ok, false, term);
    if (!parsed.ok) {
      assert.ok(parsed.violations.some((item) => item.includes('医疗行为词')));
    }
  }
  assert.ok(FORBIDDEN_MEDICAL_TERMS.includes('疗效'));
});

test('生成器：端口不可用时返回 UPSTREAM_UNAVAILABLE，不编造草稿', async () => {
  const port: PlanChatPort = { available: false, runTurn: async () => ({ error: 'NO_DRAFT' }) };
  const generator = new LlmPlanGenerator({ port });
  const result = await generator.generate({
    patientId: 'pat_a',
    profile: [],
    startDate: '2026-12-01',
    endDate: '2026-12-21',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, 'UPSTREAM_UNAVAILABLE');
});

test('生成器：模型没调工具 → NO_DRAFT；输出非法 → INVALID_DRAFT', async () => {
  const noDraft: PlanChatPort = { available: true, runTurn: async () => ({ error: 'NO_DRAFT' }) };
  const a = await new LlmPlanGenerator({ port: noDraft }).generate({
    patientId: 'p',
    profile: [],
    startDate: '2026-12-01',
    endDate: '2026-12-21',
  });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.errorCode, 'NO_DRAFT');

  const bad: PlanChatPort = { available: true, runTurn: async () => ({ toolArgs: { nope: 1 } }) };
  const b = await new LlmPlanGenerator({ port: bad }).generate({
    patientId: 'p',
    profile: [],
    startDate: '2026-12-01',
    endDate: '2026-12-21',
  });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.errorCode, 'INVALID_DRAFT');
});

test('生成器：成功时带上模型名与提示词版本，便于追溯', async () => {
  const port: PlanChatPort = { available: true, runTurn: async () => ({ toolArgs: VALID }) };
  const generator = new LlmPlanGenerator({ port, modelName: 'deepseek-flash' });
  const result = await generator.generate({
    patientId: 'p',
    profile: [{ fieldKey: 'goal', valueText: '改善睡眠' }],
    startDate: '2026-12-01',
    endDate: '2026-12-21',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.model, 'deepseek-flash');
  assert.equal(result.draft.promptVersion, 'plan-v1');
  assert.equal(result.draft.actions.length, 1);
});

test('标题里的时间前缀被清洗：界面会单独渲染 schedule.time，重复就成「21:00 21:00 放下屏幕」', () => {
  assert.equal(stripTimePrefix('21:00 放下屏幕'), '放下屏幕');
  assert.equal(stripTimePrefix('21：00 放下屏幕'), '放下屏幕');
  assert.equal(stripTimePrefix('每天 06:30 固定起床'), '固定起床');
  assert.equal(stripTimePrefix('7点 半 定时起身'), '定时起身');
  assert.equal(stripTimePrefix('三餐按点开饭'), '三餐按点开饭');
  assert.equal(stripTimePrefix('21:00'), '21:00', '清洗后为空时保留原值，避免动作变无名');
  // 解析草稿时也走同一清洗
  const parsed = parsePlanDraft({
    ...VALID,
    actions: [{ ...VALID.actions[0], title: '21:00 放下屏幕' }],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.draft.actions[0]?.title, '放下屏幕');
});

test('提示词明确要求标题不写时间，时间只放在 schedule.time', () => {
  const { userPrompt } = buildPlanPrompts({
    startDate: '2026-12-01',
    endDate: '2026-12-07',
    profile: [{ fieldKey: 'goal', valueText: '改善睡眠' }],
  });
  assert.match(userPrompt, /title 不要写时间/);
});
