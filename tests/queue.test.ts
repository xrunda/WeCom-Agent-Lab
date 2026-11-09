import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_QUEUE_CONFIG } from '../src/c2/queue.ts';
import type { C2Service } from '../src/c2/service.ts';
import type { ServiceConfig } from '../src/c2/service.ts';
import { setup } from './helpers.ts';

function prepare(config?: ServiceConfig) {
  const ctx = setup(config);
  ctx.service.addAdvisor({ id: 'a1', name: '顾问', chatId: 'chat_a1' });
  ctx.service.bindGroup({ roomId: 'room_1', name: '群 1', advisorId: 'a1' });
  return ctx;
}

function enqueue(service: C2Service, id: string, body = `这是 ${id} 的回复正文，内容足够长以便匹配。`) {
  return service.enqueueDraft({
    id,
    advisorId: 'a1',
    groupRoomId: 'room_1',
    customerId: 'c1',
    customerName: '客户 1',
    inboundMessageId: `in_${id}`,
    inboundSummary: '客户问题',
    body,
  });
}

test('同一顾问同一时间只推送一条草稿', async () => {
  const { service, store, bot } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');
  enqueue(service, 'D3');

  await service.tick();

  assert.equal(bot.cards().length, 1);
  assert.equal(bot.texts().length, 1);
  assert.equal(store.getActiveDraft('a1'), 'D1');
  assert.equal(store.getDraft('D2')?.status, 'QUEUED');
  assert.equal(store.getDraft('D3')?.status, 'QUEUED');

  // 不确认就不会推送下一条
  await service.tick();
  assert.equal(bot.cards().length, 1);
});

test('确认后队列释放，下一条才推送', async () => {
  const { service, store, bot } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');

  await service.tick();
  service.acknowledge('D1', 'sent');
  assert.equal(store.getActiveDraft('a1'), undefined);

  await service.tick();
  assert.equal(bot.cards().length, 2);
  assert.equal(store.getActiveDraft('a1'), 'D2');
});

test('不同顾问互不阻塞，可以并行推送', async () => {
  const { service, store, bot, clock } = prepare();
  service.addAdvisor({ id: 'a2', name: '顾问 2', chatId: 'chat_a2' });
  service.bindGroup({ roomId: 'room_2', name: '群 2', advisorId: 'a2' });

  enqueue(service, 'D1');
  service.enqueueDraft({
    id: 'E1',
    advisorId: 'a2',
    groupRoomId: 'room_2',
    customerId: 'c2',
    customerName: '客户 2',
    inboundMessageId: 'in_E1',
    inboundSummary: '客户问题',
    body: '这是 E1 的回复正文，内容足够长以便匹配。',
  });

  await service.tick();
  assert.equal(bot.cards().length, 2);
  assert.equal(store.getActiveDraft('a1'), 'D1');
  assert.equal(store.getActiveDraft('a2'), 'E1');
  assert.ok(clock.now() >= 0);
});

test('正文发送失败后重试，不重复发送卡片', async () => {
  const { service, store, bot, clock } = prepare();
  enqueue(service, 'D1');

  bot.failTextTimes = 1;
  await service.tick();

  const draft = store.getDraft('D1');
  assert.equal(draft?.status, 'QUEUED');
  assert.equal(draft?.pushAttempts, 1);
  assert.ok((draft?.nextAttemptAt ?? 0) > clock.now());
  assert.equal(bot.cards().length, 1);
  assert.equal(bot.texts().length, 0);
  assert.ok(store.listAlerts().some((a) => a.kind === 'PUSH_FAILED'));
  assert.equal(store.getActiveDraft('a1'), undefined);

  // 未到退避时间，不重试
  await service.tick();
  assert.equal(bot.texts().length, 0);

  clock.advance(DEFAULT_QUEUE_CONFIG.retryBackoffMs);
  await service.tick();

  assert.equal(bot.cards().length, 1, '重试不应重复发送卡片');
  assert.equal(bot.texts().length, 1);
  assert.equal(store.getDraft('D1')?.status, 'PUSHED');
  assert.equal(store.getActiveDraft('a1'), 'D1');
});

