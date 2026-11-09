import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import { CareService, shiftForQuietHours } from '../src/p1/care.ts';
import type { CareBackend, CarePlanRecord } from '../src/p1/care.ts';
import { buildCareToolDefinitions, validateScheduleCreate } from '../src/p1/care-tools.ts';
import { parseCareConfig } from '../plugins/zhiban-care/config.ts';

const BASE = Date.parse('2026-11-10T10:00:00+08:00');

class CareBackendFake implements CareBackend {
  readonly plans = new Map<string, CarePlanRecord>();
  failWrites = false;

  load(): CarePlanRecord[] {
    return [...this.plans.values()];
  }

  async put(plan: CarePlanRecord): Promise<void> {
    if (this.failWrites) throw new Error('DISK_FULL');
    this.plans.set(plan.id, { ...plan });
  }
}

function setupCare() {
  const clock = new FakeClock(BASE);
  const backend = new CareBackendFake();
  const events: Array<{ type: string; data: unknown }> = [];
  let seq = 0;
  const service = new CareService({
    tenantId: 'tn_test',
    backend,
    timeZone: 'Asia/Shanghai',
    quietHours: { start: 21, end: 8 },
    sandbox: true,
    now: () => clock.now(),
    newId: (prefix) => `${prefix}_${++seq}`,
    emit: (type, data) => events.push({ type, data }),
  });
  return { clock, backend, service, events };
}

test('#36 创建一次性计划：未来时间、来源、审计与事件', () => {
  const { service, events } = setupCare();
  const when = Date.parse('2026-11-10T15:00:00+08:00');
  const plan = service.create({ patientId: 'pat_1', title: ' 提醒量血压 ', when, source: 'agent' });

  assert.match(plan.id, /^pln_/);
  assert.equal(plan.title, '提醒量血压');
  assert.equal(plan.when, when);
  assert.equal(plan.status, 'pending');
  assert.equal(plan.quietHoursShifted, false);
  assert.equal(plan.sandbox, true);
  assert.equal(service.audits().at(-1)?.action, 'care_plan.create');
  assert.deepEqual(events.map((event) => event.type), ['care_plan.created']);

  assert.throws(
    () => service.create({ patientId: 'pat_1', title: '', when, source: 'agent' }),
    /EMPTY_TITLE|title/,
  );
  assert.throws(
    () => service.create({ patientId: 'pat_1', title: 'x', when: BASE - 1, source: 'agent' }),
    /WHEN_NOT_FUTURE/,
  );
  assert.throws(
    () =>
      service.create({
        patientId: 'pat_1',
        title: '每天提醒',
        when,
        rrule: 'FREQ=DAILY',
        source: 'agent',
      }),
    /RRULE_UNSUPPORTED/,
  );
});

test('#36 安静时段：21:00–08:00 到点顺延到 08:00，并标记 shifted', () => {
  const { service } = setupCare();
  const late = service.create({
    patientId: 'pat_1',
    title: '晚上提醒',
    when: Date.parse('2026-11-10T22:30:00+08:00'),
    source: 'agent',
  });
  assert.equal(late.when, Date.parse('2026-11-11T08:00:00+08:00'));
  assert.equal(late.quietHoursShifted, true);

  const early = service.create({
    patientId: 'pat_1',
    title: '清晨提醒',
    when: Date.parse('2026-11-11T06:30:00+08:00'),
    source: 'staff',
  });
  assert.equal(early.when, Date.parse('2026-11-11T08:00:00+08:00'));
  assert.equal(early.quietHoursShifted, true);

  const daytime = shiftForQuietHours(
    Date.parse('2026-11-11T12:00:00+08:00'),
    'Asia/Shanghai',
    { start: 21, end: 8 },
  );
  assert.equal(daytime.shifted, false);
});

test('#36 到期按时间顺序触发，标记 done 并保留 lastFiredAt', async () => {
  const { clock, service, events } = setupCare();
  service.create({
    patientId: 'pat_1',
    title: '第二条',
    when: Date.parse('2026-11-10T12:00:00+08:00'),
    source: 'agent',
  });
  service.create({
    patientId: 'pat_1',
    title: '第一条',
    when: Date.parse('2026-11-10T11:00:00+08:00'),
    source: 'staff',
  });

  const fired: string[] = [];
  service.start(async (plan) => {
    fired.push(plan.id);
    service.markDone(plan.id);
  });

  assert.equal(service.due().length, 0);
  clock.set(Date.parse('2026-11-10T11:30:00+08:00'));
  assert.equal(await service.fireDue(), 1);
  assert.deepEqual(fired, ['pln_2']);
  assert.equal(service.get('pln_2')?.status, 'done');
  assert.equal(service.get('pln_2')?.lastFiredAt, clock.now());

  clock.set(Date.parse('2026-11-10T12:30:00+08:00'));
  assert.equal(await service.fireDue(), 1);
  assert.equal(service.list(undefined, 'done').length, 2);
  assert.ok(events.some((event) => event.type === 'care_plan.fired'));
  service.dispose();
});

test('#36 重启后待执行计划仍在，并按时触发', async () => {
  const { backend, service } = setupCare();
  const created = service.create({
    patientId: 'pat_1',
    title: '三天后回访',
    when: Date.parse('2026-11-13T10:00:00+08:00'),
    source: 'agent',
  });
  await service.flush();
  service.dispose();

  const restoredClock = new FakeClock(Date.parse('2026-11-13T10:00:01+08:00'));
  const restored = new CareService({
    tenantId: 'tn_test',
    backend,
    timeZone: 'Asia/Shanghai',
    quietHours: { start: 21, end: 8 },
    now: () => restoredClock.now(),
    newId: (prefix) => `${prefix}_r`,
  });
  assert.equal(restored.list(undefined, 'pending').length, 1);
  assert.equal(restored.get(created.id)?.title, '三天后回访');

  const delivered: string[] = [];
  restored.start(async (plan) => {
    delivered.push(plan.title);
    restored.markDone(plan.id);
  });
  assert.equal(await restored.fireDue(), 1);
  assert.deepEqual(delivered, ['三天后回访']);
  restored.dispose();
});

