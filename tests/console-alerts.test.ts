/**
 * #39 告警服务单测：事件入库、去重、列表、处理、释放队列、恢复顾问。
 * 事件与备注均为虚构内容。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConsoleError } from '../src/p1/console-error.ts';
import { AlertService, type AlertOpsPort } from '../src/p1/console-alerts.ts';
import { ConsoleStore, MemoryConsoleBackend } from '../src/p1/console-store.ts';

const ACTOR = { id: 'acc_admin', name: '林主管', role: 'admin' };

function setup(options: { ops?: () => AlertOpsPort | undefined } = {}) {
  let now = 1_760_000_000_000;
  const store = new ConsoleStore({ backend: new MemoryConsoleBackend(), now: () => now });
  const events: { type: string; data: unknown }[] = [];
  const service = new AlertService({
    tenantId: 'tn_test',
    store,
    now: () => now,
    emit: (type, data) => events.push({ type, data }),
    ops: options.ops,
  });
  return {
    store,
    service,
    events,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('C2 大写告警转成 P1 实体，标题/严重级别取默认值', () => {
  const { service, events } = setup();
  const alert = service.ingest({
    kind: 'MISROUTE',
    message: '  发错群给客户  ',
    advisorId: 'adv_1',
    draftId: 'draft_1',
    at: 1_759_999_000_000,
  });
  assert.ok(alert);
  assert.equal(alert!.kind, 'misroute');
  assert.equal(alert!.title, '发错群');
  assert.equal(alert!.severity, 'critical');
  assert.equal(alert!.status, 'open');
  assert.equal(alert!.message, '发错群给客户');
  assert.equal(alert!.advisorId, 'adv_1');
  assert.equal(alert!.draftId, 'draft_1');
  assert.equal(alert!.createdAt, 1_759_999_000_000);
  assert.match(alert!.id, /^alt_/);
  assert.equal(events.some((event) => event.type === 'alert.created'), true);
});

test('P1 告警实体保留 id，重复事件幂等；未知类型与沙盒事件忽略', () => {
  const { service } = setup();
  const first = service.ingest({
    id: 'alt_known',
    kind: 'redline',
    severity: 'critical',
    status: 'acknowledged',
    title: '红线',
    patientId: 'pat_1',
  });
  assert.equal(first?.id, 'alt_known');
  assert.equal(first?.severity, 'critical');
  assert.equal(first?.status, 'acknowledged');

  const again = service.ingest({ id: 'alt_known', kind: 'redline' });
  assert.equal(again?.id, 'alt_known');
  assert.equal(service.list().total, 1);

  assert.equal(service.ingest({ kind: 'UNKNOWN_KIND' }), undefined);
  assert.equal(service.ingest({ kind: 'misroute', sandbox: true }), undefined);
  assert.equal(service.ingest(null), undefined);
  assert.equal(service.ingest('alert'), undefined);
});

test('正文只在实体里截断到 200 字，事件与审计不带正文', () => {
  const { service, events, store } = setup();
  const alert = service.ingest({ kind: 'remind', message: 'x'.repeat(500) });
  assert.equal(alert!.message.length, 200);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('x'.repeat(201)), false);
  }
  assert.equal(store.listAudits().length, 0);
});

test('列表按时间倒序、支持筛选与分页；未解决计数不含已解决', () => {
  const { service, advance } = setup();
  service.ingest({ id: 'alt_a', kind: 'misroute', advisorId: 'adv_1', message: 'A' });
  advance(1_000);
  service.ingest({ id: 'alt_b', kind: 'remind', advisorId: 'adv_2', message: 'B' });
  advance(1_000);
  service.ingest({ id: 'alt_c', kind: 'remind', advisorId: 'adv_1', message: 'C' });

  assert.deepEqual(
    service.list().items.map((alert) => alert.id),
    ['alt_c', 'alt_b', 'alt_a'],
  );
  assert.equal(service.list({ kind: 'remind' }).total, 2);
  assert.equal(service.list({ advisorId: 'adv_1' }).total, 2);
  assert.equal(service.list({ page: 2, pageSize: 2 }).items.length, 1);
  assert.deepEqual(service.unresolvedCount(), { open: 3, acknowledged: 0, total: 3 });

  service.resolve('alt_a', '已处理', ACTOR);
  assert.deepEqual(service.unresolvedCount(), { open: 2, acknowledged: 0, total: 2 });
  assert.equal(service.list({ status: 'resolved' }).total, 1);
});

test('resolve 必须有备注，只能处理一次，写入处理人并派发事件', () => {
  const { service, events, store } = setup();
  service.ingest({ id: 'alt_x', kind: 'misroute', advisorId: 'adv_1' });

  assert.throws(
    () => service.resolve('alt_x', '   ', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => service.resolve('alt_x', 'x'.repeat(201), ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );

  const resolved = service.resolve('alt_x', '  已与顾问确认  ', ACTOR);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.note, '已与顾问确认');
  assert.equal(resolved.resolvedBy, ACTOR.id);
  assert.ok(resolved.resolvedAt);
  assert.equal(
    events.filter((event) => event.type === 'alert.resolved' && (event.data as { id: string }).id === 'alt_x').length,
    1,
  );
  const audit = store.listAudits().find((event) => event.action === 'alert.resolve');
  assert.equal(audit?.targetId, 'alt_x');
  assert.equal(audit?.detail?.noteLength, 6);

  assert.throws(
    () => service.resolve('alt_x', '重复处理', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
});

test('get 只返回本租户告警', () => {
  const { service } = setup();
  service.ingest({ id: 'alt_other', kind: 'remind' });
  assert.equal(service.get('alt_other').id, 'alt_other');
  assert.throws(
    () => service.get('alt_missing'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );
});

test('释放队列：未装企微插件返回 502；无顾问返回 CONFLICT；成功转为 acknowledged 并审计', async () => {
  const withoutOps = setup();
  withoutOps.service.ingest({ id: 'alt_q1', kind: 'unverified', advisorId: 'adv_1' });
  await assert.rejects(
    () => withoutOps.service.releaseQueue('alt_q1', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'UPSTREAM_UNAVAILABLE',
  );

  const calls: string[] = [];
  const ops: AlertOpsPort = {
    async releaseQueue(advisorId) {
      calls.push(advisorId);
      return { releasedDraftId: 'draft_new', nextDraftId: 'draft_next' };
    },
    async restoreAdvisor() {
      throw new Error('not used');
    },
  };
  const { service, store, events } = setup({ ops: () => ops });
  service.ingest({ id: 'alt_q1', kind: 'unverified', advisorId: 'adv_1' });
  const result = await service.releaseQueue('alt_q1', ACTOR);
  assert.deepEqual(calls, ['adv_1']);
  assert.equal(result.releasedDraftId, 'draft_new');
  assert.equal(result.nextDraftId, 'draft_next');
  assert.equal(result.alert.status, 'acknowledged');

  const audit = store.listAudits().find((event) => event.action === 'advisor.queue.release');
  assert.equal(audit?.targetId, 'adv_1');
  assert.equal(audit?.detail?.alertId, 'alt_q1');
  assert.equal(events.some((event) => event.type === 'alert.updated'), true);

  service.ingest({ id: 'alt_q2', kind: 'unverified' });
  await assert.rejects(
    () => service.releaseQueue('alt_q2', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
});

test('释放队列把上游错误映射成 404 / 409 / 502', async () => {
  const make = (message: string) => {
    const ops: AlertOpsPort = {
      async releaseQueue() {
        throw new Error(message);
      },
      async restoreAdvisor() {
        throw new Error('not used');
      },
    };
    const { service } = setup({ ops: () => ops });
    service.ingest({ id: 'alt_e', kind: 'unverified', advisorId: 'adv_1' });
    return service;
  };

  await assert.rejects(
    () => make('NO_ACTIVE_DRAFT').releaseQueue('alt_e', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
  await assert.rejects(
    () => make('ADVISOR_NOT_FOUND adv_1').releaseQueue('alt_e', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => make('socket hang up').releaseQueue('alt_e', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'UPSTREAM_UNAVAILABLE',
  );
});

test('恢复顾问：成功返回 active 并派发 advisor.updated；重复恢复同一告警幂等不报错', async () => {
  const calls: string[] = [];
  const ops: AlertOpsPort = {
    async releaseQueue() {
      throw new Error('not used');
    },
    async restoreAdvisor(advisorId) {
      calls.push(advisorId);
      return { id: advisorId, name: '顾问一号', status: 'active' as const, consecutiveMisroutes: 0 };
    },
  };
  const { service, events, store } = setup({ ops: () => ops });
  service.ingest({ id: 'alt_r', kind: 'advisor_paused', advisorId: 'adv_9' });

  const result = await service.restoreAdvisor('alt_r', ACTOR);
  assert.deepEqual(calls, ['adv_9']);
  assert.equal(result.advisor.status, 'active');
  assert.equal(result.alert.status, 'acknowledged');
  assert.equal(
    events.some(
      (event) =>
        event.type === 'advisor.updated' &&
        (event.data as { id: string; status: string }).id === 'adv_9' &&
        (event.data as { status: string }).status === 'active',
    ),
    true,
  );
  const audit = store.listAudits().find((event) => event.action === 'advisor.resume');
  assert.equal(audit?.targetId, 'adv_9');

  // 已 acknowledged 的告警再次操作仍可调用，但已解决的不行
  const second = await service.restoreAdvisor('alt_r', ACTOR);
  assert.equal(second.alert.status, 'acknowledged');
  service.resolve('alt_r', '完成', ACTOR);
  await assert.rejects(
    () => service.restoreAdvisor('alt_r', ACTOR),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
});
