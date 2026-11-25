/**
 * PH5-05（#234）今日聚合、周历与行动反馈测试。
 *
 * 对应 issue 验收：
 * - 查看/访问不算完成；完成只由明确确认或记录满足要求产生
 * - 未来不能提前完成；已取消事项不能再反馈；历史补记区分发生与提交时间
 * - 到期未反馈只是待跟进标记，不是未执行
 * - 需要帮助生成可跟踪的跟进请求
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import { CalendarError, CalendarService } from '../src/p1/patient-h5-calendar.ts';
import { MemoryPlanBackend, PlanService } from '../src/p1/patient-h5-plan.ts';
import type { PlanGenerationPort } from '../src/p1/patient-h5-plan.ts';
import { MemoryProfileBackend, ProfileService } from '../src/p1/patient-h5-profile.ts';

const TENANT = 'tn_cal';
const NOW = new Date('2026-11-25T09:00:00+08:00').getTime();

const GENERATOR: PlanGenerationPort = {
  configured: true,
  async generate() {
    return {
      ok: true,
      draft: {
        stageGoal: '规律三餐',
        foodTherapyRationale: '从规律开始',
        focusPoints: ['三餐按时', '晚餐不过饱'],
        actions: [
          {
            actionId: 'act_1',
            title: '早餐记录',
            purpose: '看看早餐',
            method: '拍照',
            schedule: { kind: 'daily', time: '07:30' },
            feedbackKind: 'record_meal',
            linkedArticleIds: [],
          },
          {
            actionId: 'act_2',
            title: '晚间回顾',
            purpose: '说说感受',
            method: '选一下感受',
            schedule: { kind: 'daily', time: '20:30' },
            feedbackKind: 'record_review',
            linkedArticleIds: [],
          },
        ],
        feedbackRequirements: [],
        ruleRefs: [],
      },
    };
  },
};

async function setup(options: { suspend?: boolean } = {}) {
  const clock = new FakeClock(NOW);
  const profile = new ProfileService({
    backend: new MemoryProfileBackend(),
    tenantId: TENANT,
    ids: idFactory(() => clock.now()),
  });
  await profile.submitAnswers({
    patientId: 'pat_a',
    step: 'safety',
    answers: { allergy: { unknown: true, items: [] } },
    decidedVia: 't',
  });
  const backend = new MemoryPlanBackend();
  const plan = new PlanService({
    tenantId: TENANT,
    backend,
    generator: GENERATOR,
    profile,
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
  });
  const followups: Array<{ id: string; kind: string; message: string }> = [];
  const calendar = new CalendarService({
    tenantId: TENANT,
    plan,
    backend,
    followups: {
      put: async (record) => {
        followups.push({ id: record.id, kind: record.kind, message: record.message });
      },
    },
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
  });

  const draft = await plan.generate({
    patientId: 'pat_a',
    startDate: '2026-11-24',
    endDate: '2026-12-01',
    actorId: 'acc_1',
  });
  await plan.publish({ planId: draft.id, actorId: 'acc_2', actorName: '审核人' });
  if (options.suspend) await plan.suspend({ planId: draft.id, actorId: 'acc_2' });

  const items = plan.listCalendarItems('pat_a');
  const todayItems = items.filter((item) => item.scheduledDate === '2026-11-25');
  const firstToday = todayItems[0]!;
  return { clock, plan, backend, calendar, followups, draft, items, todayItems, firstToday };
}

test('今日聚合只统计当天事项；未反馈的昨日事项标 overdue 但不是「没做到」', async () => {
  const { calendar } = await setup();
  const view = calendar.today('pat_a');
  assert.equal(view.date, '2026-11-25');
  assert.equal(view.progress.total, 2, '当天两条行动');
  assert.equal(view.progress.pending, 2);
  // 09:00 时 07:30 已过，下一项应是 20:30 的晚间回顾
  assert.equal(view.nextItem?.title, '晚间回顾', '取还没到点的最近一条');
  assert.equal(view.allDone, false);
});

test('访问/查看不计完成：初始状态全是待进行', async () => {
  const { calendar } = await setup();
  const view = calendar.today('pat_a');
  assert.equal(view.progress.done, 0);
  const item = calendar.item('pat_a', view.nextItem!.id);
  assert.equal(item.status, 'pending');
  assert.equal(item.canFeedback, true);
});

test('明确确认后计入完成，进度即时更新', async () => {
  const { calendar, firstToday } = await setup();
  const result = await calendar.feedback({
    patientId: 'pat_a',
    itemId: firstToday.id,
    kind: 'patient_confirmed',
  });
  assert.equal(result.status, 'done');
  const view = calendar.today('pat_a');
  assert.equal(view.progress.done, 1);
  assert.equal(view.progress.pending, 1);
});

test('未来事项不能提前完成', async () => {
  const { calendar, items } = await setup();
  const future = items.find((item) => item.scheduledDate > '2026-11-25')!;
  await assert.rejects(
    () =>
      calendar.feedback({ patientId: 'pat_a', itemId: future.id, kind: 'patient_confirmed' }),
    (error: unknown) => error instanceof CalendarError && error.code === 'ITEM_NOT_MODIFIABLE',
  );
});

test('换版后被取消事项不能再反馈（A05）', async () => {
  const { clock, calendar, plan, draft } = await setup();
  clock.advance(24 * 60 * 60 * 1000);
  // 发布新版：旧版未来事项全部取消
  const v2 = await plan.generate({
    patientId: 'pat_a',
    startDate: '2026-11-26',
    endDate: '2026-12-01',
    actorId: 'acc_1',
  });
  await plan.publish({ planId: v2.id, actorId: 'acc_2', actorName: '审核人' });
  const cancelled = plan
    .listCalendarItems('pat_a')
    .find((item) => item.planId === draft.id && item.status === 'cancelled')!;
  assert.ok(cancelled, '旧版有事项被取消');
  await assert.rejects(
    () => calendar.feedback({ patientId: 'pat_a', itemId: cancelled.id, kind: 'patient_confirmed' }),
    (error: unknown) => error instanceof CalendarError && error.code === 'ITEM_NOT_MODIFIABLE',
  );
});

test('计划暂停后反馈被拒（只读）', async () => {
  const { calendar, firstToday } = await setup({ suspend: true });
  await assert.rejects(
    () => calendar.feedback({ patientId: 'pat_a', itemId: firstToday.id, kind: 'missed' }),
    (error: unknown) => error instanceof CalendarError && error.code === 'SERVICE_PAUSED',
  );
});

test('历史补记区分发生时间与提交时间；发生时间不能晚于现在', async () => {
  const { calendar, clock, items } = await setup();
  const todayItem = items.find((item) => item.scheduledDate === '2026-11-25')!;
  // 第二天补记昨天做的事
  clock.advance(24 * 60 * 60 * 1000);
  const occurredAt = NOW + 9 * 60 * 60 * 1000; // 昨天的发生时间
  const submittedAt = clock.now();
  const result = await calendar.feedback({
    patientId: 'pat_a',
    itemId: todayItem.id,
    kind: 'patient_confirmed',
    occurredAt,
  });
  assert.equal(result.status, 'done');
  assert.ok(occurredAt < submittedAt, '发生时间早于提交时间');

  await assert.rejects(
    () =>
      calendar.feedback({
        patientId: 'pat_a',
        itemId: todayItem.id,
        kind: 'patient_confirmed',
        occurredAt: clock.now() + 60 * 60 * 1000,
      }),
    (error: unknown) => error instanceof CalendarError && error.code === 'VALIDATION_FAILED',
  );
});

test('「需要帮助」生成可跟踪的跟进请求', async () => {
  const { calendar, followups, firstToday } = await setup();
  const result = await calendar.feedback({
    patientId: 'pat_a',
    itemId: firstToday.id,
    kind: 'needs_help',
    reason: '早上来不及记录',
  });
  assert.equal(result.status, 'needs_help');
  assert.equal(followups.length, 1);
  assert.equal(followups[0]?.kind, 'need_help');
  assert.match(followups[0]!.message, /早餐记录/);
});

test('周视图给出周一起的七天；次日再看，昨天未反馈标 overdue 但状态不变', async () => {
  const { calendar, clock } = await setup();
  clock.advance(24 * 60 * 60 * 1000); // 进入 11-26
  const days = calendar.week('pat_a', { date: '2026-11-26' });
  assert.equal(days.length, 7);
  assert.equal(days[0]?.date, '2026-11-23', '周一');
  assert.equal(days[6]?.date, '2026-11-29', '周日');
  const yesterday = days.find((day) => day.date === '2026-11-25')!;
  assert.ok(yesterday.items.length > 0);
  assert.ok(yesterday.items.every((item) => item.overdue), '昨天未反馈标 overdue');
  assert.ok(
    yesterday.items.every((item) => item.status === 'pending'),
    'overdue 只是待跟进标记，不改写为未执行',
  );
  // 未来日期不可提前反馈
  const future = days.find((day) => day.date === '2026-11-27')!.items[0]!;
  assert.equal(future.canFeedback, false);
});
