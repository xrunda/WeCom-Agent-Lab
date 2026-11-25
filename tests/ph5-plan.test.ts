/**
 * PH5-04（#233）方案生成、审核发布与版本变更测试。
 *
 * 覆盖 issue 验收：
 * - AI 失败/资料缺失不假装成功，保留资料可人工接管（A03）
 * - 未审核对患者不可见；审核人可追溯（A04）
 * - 计划与日历同版本；换版取消未来事项、历史不改写；不能重复发布（A05）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import {
  MemoryPlanBackend,
  PlanError,
  PlanService,
  UNCONFIGURED_GENERATOR,
} from '../src/p1/patient-h5-plan.ts';
import type { PlanAction, PlanGenerationPort } from '../src/p1/patient-h5-plan.ts';
import { MemoryProfileBackend, ProfileService } from '../src/p1/patient-h5-profile.ts';

const TENANT = 'tn_ph5_plan';
const START = '2026-12-01';
const END = '2026-12-07';

function actions(): PlanAction[] {
  return [
    {
      actionId: 'act_1',
      title: '早餐记录',
      purpose: '看看早餐够不够丰富',
      method: '拍照或文字记录',
      schedule: { kind: 'daily', time: '07:30' },
      feedbackKind: 'record_meal',
      linkedArticleIds: [],
    },
  ];
}

const OK_GENERATOR: PlanGenerationPort = {
  configured: true,
  async generate(input) {
    return {
      ok: true,
      draft: {
        stageGoal: '把三餐吃规律',
        foodTherapyRationale: '先从规律三餐开始',
        focusPoints: ['早餐有蔬菜'],
        actions: actions(),
        feedbackRequirements: ['每晚回顾'],
        ruleRefs: [],
        model: 'test-model',
        promptVersion: 'v1',
      },
    };
  },
};

async function setup(options: { generator?: PlanGenerationPort } = {}) {
  const clock = new FakeClock(new Date('2026-11-25T10:00:00+08:00').getTime());
  const profileBackend = new MemoryProfileBackend();
  const profile = new ProfileService({
    backend: profileBackend,
    tenantId: TENANT,
    ids: idFactory(() => clock.now()),
  });
  const backend = new MemoryPlanBackend();
  const events: Array<{ type: string; cancelledItemIds: string[] }> = [];
  const plan = new PlanService({
    tenantId: TENANT,
    backend,
    generator: options.generator ?? OK_GENERATOR,
    profile,
    ids: idFactory(() => clock.now()),
    ...{ now: () => clock.now() },
    onPlanEvent: (event) => events.push({ type: event.type, cancelledItemIds: event.cancelledItemIds }),
  });
  // 补齐安全信息，避免走 data_pending 分支
  await profile.submitAnswers({
    patientId: 'pat_a',
    step: 'safety',
    answers: { allergy: { items: ['海鲜（自述）'], unknown: false } },
    decidedVia: 'test',
  });
  return { clock, backend, profile, plan, events };
}

test('资料安全信息缺失时进入 data_pending，不生成可执行方案（A03）', async () => {
  const clock = new FakeClock(Date.now());
  const profile = new ProfileService({
    backend: new MemoryProfileBackend(),
    tenantId: TENANT,
    ids: idFactory(() => clock.now()),
  });
  const plan = new PlanService({
    tenantId: TENANT,
    backend: new MemoryPlanBackend(),
    generator: OK_GENERATOR,
    profile,
    ids: idFactory(() => clock.now()),
  });
  const record = await plan.generate({
    patientId: 'pat_a',
    startDate: START,
    endDate: END,
    actorId: 'acc_1',
  });
  assert.equal(record.status, 'data_pending');
  assert.equal(record.actions.length, 0);
  assert.equal(record.inputSnapshot.profileEntryIds.length, 0);
});

test('模型不可用时进入 generate_failed，保留输入快照并可人工接管', async () => {
  const { plan } = await setup({ generator: UNCONFIGURED_GENERATOR });
  const record = await plan.generate({
    patientId: 'pat_a',
    startDate: START,
    endDate: END,
    actorId: 'acc_1',
  });
  assert.equal(record.status, 'generate_failed');
  assert.equal(record.generation.errorCode, 'UPSTREAM_UNAVAILABLE');
  assert.ok(record.inputSnapshot.profileEntryIds.length > 0, '快照保留');
  // 人工接管：同一方案可被编辑后进入审核
  const edited = await plan.update({
    planId: record.id,
    actorId: 'acc_1',
    expectedVersion: record.version,
    patch: { stageGoal: '人工拟定目标', actions: actions() },
  });
  assert.equal(edited.status, 'reviewing');
});

test('未审核方案对患者不可见；发布后可见且携带审核人（A04）', async () => {
  const { plan } = await setup();
  const record = await plan.generate({
    patientId: 'pat_a',
    startDate: START,
    endDate: END,
    actorId: 'acc_1',
  });
  assert.equal(record.status, 'reviewing');
  assert.equal(plan.currentForPatient('pat_a'), undefined, '待审核不可见');

  const published = await plan.publish({
    planId: record.id,
    actorId: 'acc_2',
    actorName: '陈营养师（虚构）',
  });
  assert.equal(published.status, 'published');
  assert.equal(published.review.status, 'approved');
  assert.equal(published.review.reviewerName, '陈营养师（虚构）');
  assert.ok(published.review.reviewedAt);
  assert.equal(plan.currentForPatient('pat_a')?.id, record.id);
});

test('发布生成同版本日历事项，日期落在计划区间且不含过去', async () => {
  const { plan } = await setup();
  const record = await plan.generate({
    patientId: 'pat_a',
    startDate: START,
    endDate: END,
    actorId: 'acc_1',
  });
  await plan.publish({ planId: record.id, actorId: 'acc_2', actorName: '审核人' });
  const items = plan.listCalendarItems('pat_a');
  assert.equal(items.length, 7, '12-01 至 12-07 共 7 条');
  assert.ok(items.every((item) => item.planVersion === record.version));
  assert.ok(items.every((item) => item.planId === record.id));
  assert.equal(items[0]?.scheduledDate, START);
});

test('换版：旧版 superseded、未来事项取消、历史不改写、同一时刻只有一个 published（A05）', async () => {
  const { plan, clock } = await setup();
  const v1 = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  await plan.publish({ planId: v1.id, actorId: 'acc_2', actorName: '审核人' });

  // 模拟第一天已完成
  const first = plan.listCalendarItems('pat_a')[0]!;
  first.status = 'done';
  first.feedback = { kind: 'patient_confirmed', submittedAt: clock.now() };
  await plan['backend'].putCalendarItem(first);

  clock.advance(3 * 24 * 60 * 60 * 1000);
  const v2 = await plan.generate({
    patientId: 'pat_a',
    startDate: START,
    endDate: END,
    actorId: 'acc_1',
  });
  assert.equal(v2.version, 2);
  await plan.publish({ planId: v2.id, actorId: 'acc_2', actorName: '审核人' });

  const plans = plan.list('pat_a');
  const old = plans.find((item) => item.version === 1)!;
  assert.equal(old.status, 'superseded');
  assert.ok(old.effectiveTo);
  assert.equal(plans.filter((item) => item.status === 'published').length, 1, '只有一个生效版本');

  const items = plan.listCalendarItems('pat_a');
  // 历史已完成事项保持原样
  const doneItem = items.find((item) => item.status === 'done');
  assert.ok(doneItem, '历史完成事项未被改写');
  // 旧版未来事项全部取消
  const oldFuture = items.filter(
    (item) => item.planVersion === 1 && item.scheduledDate >= '2026-12-04',
  );
  assert.ok(oldFuture.length > 0);
  assert.ok(oldFuture.every((item) => item.status === 'cancelled'));
  assert.ok(oldFuture.every((item) => item.cancelReason === 'plan_superseded'));
});

test('并发发布只能成功一次（不能出现两个 published）', async () => {
  const { plan } = await setup();
  const record = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  const results = await Promise.allSettled([
    plan.publish({ planId: record.id, actorId: 'acc_2', actorName: 'A' }),
    plan.publish({ planId: record.id, actorId: 'acc_3', actorName: 'B' }),
  ]);
  const ok = results.filter((item) => item.status === 'fulfilled');
  const failed = results.filter((item) => item.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(plan.list('pat_a').filter((item) => item.status === 'published').length, 1);
});

test('暂停取消未来事项并保留历史；恢复后补回未来事项', async () => {
  const { plan } = await setup();
  const record = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  await plan.publish({ planId: record.id, actorId: 'acc_2', actorName: '审核人' });

  await plan.suspend({ planId: record.id, actorId: 'acc_2' });
  assert.equal(plan.get(record.id)?.status, 'suspended');
  assert.ok(plan.listCalendarItems('pat_a').every((item) => item.status === 'cancelled'));

  await plan.resume({ planId: record.id, actorId: 'acc_2' });
  assert.equal(plan.get(record.id)?.status, 'published');
  const pending = plan.listCalendarItems('pat_a').filter((item) => item.status === 'pending');
  assert.equal(pending.length, 7, '恢复后重新铺满未来事项');
});

test('编辑带版本乐观锁；过期版本返回 PLAN_VERSION_CONFLICT', async () => {
  const { plan } = await setup();
  const record = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  await plan.update({
    planId: record.id,
    actorId: 'acc_1',
    expectedVersion: record.version,
    patch: { stageGoal: '第一版目标' },
  });
  await assert.rejects(
    () =>
      plan.update({
        planId: record.id,
        actorId: 'acc_1',
        expectedVersion: record.version - 1,
        patch: { stageGoal: '过期写入' },
      }),
    (error: unknown) => error instanceof PlanError && error.code === 'PLAN_VERSION_CONFLICT',
  );
});

test('已发布方案不可编辑；退回后不可再发布', async () => {
  const { plan } = await setup();
  const record = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  await plan.publish({ planId: record.id, actorId: 'acc_2', actorName: '审核人' });
  await assert.rejects(
    () =>
      plan.update({
        planId: record.id,
        actorId: 'acc_1',
        expectedVersion: record.version,
        patch: { stageGoal: '改已发布的' },
      }),
    (error: unknown) => error instanceof PlanError && error.code === 'IMMUTABLE_RESOURCE',
  );

  const v2 = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  const rejected = await plan.reject({
    planId: v2.id,
    actorId: 'acc_2',
    actorName: '审核人',
    note: '依据不足',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.review.note, '依据不足');
  await assert.rejects(
    () => plan.publish({ planId: v2.id, actorId: 'acc_2', actorName: '审核人' }),
    (error: unknown) => error instanceof PlanError,
  );
});

test('没有行动的方案不能发布', async () => {
  const { plan } = await setup();
  const draft = await plan.createManualDraft({
    patientId: 'pat_a',
    startDate: START,
    endDate: END,
    actorId: 'acc_1',
    stageGoal: '空方案',
  });
  await assert.rejects(
    () => plan.publish({ planId: draft.id, actorId: 'acc_2', actorName: '审核人' }),
    (error: unknown) => error instanceof PlanError && error.code === 'VALIDATION_FAILED',
  );
});

test('患者「已了解」只留痕，不改变审核记录', async () => {
  const { plan } = await setup();
  const record = await plan.generate({ patientId: 'pat_a', startDate: START, endDate: END, actorId: 'acc_1' });
  await plan.publish({ planId: record.id, actorId: 'acc_2', actorName: '审核人' });
  const acked = await plan.acknowledge('pat_a');
  assert.ok(acked.acknowledgedAt);
  assert.equal(acked.review.status, 'approved');
  assert.equal(acked.review.reviewerName, '审核人');
});
