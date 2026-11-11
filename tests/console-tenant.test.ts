/**
 * #41 租户参数校验 / 合并单测（P1-api.md §3、P1-data-model.md §3.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConsoleError } from '../src/p1/console-error.ts';
import {
  DEFAULT_TENANT_SETTINGS,
  type TenantRecord,
} from '../src/p1/console-types.ts';
import {
  applyTenantPatch,
  publicTenant,
  validateTenantPatch,
} from '../plugins/zhiban-console/tenant.ts';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 'tn_test',
    name: '安康健康管理中心',
    agentName: '小安',
    agentAvatar: null,
    patientTerm: '患者',
    tone: '亲切、专业',
    timezone: 'Asia/Shanghai',
    settings: {
      ...DEFAULT_TENANT_SETTINGS,
      quietHours: { ...DEFAULT_TENANT_SETTINGS.quietHours },
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function expectValidation(fn: () => unknown, field?: string) {
  assert.throws(fn, (error: unknown) => {
    if (!(error instanceof ConsoleError) || error.code !== 'VALIDATION_FAILED') return false;
    if (!field) return true;
    return JSON.stringify(error.details ?? []).includes(field);
  });
}

test('合法 patch 去空白并保留字段', () => {
  const patch = validateTenantPatch(
    {
      name: '  康宁中心  ',
      agentName: ' 小宁 ',
      patientTerm: '会员',
      tone: ' 温和 ',
      timezone: 'Asia/Tokyo',
      agentAvatar: 'https://example.com/avatar.png',
    },
    tenant(),
  );
  assert.deepEqual(patch, {
    name: '康宁中心',
    agentName: '小宁',
    patientTerm: '会员',
    tone: '温和',
    timezone: 'Asia/Tokyo',
    agentAvatar: 'https://example.com/avatar.png',
  });
});

test('称谓支持自定义并去除首尾空白', () => {
  const patch = validateTenantPatch({ patientTerm: ' 亲人 ' }, tenant());
  assert.equal(patch.patientTerm, '亲人');
});

test('agentAvatar 可显式清空', () => {
  const patch = validateTenantPatch({ agentAvatar: null }, tenant());
  assert.equal(patch.agentAvatar, null);
});

test('非法字段逐项拒绝', () => {
  expectValidation(() => validateTenantPatch(null, tenant()), 'body');
  expectValidation(() => validateTenantPatch([], tenant()), 'body');
  expectValidation(() => validateTenantPatch({ name: '   ' }, tenant()), 'name');
  expectValidation(() => validateTenantPatch({ agentName: 'x'.repeat(41) }, tenant()), 'agentName');
  expectValidation(() => validateTenantPatch({ tone: 'x'.repeat(501) }, tenant()), 'tone');
  expectValidation(() => validateTenantPatch({ patientTerm: '   ' }, tenant()), 'patientTerm');
  expectValidation(() => validateTenantPatch({ patientTerm: 'x'.repeat(9) }, tenant()), 'patientTerm');
  expectValidation(() => validateTenantPatch({ timezone: 'Mars/Olympus' }, tenant()), 'timezone');
  expectValidation(() => validateTenantPatch({ timezone: 'x'.repeat(65) }, tenant()), 'timezone');
});

test('settings 数值边界与时段格式', () => {
  expectValidation(
    () => validateTenantPatch({ settings: { archiveSeatPriceYuan: -1 } }, tenant()),
    'archiveSeatPriceYuan',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { writeMinutesPerDraft: 0 } }, tenant()),
    'writeMinutesPerDraft',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { writeMinutesPerDraft: 31 } }, tenant()),
    'writeMinutesPerDraft',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { writeMinutesPerDraft: 1.5 } }, tenant()),
    'writeMinutesPerDraft',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { mergeWindowSeconds: 301 } }, tenant()),
    'mergeWindowSeconds',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { proactivePerHour: 0 } }, tenant()),
    'proactivePerHour',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { memoryInjectLimit: 201 } }, tenant()),
    'memoryInjectLimit',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { quietHours: { start: '9:00', end: '18:00' } } }, tenant()),
    'quietHours.start',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { quietHours: { start: '21:00', end: '24:00' } } }, tenant()),
    'quietHours.end',
  );
  expectValidation(
    () => validateTenantPatch({ settings: { quietHours: { start: '21:00' } } }, tenant()),
    'quietHours.end',
  );
});

test('settings.modelName 只读，客户端传入被忽略', () => {
  const patch = validateTenantPatch(
    { settings: { modelName: 'evil-model', writeMinutesPerDraft: 5 } },
    tenant(),
  );
  assert.deepEqual(patch.settings, { writeMinutesPerDraft: 5 });
});

test('applyTenantPatch 合并设置、保留 modelName 与未传字段', () => {
  const existing = tenant({ settings: { ...DEFAULT_TENANT_SETTINGS, writeMinutesPerDraft: 7 } });
  const patch = validateTenantPatch(
    { agentName: '小新', settings: { quietHours: { start: '22:00', end: '07:00' } } },
    existing,
  );
  const updated = applyTenantPatch(existing, patch, 2_000);
  assert.equal(updated.agentName, '小新');
  assert.equal(updated.name, existing.name);
  assert.equal(updated.updatedAt, 2_000);
  assert.equal(updated.settings.writeMinutesPerDraft, 7);
  assert.deepEqual(updated.settings.quietHours, { start: '22:00', end: '07:00' });
  assert.equal(updated.settings.modelName, existing.settings.modelName);
  assert.equal(updated.createdAt, existing.createdAt);
});

test('publicTenant 返回深拷贝，不共享嵌套对象', () => {
  const record = tenant();
  const output = publicTenant(record);
  assert.deepEqual(output, record);
  assert.notEqual(output.settings, record.settings);
  assert.notEqual(output.settings.quietHours, record.settings.quietHours);
  output.settings.quietHours.start = '00:00';
  assert.equal(record.settings.quietHours.start, DEFAULT_TENANT_SETTINGS.quietHours.start);
});
