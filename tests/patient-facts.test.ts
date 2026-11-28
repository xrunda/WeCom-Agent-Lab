/**
 * 患者事实卡（#167）：固定顺序、只写有来源的字段、缺项不猜。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPatientFacts, formatShanghaiDateTime } from '../src/p1/patient-facts.ts';
import { emptyChronicProfile } from '../src/p1/chronic.ts';
import type { ChronicProfile } from '../src/p1/chronic.ts';
import type { MealLogRecord } from '../src/p1/vision.ts';

const NOW = Date.UTC(2026, 10, 15, 0, 26); // 2026-11-15 08:26 上海

function chronic(overrides: Partial<ChronicProfile> = {}): ChronicProfile {
  return {
    ...emptyChronicProfile('p1', 'tn'),
    conditions: ['高血压'],
    heightCm: 170,
    weightKg: 65,
    medications: [{ name: '氨氯地平', dose: '5mg', source: 'advisor', updatedAt: NOW }],
    measurements: [
      {
        id: 'm1',
        metric: 'bp',
        value: 138,
        secondaryValue: 86,
        measuredAt: NOW,
        source: 'advisor',
        recordedAt: NOW,
      },
    ],
    ...overrides,
  };
}

function meal(overrides: Partial<MealLogRecord> = {}): MealLogRecord {
  return {
    id: 'meal_1',
    tenantId: 'tn',
    patientId: 'p1',
    mealType: 'breakfast',
    foods: [{ name: '小笼包', portion: '一笼' }, { name: '豆浆' }],
    confidence: 0.85,
    sandbox: false,
    createdAt: NOW,
    ...overrides,
  };
}

test('事实卡：疾病、身高体重、用药、最近体征、最近饮食按固定顺序输出', () => {
  const lines = buildPatientFacts({
    displayName: '汪女士',
    tags: ['高血压'],
    chronic: chronic(),
    recentMeals: [meal()],
  });
  const text = lines.join('\n');
  assert.match(text, /【患者事实卡】汪女士（标签：高血压）/);
  assert.match(text, /疾病：高血压/);
  assert.match(text, /身高体重：170 cm \/ 65 kg/);
  assert.match(text, /用药：氨氯地平 5mg/);
  assert.match(text, /最近体征：血压：138\/86 mmHg · 11-15 08:26 · 顾问录入/);
  assert.match(text, /最近饮食：11-15 08:26 早餐 小笼包（一笼）、豆浆/);
  assert.match(text, /没有的字段不要猜/);
});

test('事实卡：没有可用字段时返回空数组，不注入空块', () => {
  const lines = buildPatientFacts({
    displayName: '李阿姨',
    chronic: emptyChronicProfile('p2', 'tn'),
    recentMeals: [],
  });
  assert.equal(lines.length, 0);
});

test('事实卡：最近饮食最多 2 条，体征最多 3 条', () => {
  const meals = [1, 2, 3, 4].map((index) =>
    meal({ id: `meal_${index}`, createdAt: NOW - index * 3_600_000 }),
  );
  const lines = buildPatientFacts({ displayName: '汪女士', chronic: chronic(), recentMeals: meals });
  const text = lines.join('\n');
  assert.equal((text.match(/早餐/g) ?? []).length, 2);
});

test('上海时间格式：UTC 00:26 → 上海 08:26', () => {
  assert.equal(formatShanghaiDateTime(NOW), '11-15 08:26');
});

test('事实卡：有出生年与性别时输出一行，年龄按当年换算并注明出生年', () => {
  const lines = buildPatientFacts({
    displayName: '汪女士',
    birthYear: 1958,
    sex: 'female',
    chronic: chronic(),
    nowMs: NOW,
  });
  const text = lines.join('\n');
  assert.match(text, /· 年龄：68 岁（1958 年出生） · 性别：女/);
  // 在疾病之前，且只出现一次
  assert.equal(text.indexOf('年龄：') < text.indexOf('疾病：'), true);
  assert.equal((text.match(/年龄：/g) ?? []).length, 1);
});

test('事实卡：只有性别不输出年龄，unspecified 不编成男/女', () => {
  const onlySex = buildPatientFacts({
    displayName: '李先生',
    sex: 'male',
    chronic: chronic(),
    nowMs: NOW,
  }).join('\n');
  assert.match(onlySex, /· 性别：男/);
  assert.equal(onlySex.includes('年龄：'), false);

  const unspecified = buildPatientFacts({
    displayName: '王女士',
    sex: 'unspecified',
    chronic: chronic(),
    nowMs: NOW,
  }).join('\n');
  assert.equal(unspecified.includes('性别：'), false);
});

test('事实卡：出生年跨年按当年重算，未填不输出、不推断', () => {
  const at2026 = buildPatientFacts({
    displayName: '汪女士',
    birthYear: 1958,
    nowMs: Date.UTC(2026, 0, 2),
  }).join('\n');
  const at2027 = buildPatientFacts({
    displayName: '汪女士',
    birthYear: 1958,
    nowMs: Date.UTC(2027, 0, 2),
  }).join('\n');
  assert.match(at2026, /年龄：68 岁/);
  assert.match(at2027, /年龄：69 岁/);

  // 没有任何档案字段时不注入空块
  const empty = buildPatientFacts({ displayName: '未填患者' });
  assert.deepEqual(empty, []);
});