test('连续失败达到上限进入死信并告警', async () => {
  const { service, store, bot, clock } = prepare();
  enqueue(service, 'D1');
  bot.failTextTimes = 10;

  await service.tick();
  clock.advance(DEFAULT_QUEUE_CONFIG.retryBackoffMs);
  await service.tick();
  clock.advance(DEFAULT_QUEUE_CONFIG.retryBackoffMs * 2);
  await service.tick();

  const draft = store.getDraft('D1');
  assert.equal(draft?.status, 'DEAD_LETTER');
  assert.equal(draft?.pushAttempts, DEFAULT_QUEUE_CONFIG.maxPushAttempts);
  assert.equal(bot.cards().length, 1);
  assert.equal(store.getActiveDraft('a1'), undefined);
  assert.ok(store.listAlerts().some((a) => a.kind === 'DEAD_LETTER'));
});

test('顾问未绑定机器人会话时只告警一次，不推送', async () => {
  const { service, store, bot } = setup();
  service.addAdvisor({ id: 'a1', name: '顾问' });
  service.bindGroup({ roomId: 'room_1', name: '群 1', advisorId: 'a1' });
  enqueue(service, 'D1');

  await service.tick();
  await service.tick();

  assert.equal(bot.cards().length, 0);
  assert.equal(bot.texts().length, 0);
  assert.equal(store.listAlerts().filter((a) => a.kind === 'NO_CHATID').length, 1);
  assert.equal(store.getDraft('D1')?.status, 'QUEUED');
});

test('暂停的顾问不再推送', async () => {
  const { service, store, bot } = prepare();
  enqueue(service, 'D1');
  const advisor = store.getAdvisor('a1');
  assert.ok(advisor);
  advisor.status = 'paused';
  store.saveAdvisor(advisor);

  await service.tick();
  assert.equal(bot.cards().length, 0);
});

test('超时未处理会提醒，提醒只发一次', async () => {
  const { service, store, bot, clock } = prepare();
  enqueue(service, 'D1');
  await service.tick();
  assert.equal(bot.texts().length, 1);

  clock.advance(DEFAULT_QUEUE_CONFIG.remindAfterMs);
  await service.tick();
  assert.equal(bot.texts().length, 2);
  const reminder = bot.texts()[1]?.message;
  assert.match(reminder?.msgtype === 'text' ? reminder.text.content : '', /提醒/);
  assert.ok(store.getDraft('D1')?.remindedAt);

  clock.advance(60_000);
  await service.tick();
  assert.equal(bot.texts().length, 2);
});

test('长时间未处理会升级并告警', async () => {
  const { service, store, clock } = prepare();
  enqueue(service, 'D1');
  await service.tick();

  clock.advance(DEFAULT_QUEUE_CONFIG.escalateAfterMs);
  await service.tick();

  assert.ok(store.getDraft('D1')?.escalatedAt);
  assert.ok(store.listAlerts().some((a) => a.kind === 'ESCALATED'));
});

test('忽略草稿会释放队列且不进入校验', async () => {
  const { service, store, bot } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');

  await service.tick();
  service.acknowledge('D1', 'skipped');

  const skipped = store.getDraft('D1');
  assert.equal(skipped?.status, 'SKIPPED');
  assert.equal(skipped?.nextVerifyAt, undefined);
  assert.equal(store.getActiveDraft('a1'), undefined);

  await service.tick();
  assert.equal(bot.cards().length, 2);
  assert.equal(store.getActiveDraft('a1'), 'D2');
});

test('入队时校验群归属和正文长度', () => {
  const { service, store } = prepare();
  service.addAdvisor({ id: 'a2', name: '顾问 2', chatId: 'chat_a2' });

  assert.throws(
    () =>
      service.enqueueDraft({
        advisorId: 'a2',
        groupRoomId: 'room_1',
        customerId: 'c1',
        customerName: '客户 1',
        inboundMessageId: 'in_x',
        inboundSummary: '问题',
        body: '正文正文正文',
      }),
    /ADVISOR_MISMATCH/,
  );

  assert.throws(
    () =>
      service.enqueueDraft({
        advisorId: 'a1',
        groupRoomId: 'room_1',
        customerId: 'c1',
        customerName: '客户 1',
        inboundMessageId: 'in_x',
        inboundSummary: '问题',
        body: '   ',
      }),
    /EMPTY_BODY/,
  );

  assert.throws(
    () =>
      service.enqueueDraft({
        advisorId: 'a1',
        groupRoomId: 'room_404',
        customerId: 'c1',
        customerName: '客户 1',
        inboundMessageId: 'in_x',
        inboundSummary: '问题',
        body: '正文正文正文',
      }),
    /GROUP_NOT_FOUND/,
  );

  assert.equal(store.listDrafts().length, 0);
});
