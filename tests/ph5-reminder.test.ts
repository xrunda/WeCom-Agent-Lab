/**
 * PH5-09（#238）提醒：安静时段、频控取更严、去重、取消传播、状态语义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import type { CalendarItemRecord } from '../src/p1/patient-h5-plan.ts';
import {
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  MemoryReminderBackend,
  ReminderService,
  shiftOutOfQuietHours,
  stricterQuietHours,
} from '../src/p1/patient-h5-reminder.ts';
import type { PatientReminderPrefs } from '../src/p1/patient-h5-reminder.ts';

const TZ = 'Asia/Shanghai';
const AT = (iso: string): number => new Date(iso).getTime();

function item(overrides: Partial<CalendarItemRecord> = {}): CalendarItemRecord {
  return {
    id: 'cal_1',
    tenantId: 'tn_rmd',
    patientId: 'pat_a',
    planId: 'hpl_1',
    planVersion: 1,
    actionId: 'act_1',
    scheduledDate: '2026-11-25',
    scheduledAt: AT('2026-11-25T09:00:00+08:00'),
    title: '早餐记录',
    purpose: '看看早餐',
    method: '拍照',
    feedbackKind: 'record_meal',
    linkedArticleIds: [],
    status: 'pending',
    createdAt: 0,
    ...overrides,
  };
}

function setup(options: { prefs?: PatientReminderPrefs; planStatus?: string; items?: CalendarItemRecord[] } = {}) {
  const clock = new FakeClock(AT('2026-11-25T08:50:00+08:00'));
  const service = new ReminderService({
    tenantId: 'tn_rmd',
    backend: new MemoryReminderBackend(),
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
    timeZone: TZ,
    ...(options.prefs ? { prefsOf: () => options.prefs } : {}),
    loadItems: () => options.items ?? [item()],
    loadPlanStatus: () => options.planStatus ?? 'published',
  });
  return { clock, service };
}

test('安静时段判定支持跨零点', () => {
  assert.equal(inQuietHours(AT('2026-11-25T22:30:00+08:00'), DEFAULT_QUIET_HOURS, TZ), true);
  assert.equal(inQuietHours(AT('2026-11-25T06:00:00+08:00'), DEFAULT_QUIET_HOURS, TZ), true);
  assert.equal(inQuietHours(AT('2026-11-25T09:00:00+08:00'), DEFAULT_QUIET_HOURS, TZ), false);
  const shifted = shiftOutOfQuietHours(AT('2026-11-25T23:00:00+08:00'), DEFAULT_QUIET_HOURS, TZ);
  assert.equal(inQuietHours(shifted, DEFAULT_QUIET_HOURS, TZ), false);
});

test('患者偏好只能更严格：安静时段取更长、上限取更小', async () => {
  const stricter = stricterQuietHours(DEFAULT_QUIET_HOURS, { start: '20:00', end: '09:00' });
  assert.deepEqual(stricter, { start: '20:00', end: '09:00' });
  // 更宽松的偏好不生效
  const looser = stricterQuietHours(DEFAULT_QUIET_HOURS, { start: '23:00', end: '06:00' });
  assert.deepEqual(looser, DEFAULT_QUIET_HOURS);

  const { service } = setup({ prefs: { enabled: true, dailyLimit: 5 } });
  assert.equal(service.usage('pat_a').limit, 2, '患者上限比租户宽时仍按租户 2 次');
});

test('生成提醒会把落在安静时段的时间顺延', async () => {
  const late = item({ scheduledAt: AT('2026-11-25T21:30:00+08:00') });
  const { clock, service } = setup({ items: [late] });
  clock.advance(12 * 60 * 60 * 1000 + 30 * 60 * 1000); // 21:20
  const created = await service.generateForPatient('pat_a', { horizonMinutes: 30 });
  assert.equal(created.length, 1);
  assert.equal(created[0]?.quietHoursShifted, true);
  assert.equal(inQuietHours(created[0]!.scheduledAt, DEFAULT_QUIET_HOURS, TZ), false);
});

test('同一事项同一天只生成一次（重启去重）', async () => {
  const { service } = setup();
  const first = await service.generateForPatient('pat_a');
  assert.equal(first.length, 1);
  const second = await service.generateForPatient('pat_a');
  assert.equal(second.length, 0, '重复调用不再生成');
});

test('每日最多 2 次：第三条不再生成', async () => {
  const items = [1, 2, 3].map((index) =>
    item({
      id: `cal_${index}`,
      scheduledAt: AT(`2026-11-25T09:0${index}:00+08:00`),
    }),
  );
  const { service } = setup({ items });
  const created = await service.generateForPatient('pat_a', { horizonMinutes: 30 });
  assert.equal(created.length, 2);
  assert.equal(service.usage('pat_a').used, 2);
});

test('患者关闭提醒后不再生成', async () => {
  const { service } = setup({ prefs: { enabled: false } });
  assert.equal((await service.generateForPatient('pat_a')).length, 0);
});

test('方案未发布时不生成', async () => {
  const { service } = setup({ planStatus: 'suspended' });
  assert.equal((await service.generateForPatient('pat_a')).length, 0);
});

test('温和询问每天一次并计入上限', async () => {
  const { clock, service } = setup({ items: [] });
  clock.advance(12 * 60 * 60 * 1000); // 20:50
  const first = await service.gentleInquiry('pat_a');
  assert.ok(first);
  const second = await service.gentleInquiry('pat_a');
  assert.equal(second, null);
  assert.equal(service.usage('pat_a').used, 1);
});

test('发送前复查：事项已完成则取消，不触达', async () => {
  const items = [item()];
  const { service } = setup({ items });
  const [reminder] = await service.generateForPatient('pat_a');
  assert.ok(reminder);
  await service.enqueue(reminder.id);

  // 患者先自己完成了这一项
  items[0]!.status = 'done';
  await assert.rejects(() => service.markSent({ id: reminder.id }), /提醒已取消/);
  assert.equal(service.list({ patientId: 'pat_a' })[0]?.cancelReason, 'team_cancelled');
});

test('发送前复查：方案暂停则取消', async () => {
  let planStatus = 'published';
  const clock = new FakeClock(AT('2026-11-25T08:50:00+08:00'));
  const service = new ReminderService({
    tenantId: 'tn_rmd',
    backend: new MemoryReminderBackend(),
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
    timeZone: TZ,
    loadItems: () => [item()],
    loadPlanStatus: () => planStatus,
  });
  const [reminder] = await service.generateForPatient('pat_a');
  await service.enqueue(reminder!.id);
  planStatus = 'suspended';
  await assert.rejects(() => service.markSent({ id: reminder!.id }), /提醒已取消/);
});

test('状态语义：已发出不等于已核验；核验只记消息事实', async () => {
  const { service } = setup();
  const [reminder] = await service.generateForPatient('pat_a');
  assert.equal(reminder?.status, 'generated');
  await service.enqueue(reminder!.id);
  assert.equal(service.list({ patientId: 'pat_a' })[0]?.status, 'advisor_pending');

  const sent = await service.markSent({ id: reminder!.id, draftId: 'draft_1' });
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sentAt);

  const verified = await service.markVerified(reminder!.id, 'vrf_1');
  assert.equal(verified.status, 'verified');
  assert.ok(verified.verifiedAt);
});

test('取消传播：换版时批量取消未发出的提醒', async () => {
  const items = [item(), item({ id: 'cal_2', scheduledAt: AT('2026-11-25T09:05:00+08:00') })];
  const { service } = setup({ items });
  const created = await service.generateForPatient('pat_a', { horizonMinutes: 30 });
  assert.equal(created.length, 2);
  await service.enqueue(created[0]!.id);

  const cancelled = await service.cancelForPlan('pat_a', {
    reason: 'plan_superseded',
    itemIds: ['cal_1', 'cal_2'],
  });
  assert.equal(cancelled, 2);
  assert.ok(
    service.list({ patientId: 'pat_a' }).every((entry) => entry.status === 'cancelled'),
  );
  // 取消后不计入当天频控用量
  assert.equal(service.usage('pat_a').used, 0);
});

test('发送失败单独记录，不伪装成已发出', async () => {
  const { service } = setup();
  const [reminder] = await service.generateForPatient('pat_a');
  await service.enqueue(reminder!.id);
  const failed = await service.markFailed(reminder!.id, 'UPSTREAM_UNAVAILABLE');
  assert.equal(failed.status, 'send_failed');
  assert.equal(failed.errorCode, 'UPSTREAM_UNAVAILABLE');
  assert.equal(failed.sentAt, undefined);
});
