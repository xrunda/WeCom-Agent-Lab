/**
 * #39 管理员队列操作单测：释放队列、恢复顾问、RELEASED 状态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTransition,
  canTransition,
  isTerminal,
  releasesQueue,
} from '../src/c2/state-machine.ts';
import type { Draft } from '../src/c2/types.ts';
import { bindDefaultAdvisor, makeDraft, setup } from './helpers.ts';

test('RELEASED 是终态：只能从 PUSHED 进入，之后不再转移', () => {
  assert.equal(canTransition('PUSHED', 'RELEASED'), true);
  assert.equal(canTransition('QUEUED', 'RELEASED'), false);
  assert.equal(canTransition('ACKNOWLEDGED', 'RELEASED'), false);
  assert.equal(canTransition('RELEASED', 'QUEUED'), false);
  assert.equal(canTransition('RELEASED', 'PUSHED'), false);
  assert.equal(isTerminal('RELEASED'), true);
  assert.equal(releasesQueue('RELEASED'), true);

  const draft = makeDraft({ status: 'PUSHED' }) as Draft;
  applyTransition(draft, 'RELEASED');
  assert.equal(draft.status, 'RELEASED');
  assert.throws(() => applyTransition(draft, 'QUEUED'), /ILLEGAL_TRANSITION/);
});

test('releaseQueue 把阻塞草稿置为 RELEASED，并立即交接下一条', async () => {
  const { service, store, bot } = setup();
  bindDefaultAdvisor(service);
  service.bindGroup({ roomId: 'room_1', name: '客户群一', advisorId: 'a1' });

  const first = service.enqueueDraft({
    advisorId: 'a1',
    groupRoomId: 'room_1',
    customerId: 'cust_1',
    customerName: '客户一',
    lastInboundAt: 1_700_000_000_000,
    inboundMessageId: 'in_1',
    inboundSummary: '客户问晚餐',
    body: '可以试试清淡的晚餐搭配。',
  });
  const second = service.enqueueDraft({
    advisorId: 'a1',
    groupRoomId: 'room_1',
    customerId: 'cust_2',
    customerName: '客户二',
    lastInboundAt: 1_700_000_000_000,
    inboundMessageId: 'in_2',
    inboundSummary: '客户问加餐',
    body: '加餐建议少量坚果。',
  });

  const pushed = await service.tick();
  // #163：不向 1:1 推送内容，两条都标记 PUSHED，active 指向最早的一条
  assert.equal(pushed.pushed.length, 2);
  assert.equal(bot.sent.length, 0);
  assert.equal(store.getDraft(first.id)?.status, 'PUSHED');
  assert.equal(store.getDraft(second.id)?.status, 'PUSHED');
  assert.equal(store.getActiveDraft('a1'), first.id);

  const result = await service.releaseQueue('a1', 'acc_admin');
  assert.equal(result.releasedDraftId, first.id);
  assert.equal(store.getDraft(first.id)?.status, 'RELEASED');
  assert.equal(store.getDraft(first.id)?.nextAttemptAt, Number.MAX_SAFE_INTEGER);
  assert.equal(store.getDraft(second.id)?.status, 'PUSHED');
  assert.equal(store.getActiveDraft('a1'), second.id);
  assert.equal(result.nextDraftId, second.id);

  const audit = store.listAudit().find((event) => event.action === 'release_queue');
  assert.equal(audit?.target, first.id);
  assert.equal(audit?.actor, 'acc_admin');
});

test('没有阻塞草稿或顾问不存在时 releaseQueue 报错', async () => {
  const { service } = setup();
  bindDefaultAdvisor(service);
  await assert.rejects(() => service.releaseQueue('a1'), /NO_ACTIVE_DRAFT/);
  await assert.rejects(() => service.releaseQueue('a_missing'), /ADVISOR_NOT_FOUND/);
});

test('releaseQueue 遇到非 PUSHED 的 active 草稿时报 DRAFT_NOT_PUSHED', async () => {
  const { service, store } = setup();
  bindDefaultAdvisor(service);
  const draft = makeDraft({ id: 'd_x', status: 'ACKNOWLEDGED' });
  store.saveDraft(draft);
  store.setActiveDraft('a1', draft.id);
  await assert.rejects(() => service.releaseQueue('a1'), /DRAFT_NOT_PUSHED/);
});

test('restoreAdvisor 清除 ADVISOR_PAUSED 与连续错群计数并审计', () => {
  const { service, store } = setup();
  bindDefaultAdvisor(service);
  store.saveAdvisor({
    id: 'a1',
    name: '测试顾问',
    chatId: 'chat_a1',
    status: 'paused',
    consecutiveMisroutes: 3,
  });

  const restored = service.restoreAdvisor('a1', 'acc_admin');
  assert.equal(restored.status, 'active');
  assert.equal(restored.consecutiveMisroutes, 0);
  assert.equal(store.getAdvisor('a1')?.status, 'active');

  const audit = store.listAudit().find((event) => event.action === 'resume');
  assert.equal(audit?.target, 'a1');
  assert.equal(audit?.actor, 'acc_admin');

  assert.throws(() => service.restoreAdvisor('a_missing'), /ADVISOR_NOT_FOUND/);
});
