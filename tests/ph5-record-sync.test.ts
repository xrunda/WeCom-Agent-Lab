/**
 * 餐食记录与团队侧 `meal_logs` 的桥。
 *
 * 背景：控制台「饮食记录」读 `meal_logs`（群存档提取），H5「我的健康记录」读
 * `patient_records`，两套互不相通——企微里说的饭患者端看不到，H5 记的餐
 * 控制台也看不到。这里约定 `meal_logs` 是单一事实来源：
 * - H5 记餐 → 同步写入 meal_logs（source=h5），控制台立即可见
 * - 群存档的餐食 → 只读借给 H5 展示
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MemoryRecordBackend,
  RecordService,
  UNCONFIGURED_RECOGNITION,
} from '../src/p1/patient-h5-record.ts';
import type { MealLogPort } from '../src/p1/patient-h5-record.ts';
import { idFactory } from '../src/p1/ids.ts';

const TENANT = 'tn_ph5_record_sync';

function setup(options: { failUpsert?: boolean } = {}) {
  const upserts: Array<Parameters<MealLogPort['upsert']>[0]> = [];
  const port: MealLogPort = {
    listArchive: () => [
      {
        id: 'meal_archive_1',
        occurredAt: new Date('2026-11-26T09:59:00+08:00').getTime(),
        mealType: 'breakfast',
        foods: [{ name: '沙河粉' }],
        notes: '油量偏多',
        hasPhoto: true,
      },
    ],
    upsert: (input) => {
      if (options.failUpsert) throw new Error('团队服务未就绪');
      upserts.push(input);
      return { id: `meal_h5_${input.h5RecordId}` };
    },
    photoPath: () => '/var/lib/zhiban/media/example.jpg',
  };
  const backend = new MemoryRecordBackend();
  const service = new RecordService({
    tenantId: TENANT,
    backend,
    recognition: UNCONFIGURED_RECOGNITION,
    ids: idFactory(() => Date.now()),
    mealLogs: port,
    mediaPathOf: (mediaId) => `/var/lib/zhiban/media/h5/${mediaId}`,
    sideEffects: {
      createRiskFollowup: async () => undefined,
      matchCalendarItem: async () => undefined,
    },
  });
  return { service, backend, upserts };
}

const NOW = new Date('2026-11-26T12:30:00+08:00').getTime();

test('H5 记餐同步写入 meal_logs，并回写 mealLogId', async () => {
  const { service, backend, upserts } = setup();
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW,
    meal: {
      mealType: 'lunch',
      confirmedFoods: [{ name: '米饭' }, { name: '青菜', portion: '一小碟' }],
      patientNotes: '少放盐',
    },
  });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]?.h5RecordId, record.id);
  assert.deepEqual(upserts[0]?.foods, [{ name: '米饭' }, { name: '青菜', portion: '一小碟' }]);
  assert.equal(upserts[0]?.notes, '少放盐');
  // 同步 id 落库，后续更新照片能定位到同一条
  assert.equal(backend.load().records[0]?.mealLogId, `meal_h5_${record.id}`);
});

test('照片后到：挂照片时把 mediaPath 补进同一条 meal_logs', async () => {
  const { service, upserts } = setup();
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW,
    meal: { mealType: 'dinner', confirmedFoods: [{ name: '面条' }] },
  });
  await service.attachPhoto({
    patientId: 'pat_a',
    recordId: record.id,
    media: {
      mimeType: 'image/jpeg',
      bytes: 1024,
      sha256: 'a'.repeat(64),
      exifStripped: true,
    },
  });
  assert.equal(upserts.length, 2, '创建一次、挂照片一次');
  assert.match(upserts[1]?.mediaPath ?? '', /media\/h5\/med_/);
  assert.equal(upserts[1]?.h5RecordId, record.id, '两次同步指向同一条记录');
});

test('团队侧不可用时记录照常保存，只是没有 mealLogId', async () => {
  const { service, backend } = setup({ failUpsert: true });
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'meal',
    occurredAt: NOW,
    meal: { mealType: 'breakfast', confirmedFoods: [{ name: '鸡蛋' }] },
  });
  assert.ok(record.id);
  assert.equal(record.mealLogId, undefined);
  assert.equal(backend.load().records.length, 1, '患者记录不因同步失败回滚');
});

test('群存档餐食按日期只读返回，H5 自己写的不会重复出现', () => {
  const { service } = setup();
  const archive = service.archiveMeals('pat_a', '2026-11-26');
  assert.equal(archive.length, 1);
  assert.equal(archive[0]?.foods[0]?.name, '沙河粉');
  assert.equal(archive[0]?.hasPhoto, true);
  // 未注入端口时返回空数组，不影响其它路由
  const bare = new RecordService({
    tenantId: TENANT,
    backend: new MemoryRecordBackend(),
    recognition: UNCONFIGURED_RECOGNITION,
    ids: idFactory(() => Date.now()),
    sideEffects: {
      createRiskFollowup: async () => undefined,
      matchCalendarItem: async () => undefined,
    },
  });
  assert.deepEqual(bare.archiveMeals('pat_a', '2026-11-26'), []);
  assert.equal(bare.archiveMealPhotoPath('pat_a', 'meal_archive_1'), null);
});
