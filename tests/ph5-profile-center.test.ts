/**
 * PH5-10（#239）个人中心：统计口径可复算、纠错不覆盖、偏好只能更严格。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import {
  FollowupService,
  MemoryFollowupBackend,
} from '../src/p1/patient-h5-followup.ts';
import { MemoryProfileBackend, ProfileService } from '../src/p1/patient-h5-profile.ts';
import {
  MemoryReminderPrefsStore,
  ProfileCenterService,
} from '../src/p1/patient-h5-profile-center.ts';
import {
  MemoryRecordBackend,
  RecordService,
  UNCONFIGURED_RECOGNITION,
} from '../src/p1/patient-h5-record.ts';

const NOW = new Date('2026-11-25T12:00:00+08:00').getTime();
const DAY = 24 * 60 * 60 * 1000;

async function setup(options: { startedAt?: number | null } = {}) {
  const clock = new FakeClock(NOW);
  const ids = idFactory(() => clock.now());
  const profile = new ProfileService({
    backend: new MemoryProfileBackend(),
    tenantId: 'tn_pc',
    ids,
    now: () => clock.now(),
  });
  const records = new RecordService({
    tenantId: 'tn_pc',
    backend: new MemoryRecordBackend(),
    recognition: UNCONFIGURED_RECOGNITION,
    ids,
    now: () => clock.now(),
    sideEffects: {
      createRiskFollowup: async () => undefined,
      matchCalendarItem: async () => undefined,
    },
  });
  const followups = new FollowupService({
    tenantId: 'tn_pc',
    backend: new MemoryFollowupBackend(),
    ids,
    now: () => clock.now(),
  });
  const prefsStore = new MemoryReminderPrefsStore();
  const center = new ProfileCenterService({
    profile,
    records,
    followups,
    prefsStore,
    now: () => clock.now(),
    startedAtOf: () => (options.startedAt === undefined ? NOW - 4 * DAY : options.startedAt),
  });
  return { clock, profile, records, followups, center };
}

test('陪伴天数按服务开始日算（含当天）', async () => {
  const { center } = await setup({ startedAt: NOW - 4 * DAY });
  assert.equal(center.stats('pat_a').companionDays, 5);
});

test('没有服务开始时间时显示 0，不编造数字', async () => {
  const { center } = await setup({ startedAt: null });
  const stats = center.stats('pat_a');
  assert.equal(stats.companionDays, 0);
  assert.equal(stats.basis.startedAt, null);
});

test('餐食按记录条数、回顾按「有天」去重', async () => {
  const { center, records, clock } = await setup();
  await records.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 3 * 60 * 60 * 1000,
    meal: { mealType: 'breakfast' },
  });
  await records.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 2 * 60 * 60 * 1000,
    meal: { mealType: 'lunch' },
  });
  // 同一天两条回顾：天数只算 1
  await records.create({
    patientId: 'pat_a',
    kind: 'evening_review',
    occurredAt: NOW - 60 * 1000,
    review: { sleep: 'light' },
  });
  clock.advance(-0);
  const stats = center.stats('pat_a');
  assert.equal(stats.mealRecords, 2);
  assert.equal(stats.reviewDays, 1);
});

test('档案纠错只置待确认并生成团队待办，内容与来源不变', async () => {
  const { center, profile, followups } = await setup();
  await profile.submitAnswers({
    patientId: 'pat_a',
    step: 'safety',
    answers: { allergy: { items: ['海鲜（自述）'], unknown: false } },
    decidedVia: 't',
  });
  const entry = profile.list('pat_a')[0]!;

  const result = await center.requestCorrection({
    patientId: 'pat_a',
    entryId: entry.id,
    detail: '其实没有海鲜过敏',
  });

  const after = profile.list('pat_a').find((item) => item.id === entry.id)!;
  assert.equal(after.status, 'disputed');
  assert.equal(after.valueText, entry.valueText, '内容未被患者改写');
  assert.equal(after.source, 'patient', '来源不变');
  assert.ok(result.followupId.startsWith('fup'));
  assert.equal(followups.listForPatient('pat_a').length, 1);
  assert.equal(followups.listForPatient('pat_a')[0]?.kind, 'profile_correction');
});

test('专业确认条目纠错后仍是专业来源，不会被患者覆盖', async () => {
  const { center, profile } = await setup();
  const backend = new MemoryProfileBackend();
  const isolated = new ProfileService({
    backend,
    tenantId: 'tn_pc',
    ids: idFactory(Date.now),
  });
  await backend.putProfileEntry({
    id: 'ppe_pro',
    tenantId: 'tn_pc',
    patientId: 'pat_a',
    fieldKey: 'existing_guidance',
    value: { items: ['低嘌呤饮食（门诊医嘱）'] },
    valueText: '低嘌呤饮食（门诊医嘱）',
    source: 'professional',
    status: 'confirmed',
    updatedAt: NOW,
    revisions: [],
  });
  const center2 = new ProfileCenterService({
    profile: isolated,
    records: center['records'],
    followups: center['followups'],
    prefsStore: new MemoryReminderPrefsStore(),
    startedAtOf: () => NOW,
  });
  await center2.requestCorrection({
    patientId: 'pat_a',
    entryId: 'ppe_pro',
    detail: '我其实没有这个医嘱',
  });
  const entry = isolated.list('pat_a')[0]!;
  assert.equal(entry.source, 'professional', '专业来源保留');
  assert.equal(entry.status, 'disputed', '只是标记待确认');
});

test('记录历史可按日查看', async () => {
  const { center, records } = await setup();
  await records.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60 * 60 * 1000,
    meal: { mealType: 'lunch' },
  });
  assert.equal(center.recordsOn('pat_a').length, 1);
  assert.equal(center.recordsOn('pat_a', '2020-01-01').length, 0);
});

test('提醒偏好只能更严格：更宽的安静时段与更大的上限被收窄', async () => {
  const { center } = await setup();
  const defaults = { dailyLimit: 2, quietHours: { start: '21:00', end: '08:00' } };

  const wider = await center.updatePrefs(
    'pat_a',
    { enabled: true, dailyLimit: 5, quietHours: { start: '23:00', end: '06:00' } },
    defaults,
  );
  assert.equal(wider.dailyLimit, 2, '上限不能放宽');
  assert.deepEqual(wider.quietHours, { start: '21:00', end: '08:00' }, '安静时段不能缩短');

  const stricter = await center.updatePrefs(
    'pat_a',
    { enabled: true, dailyLimit: 1, quietHours: { start: '20:00', end: '09:00' } },
    defaults,
  );
  assert.equal(stricter.dailyLimit, 1);
  assert.deepEqual(stricter.quietHours, { start: '20:00', end: '09:00' });
});
