/**
 * PH5-06（#235）记录、识别降级、疑似重复与照片安全测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import { prepareImage, stripJpegExif, detectImageMime } from '../src/p1/patient-h5-media.ts';
import {
  MemoryRecordBackend,
  RecordError,
  RecordService,
  UNCONFIGURED_RECOGNITION,
} from '../src/p1/patient-h5-record.ts';
import type { FoodCandidate, MealRecognitionPort } from '../src/p1/patient-h5-record.ts';

const NOW = new Date('2026-11-25T12:00:00+08:00').getTime();

function setup(options: { recognition?: MealRecognitionPort } = {}) {
  const clock = new FakeClock(NOW);
  const followups: Array<{ message: string }> = [];
  const matched: Array<{ itemId: string; recordId: string }> = [];
  const service = new RecordService({
    tenantId: 'tn_rec',
    backend: new MemoryRecordBackend(),
    recognition: options.recognition ?? UNCONFIGURED_RECOGNITION,
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
    sideEffects: {
      createRiskFollowup: async (input) => {
        followups.push({ message: input.message });
      },
      matchCalendarItem: async (input) => {
        matched.push({ itemId: input.itemId, recordId: input.recordId });
      },
    },
  });
  return { clock, service, followups, matched };
}

test('同一 Idempotency-Key 重试只建一条记录（A07）', async () => {
  const { service } = setup();
  const first = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60_000,
    idempotencyKey: 'idem-1',
    meal: { mealType: 'lunch', confirmedFoods: [{ name: '清蒸鲈鱼' }] },
  });
  const replay = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60_000,
    idempotencyKey: 'idem-1',
    meal: { mealType: 'lunch', confirmedFoods: [{ name: '清蒸鲈鱼' }] },
  });
  assert.equal(replay.id, first.id);
  assert.equal(service.list('pat_a').length, 1);
});

test('识别不可用时照片仍可挂载，状态为 skipped，记录不丢（A07）', async () => {
  const { service } = setup();
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60_000,
    meal: { mealType: 'lunch' },
  });
  const result = await service.attachPhoto({
    patientId: 'pat_a',
    recordId: record.id,
    media: { mimeType: 'image/jpeg', bytes: 1024, sha256: 'abc', exifStripped: true },
  });
  assert.equal(result.recognition.status, 'skipped');
  assert.equal(result.record.mediaIds.length, 1);
  assert.equal(service.get('pat_a', record.id).mediaIds.length, 1, '记录仍在');
});

test('识别成功时候选与患者确认分开保存，确认不覆盖候选', async () => {
  const recognition: MealRecognitionPort = {
    available: true,
    async recognize(): Promise<FoodCandidate[]> {
      return [{ name: '米饭', confidence: 0.82 }];
    },
  };
  const { service } = setup({ recognition });
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60_000,
    meal: { mealType: 'lunch' },
  });
  await service.attachPhoto({
    patientId: 'pat_a',
    recordId: record.id,
    media: { mimeType: 'image/jpeg', bytes: 1024, sha256: 'abc', exifStripped: true },
  });
  const confirmed = await service.confirm({
    patientId: 'pat_a',
    recordId: record.id,
    confirmedFoods: [{ name: '米饭' }, { name: '西兰花', portion: '适中' }],
  });
  const content = confirmed.content as { aiCandidates: unknown[]; confirmedFoods: unknown[] };
  assert.equal(content.aiCandidates.length, 1, '候选保留');
  assert.equal(content.confirmedFoods.length, 2, '确认为单独一份');
  assert.equal(confirmed.revisions.length, 1, '旧值进修订历史');
});

test('不适反馈生成跟进事件（A08）', async () => {
  const { service, followups } = setup();
  await service.create({
    patientId: 'pat_a',
    kind: 'evening_review',
    occurredAt: NOW - 60_000,
    review: { overall: 'fair', discomfort: '晚饭后有点胀' },
  });
  assert.equal(followups.length, 1);
  assert.match(followups[0]!.message, /晚饭后有点胀/);
});

test('晚间回顾不预选正常：未填的项不出现在内容里', async () => {
  const { service } = setup();
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'evening_review',
    occurredAt: NOW - 60_000,
    review: { sleep: 'light' },
  });
  const content = record.content as Record<string, unknown>;
  assert.equal(content.sleep, 'light');
  assert.equal('overall' in content, false, '没选就是没选，不默认 good');
  assert.equal('bowel' in content, false);
});

test('同日同餐只标疑似重复，不覆盖、不合并', async () => {
  const { service } = setup();
  const first = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 3 * 60 * 60 * 1000,
    meal: { mealType: 'lunch', confirmedFoods: [{ name: '面条' }] },
  });
  const second = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60_000,
    meal: { mealType: 'lunch', confirmedFoods: [{ name: '饺子' }] },
  });
  assert.equal(second.duplication.status, 'suspected');
  assert.deepEqual(second.duplication.suspectedIds, [first.id]);
  assert.equal(service.list('pat_a').length, 2, '两条都在');
});

test('关联日历事项时回填完成并记录 recordId', async () => {
  const { service, matched } = setup();
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW - 60_000,
    meal: { mealType: 'lunch' },
    linkedCalendarItemIds: ['cal_1'],
  });
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.itemId, 'cal_1');
  assert.equal(matched[0]!.recordId, record.id);
});

test('发生时间不能晚于现在', async () => {
  const { service } = setup();
  await assert.rejects(
    () =>
      service.create({
        patientId: 'pat_a',
        kind: 'meal',
        occurredAt: NOW + 60_000,
        meal: { mealType: 'lunch' },
      }),
    (error: unknown) => error instanceof RecordError && error.code === 'VALIDATION_FAILED',
  );
});

test('照片：魔数判定、超大拒绝、JPEG 剥离 Exif', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(Buffer.from('not an image at all')), null);

  const tooLarge = Buffer.alloc(11 * 1024 * 1024, 0xff);
  const prepared = prepareImage(tooLarge);
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.reason, 'TOO_LARGE');

  // 构造带 APP1(Exif) 的最小 JPEG
  const app1Payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    Buffer.from('GPSLatitude=30.1', 'ascii'),
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, 0x00, app1Payload.length + 2]),
    app1Payload,
  ]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos]);
  assert.equal(detectImageMime(jpeg), 'image/jpeg');

  const stripped = stripJpegExif(jpeg);
  assert.equal(stripped.stripped, true);
  assert.equal(stripped.buffer.includes(Buffer.from('GPSLatitude')), false, 'GPS 已移除');
  assert.equal(stripped.buffer[0], 0xff);
  assert.equal(stripped.buffer[1], 0xd8);
});
