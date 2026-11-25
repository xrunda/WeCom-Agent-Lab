/**
 * PH5-07（#236）跟进队列：认领即首次人工响应、超时升级、并发认领、范围隔离。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import {
  DEFAULT_SLA,
  FollowupError,
  FollowupService,
  MemoryFollowupBackend,
} from '../src/p1/patient-h5-followup.ts';

const NOW = new Date('2026-11-25T09:00:00+08:00').getTime();

function setup(options: { supervisor?: string } = {}) {
  const clock = new FakeClock(NOW);
  const service = new FollowupService({
    tenantId: 'tn_fup',
    backend: new MemoryFollowupBackend(),
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
    sla: { ...DEFAULT_SLA, highRiskMinutes: 30 },
    ...(options.supervisor ? { supervisorAccountId: options.supervisor } : {}),
  });
  return { clock, service };
}

test('自动回执不等于处理：新建后状态仍是待接收，claimedAt 为空', async () => {
  const { service } = setup();
  const record = await service.create({
    patientId: 'pat_a',
    kind: 'question',
    message: '这周出差，晚餐时间不固定怎么办',
  });
  assert.equal(record.status, 'pending');
  assert.ok(record.autoAckSentAt, '系统回执已发');
  assert.equal(record.claimedAt, undefined, '但不等于有人处理');

  const view = service.getForPatient('pat_a', record.id);
  assert.equal(view.status, 'pending');
  assert.equal(view.claimedAt, null, '前端看到的首次人工响应为空');
});

test('认领后记到人，认领时间即首次人工响应', async () => {
  const { service, clock } = setup();
  const record = await service.create({ patientId: 'pat_a', kind: 'question', message: '想问计划' });
  clock.advance(10 * 60 * 1000);
  const claimed = await service.claim({ id: record.id, accountId: 'acc_1', accountName: '李顾问' });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.assigneeName, '李顾问');
  assert.equal(claimed.claimedAt, NOW + 10 * 60 * 1000);
});

test('并发认领只有一个成功（另一个收到已关闭）', async () => {
  const { service } = setup();
  const record = await service.create({ patientId: 'pat_a', kind: 'question', message: 'x' });
  const results = await Promise.allSettled([
    service.claim({ id: record.id, accountId: 'acc_1', accountName: 'A' }),
    service.claim({ id: record.id, accountId: 'acc_2', accountName: 'B' }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof FollowupError);
  assert.equal(rejected.reason.code, 'FOLLOWUP_CLOSED');
});

test('风险类请求 SLA 更短；超时进入待升级', async () => {
  const { service, clock } = setup({ supervisor: 'acc_sup' });
  const risk = await service.create({
    patientId: 'pat_a',
    kind: 'risk',
    message: '晚饭后有点胀',
    riskLevel: 'high',
  });
  assert.equal(risk.slaDueAt, NOW + 30 * 60 * 1000, '高风险 30 分钟');

  clock.advance(31 * 60 * 1000);
  assert.equal(service.getForPatient('pat_a', risk.id).overdue, true);

  const result = await service.escalateOverdue();
  assert.deepEqual(result.escalated, [risk.id]);
  assert.equal(service.getForPatient('pat_a', risk.id).escalated, true);
});

test('没有配置主管时不假装升级，只标未指派', async () => {
  const { service, clock } = setup();
  const record = await service.create({ patientId: 'pat_a', kind: 'question', message: 'x' });
  clock.advance(DEFAULT_SLA.defaultMinutes * 60 * 1000 + 1000);
  const result = await service.escalateOverdue();
  assert.equal(result.escalated.length, 0);
  assert.deepEqual(result.stillUnassigned, [record.id]);
  assert.equal(service.getForPatient('pat_a', record.id).escalated, false);
});

test('处理完成记录结论；已完成的不再出现在待办计数里', async () => {
  const { service } = setup();
  const record = await service.create({ patientId: 'pat_a', kind: 'need_help', message: '记录不了' });
  const before = service.unresolvedCount();
  assert.equal(before.pending, 1);
  assert.equal(before.overdue, 0);

  const resolved = await service.resolve({ id: record.id, accountId: 'acc_1', note: '已电话沟通' });
  assert.equal(resolved.status, 'resolved');
  const after = service.unresolvedCount();
  assert.equal(after.pending, 0);
  assert.equal(after.overdue, 0);
});

test('团队队列按超时优先排序，且可按 status 过滤', async () => {
  const { service, clock } = setup();
  const normal = await service.create({ patientId: 'pat_a', kind: 'question', message: '普通' });
  clock.advance(60 * 60 * 1000);
  const urgent = await service.create({ patientId: 'pat_b', kind: 'risk', message: '不适', riskLevel: 'high' });
  clock.advance(40 * 60 * 1000); // urgent 已超时，normal 未超时

  const queue = service.listForTeam();
  assert.equal(queue[0]?.id, urgent.id, '超时的排最前');
  assert.equal(queue.find((item) => item.id === normal.id)?.overdue, false);

  await service.claim({ id: urgent.id, accountId: 'acc_1', accountName: 'A' });
  assert.equal(service.listForTeam({ status: 'pending' }).length, 1);
  assert.equal(service.listForTeam({ status: 'claimed' }).length, 1);
});

test('患者只能看到自己的请求；范围按 patientIds 收窄', async () => {
  const { service } = setup();
  const mine = await service.create({ patientId: 'pat_a', kind: 'question', message: 'a' });
  await service.create({ patientId: 'pat_b', kind: 'question', message: 'b' });
  assert.equal(service.listForPatient('pat_a').length, 1);
  assert.equal(service.listForPatient('pat_a')[0]?.id, mine.id);
  assert.equal(service.listForTeam({ patientIds: ['pat_a'] }).length, 1);
});

test('患者撤销后不再出现在待办', async () => {
  const { service } = setup();
  const record = await service.create({ patientId: 'pat_a', kind: 'question', message: 'x' });
  const closed = await service.closeByPatient('pat_a', record.id);
  assert.equal(closed.status, 'resolved');
  assert.equal(service.unresolvedCount().pending, 0);
});
