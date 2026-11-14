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

test('#37 命中规则随草稿落库，改稿后按新结果更新', () => {
  const { service, store } = prepare();
  const draft = service.enqueueDraft({
    id: 'D_guard',
    advisorId: 'a1',
    groupRoomId: 'room_1',
    customerId: 'c1',
    customerName: '客户 1',
    inboundMessageId: 'in_guard',
    inboundSummary: '客户问题',
    body: '您描述的情况需要尽快由医生处理。',
    ruleIds: ['rul_builtin_emergency'],
    ruleNames: ['急症只引导就医'],
    riskLevel: 'high',
  });
  assert.deepEqual(store.getDraft(draft.id)?.ruleIds, ['rul_builtin_emergency']);
  assert.deepEqual(store.getDraft(draft.id)?.ruleNames, ['急症只引导就医']);

  const revised = service.reviseDraft(draft.id, {
    body: '改后的正文',
    ruleIds: [],
    ruleNames: [],
  });
  assert.deepEqual(store.getDraft(revised.id)?.ruleIds, []);
  assert.equal(store.getDraft(revised.id)?.ruleNames, undefined);
});

test('#163 草稿不再推送卡片/正文，只标记 PUSHED 供侧边栏展示', async () => {
  const { service, store, bot } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');
  enqueue(service, 'D3');

  await service.tick();

  // 不做内容分发：1:1 没有卡片、正文或图片
  assert.equal(bot.sent.length, 0);
  assert.equal(store.getActiveDraft('a1'), 'D1');
  assert.equal(store.getDraft('D1')?.status, 'PUSHED');
  assert.equal(store.getDraft('D2')?.status, 'PUSHED');
  assert.equal(store.getDraft('D3')?.status, 'PUSHED');
});

test('确认后 active 指向下一条待处理草稿', async () => {
  const { service, store } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');

  await service.tick();
  service.acknowledge('D1', 'sent');
  assert.equal(store.getActiveDraft('a1'), undefined);

  await service.tick();
  assert.equal(store.getActiveDraft('a1'), 'D2');
  assert.equal(store.getDraft('D2')?.status, 'PUSHED');
});

test('不同顾问互不阻塞', async () => {
  const { service, store } = prepare();
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
  assert.equal(store.getActiveDraft('a1'), 'D1');
  assert.equal(store.getActiveDraft('a2'), 'E1');
});

test('客户等待超过阈值才发聚合提醒，且不重复刷屏', async () => {
  const { service, store, bot, clock } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');
  await service.tick();
  assert.equal(bot.texts().length, 0);

  clock.advance(DEFAULT_QUEUE_CONFIG.remindAfterMs);
  await service.tick();
  assert.equal(bot.texts().length, 1);
  const reminder = bot.texts()[0]?.message;
  const content = reminder?.msgtype === 'text' ? reminder.text.content : '';
  assert.match(content, /客户在等/);
  assert.match(content, /1 个群/);
  // 不带正文
  assert.equal(content.includes('这是 D1 的回复正文'), false);
  assert.ok(store.getDraft('D1')?.remindedAt);
  assert.ok(store.getDraft('D2')?.remindedAt);

  clock.advance(60_000);
  await service.tick();
  assert.equal(bot.texts().length, 1, '同一批草稿不重复提醒');
});

test('顾问未绑定机器人会话时只在需要提醒时告警一次', async () => {
  const { service, store, bot, clock } = setup();
  service.addAdvisor({ id: 'a1', name: '顾问' });
  service.bindGroup({ roomId: 'room_1', name: '群 1', advisorId: 'a1' });
  enqueue(service, 'D1');

  await service.tick();
  assert.equal(bot.texts().length, 0);

  clock.advance(DEFAULT_QUEUE_CONFIG.remindAfterMs);
  await service.tick();
  await service.tick();

  assert.equal(bot.cards().length, 0);
  assert.equal(bot.texts().length, 0);
  assert.equal(store.listAlerts().filter((a) => a.kind === 'NO_CHATID').length, 1);
  assert.equal(store.getDraft('D1')?.status, 'PUSHED');
});