test('#36 取消与完成：已执行不可取消；限流顺延保持 pending', async () => {
  const { clock, service } = setupCare();
  const plan = service.create({
    patientId: 'pat_1',
    title: '提醒测量',
    when: Date.parse('2026-11-10T11:00:00+08:00'),
    source: 'agent',
  });

  const cancelled = service.cancel(plan.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(service.cancel(plan.id).status, 'cancelled');

  const second = service.create({
    patientId: 'pat_1',
    title: '提醒吃药',
    when: Date.parse('2026-11-10T11:00:00+08:00'),
    source: 'agent',
  });
  clock.set(Date.parse('2026-11-10T11:00:00+08:00'));
  service.markDone(second.id);
  assert.throws(() => service.cancel(second.id), /IMMUTABLE_RESOURCE/);

  const third = service.create({
    patientId: 'pat_1',
    title: '限流计划',
    when: Date.parse('2026-11-10T11:30:00+08:00'),
    source: 'agent',
  });
  const retryAt = Date.parse('2026-11-10T12:00:00+08:00');
  const deferred = service.defer(third.id, retryAt, 'HOURLY_LIMIT');
  assert.equal(deferred.status, 'pending');
  assert.equal(deferred.when, retryAt);
  assert.equal(service.audits().at(-1)?.action, 'care_plan.defer');
});

test('#36 落盘失败走告警回调，不抛给调度循环', async () => {
  const clock = new FakeClock(BASE);
  const backend = new CareBackendFake();
  backend.failWrites = true;
  const errors: string[] = [];
  const service = new CareService({
    tenantId: 'tn_test',
    backend,
    timeZone: 'Asia/Shanghai',
    now: () => clock.now(),
    onPersistError: (error) => errors.push(error.message),
  });
  const plan = service.create({
    patientId: 'pat_1',
    title: '提醒',
    when: BASE + 60_000,
    source: 'agent',
  });
  await service.flush();
  assert.equal(service.get(plan.id)?.title, '提醒');
  assert.deepEqual(errors, ['DISK_FULL']);
  service.dispose();
});

test('#36 schedule_create 参数：ISO / 相对秒 / 二选一 / 过去时间', () => {
  const now = BASE;
  const iso = validateScheduleCreate(
    { title: '提醒量血压', when: '2026-11-11T08:00:00+08:00' },
    now,
  );
  assert.equal(iso.ok, true);
  if (iso.ok) assert.equal(iso.value.when, Date.parse('2026-11-11T08:00:00+08:00'));

  const relative = validateScheduleCreate({ title: '三天后回访', afterSeconds: 259_200 }, now);
  assert.equal(relative.ok, true);
  if (relative.ok) assert.equal(relative.value.when, now + 259_200_000);

  assert.equal(validateScheduleCreate({ title: '', when: '2026-11-11T08:00:00+08:00' }, now).ok, false);
  assert.equal(validateScheduleCreate({ title: 'x' }, now).ok, false);
  assert.equal(
    validateScheduleCreate({ title: 'x', when: now + 1000, afterSeconds: 60 }, now).ok,
    false,
  );
  assert.equal(validateScheduleCreate({ title: 'x', when: now - 1000 }, now).ok, false);
  assert.equal(validateScheduleCreate({ title: 'x', when: 'not-a-date' }, now).ok, false);
  assert.equal(validateScheduleCreate({ title: 'x', afterSeconds: -1 }, now).ok, false);
});

test('#36 schedule_create 工具：会话与患者解析、创建来源为 agent', async () => {
  const { service } = setupCare();
  const tools = buildCareToolDefinitions({
    patientForSession: (sessionId) => (sessionId === 'session_pat_1' ? 'pat_1' : undefined),
    create: (input) => service.create(input),
  });
  const tool = tools.find((item) => item.name === 'schedule_create');
  assert.ok(tool);

  const args = { title: '提醒量血压', when: '2030-01-01T08:00:00+08:00' };
  await assert.rejects(tool.execute(args, { agent: undefined }), /INVALID_TOOL_ARGS .*会话/);
  await assert.rejects(
    tool.execute(args, { agent: { id: 'session_other' } }),
    /INVALID_TOOL_ARGS .*没有关联患者/,
  );

  const result = (await tool.execute(args, { agent: { id: 'session_pat_1' } })) as {
    planId: string;
    title: string;
    status: string;
  };
  assert.equal(result.title, '提醒量血压');
  assert.equal(result.status, 'pending');
  assert.equal(service.get(result.planId)?.source, 'agent');
});

test('zhiban-care 配置：时区校验、安静时段范围、默认值', () => {
  const config = parseCareConfig({ tenantId: 'tn_1' });
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.deepEqual(config.quietHours, { start: 21, end: 8 });
  assert.equal(config.sandbox, false);

  assert.throws(() => parseCareConfig({}), /tenantId|缺少配置项/);
  assert.throws(() => parseCareConfig({ tenantId: 'tn_1', timeZone: 'Mars/Base' }), /timeZone/);
  assert.throws(() => parseCareConfig({ tenantId: 'tn_1', quietHoursStart: 24 }), /quietHoursStart/);
  assert.throws(() => parseCareConfig({ tenantId: 'tn_1', sandbox: 'yes' }), /sandbox/);
});