test('暂停的顾问不再处理队列', async () => {
  const { service, store } = prepare();
  enqueue(service, 'D1');
  const advisor = store.getAdvisor('a1');
  assert.ok(advisor);
  advisor.status = 'paused';
  store.saveAdvisor(advisor);

  await service.tick();
  assert.equal(store.getDraft('D1')?.status, 'QUEUED');
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

test('升级时 1:1 推送给配置的主管，排除顾问本人且只推一次', async () => {
  const { service, bot, clock } = prepare({
    queue: { supervisorChatIds: ['sup_1', 'sup_2', 'chat_a1'] },
  });
  enqueue(service, 'D1');
  await service.tick();

  clock.advance(DEFAULT_QUEUE_CONFIG.escalateAfterMs);
  await service.tick();

  const supervisorTexts = () =>
    bot.texts().filter((item) => item.chatId === 'sup_1' || item.chatId === 'sup_2');
  assert.equal(supervisorTexts().length, 2);
  const first = supervisorTexts()[0]!.message;
  const content = first.msgtype === 'text' ? first.text.content : '';
  assert.match(content, /升级/);
  assert.match(content, /群 1 · 客户 1/);
  // 不带草稿正文
  assert.equal(content.includes('这是 D1 的回复正文'), false);
  // 不重复推给顾问本人
  assert.equal(
    bot
      .texts()
      .some(
        (item) =>
          item.chatId === 'chat_a1' &&
          item.message.msgtype === 'text' &&
          item.message.text.content.includes('升级'),
      ),
    false,
  );

  clock.advance(60_000);
  await service.tick();
  assert.equal(supervisorTexts().length, 2);
});

test('未配置主管时不额外推送，只保留 ESCALATED 告警', async () => {
  const { service, store, bot, clock } = prepare();
  enqueue(service, 'D1');
  await service.tick();

  clock.advance(DEFAULT_QUEUE_CONFIG.escalateAfterMs);
  await service.tick();

  assert.ok(store.listAlerts().some((a) => a.kind === 'ESCALATED'));
  assert.equal(
    bot
      .texts()
      .filter(
        (item) => item.message.msgtype === 'text' && item.message.text.content.includes('升级'),
      ).length,
    0,
  );
});

test('忽略草稿会释放队列且不进入校验', async () => {
  const { service, store } = prepare();
  enqueue(service, 'D1');
  enqueue(service, 'D2');

  await service.tick();
  service.acknowledge('D1', 'skipped');

  const skipped = store.getDraft('D1');
  assert.equal(skipped?.status, 'SKIPPED');
  assert.equal(skipped?.nextVerifyAt, undefined);
  assert.equal(store.getActiveDraft('a1'), undefined);

  await service.tick();
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

test('#163 图片与正文不再转推给顾问', async () => {
  const { service, bot, store } = prepare();
  service.enqueueDraft({
    id: 'I1',
    advisorId: 'a1',
    groupRoomId: 'room_1',
    customerId: 'c1',
    customerName: '客户 1',
    inboundMessageId: 'in_I1',
    inboundSummary: '发来一张晚餐照片',
    body: '晚餐搭配不错，酱汁少一点会更清爽。',
    mediaIds: ['/tmp/media/meal.jpg'],
    mediaKinds: ['meal'],
  });

  await service.tick();
  assert.equal(bot.images().length, 0);
  assert.equal(bot.texts().length, 0);
  assert.equal(bot.cards().length, 0);
  assert.equal(store.getDraft('I1')?.mediaForwardedAt, undefined);
  // 草稿仍在侧边栏可见，媒体信息保留在草稿上
  assert.deepEqual(store.getDraft('I1')?.mediaKinds, ['meal']);
  assert.equal(store.getDraft('I1')?.status, 'PUSHED');
});
