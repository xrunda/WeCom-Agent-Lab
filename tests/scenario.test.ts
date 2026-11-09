import test from 'node:test';
import assert from 'node:assert/strict';

import { buttonKey } from '../src/c2/message.ts';
import type { C2Service } from '../src/c2/service.ts';
import type { BotSentRecord } from '../src/c2/ports.ts';
import { setup } from './helpers.ts';

const BODY_A = '张女士您好，您反馈的用餐记录问题我们已经收到，营养师今天下午会电话联系您。';
const BODY_B = '李先生您好，您的方案我们已调整，晚些时候会把新的安排发到群里。';
const BODY_C = '王女士您好，明天的随访时间改到上午十点，您看方便吗？';

function cardTitle(record: BotSentRecord | undefined): string {
  if (!record || record.message.msgtype !== 'template_card') return '';
  return record.message.template_card.main_title.title;
}

function seed(service: C2Service): void {
  service.addAdvisor({ id: 'adv_1', name: '李顾问', chatId: 'chat_adv_1' });
  service.bindGroup({ roomId: 'room_A', name: 'A 群', advisorId: 'adv_1' });
  service.bindGroup({ roomId: 'room_B', name: 'B 群', advisorId: 'adv_1' });
  service.bindGroup({ roomId: 'room_C', name: 'C 群', advisorId: 'adv_1' });

  service.enqueueDraft({
    id: 'D-A',
    advisorId: 'adv_1',
    groupRoomId: 'room_A',
    customerId: 'cust_zhang',
    customerName: '张女士',
    inboundMessageId: 'in_1',
    inboundSummary: '今天的用餐记录好像没同步',
    body: BODY_A,
    ruleIds: ['diet-log-missing'],
  });
  service.enqueueDraft({
    id: 'D-B',
    advisorId: 'adv_1',
    groupRoomId: 'room_B',
    customerId: 'cust_li',
    customerName: '李先生',
    inboundMessageId: 'in_2',
    inboundSummary: '方案什么时候更新',
    body: BODY_B,
  });
  service.enqueueDraft({
    id: 'D-C',
    advisorId: 'adv_1',
    groupRoomId: 'room_C',
    customerId: 'cust_wang',
    customerName: '王女士',
    inboundMessageId: 'in_3',
    inboundSummary: '明天随访能不能改时间',
    body: BODY_C,
  });
}

test('三个群同一个顾问：串行推送、逐条确认、存档校验、错群暂停', async () => {
  const { service, store, bot, archive, clock } = setup({
    verifier: { verifyDelayMs: 30_000 },
  });
  seed(service);

  // 1. 三条草稿同时到达，只推送最早的一条
  assert.equal(service.queueDepth('adv_1'), 3);
  await service.tick();
  assert.equal(bot.cards().length, 1);
  assert.equal(store.getActiveDraft('adv_1'), 'D-A');
  assert.match(cardTitle(bot.cards()[0]), /A 群/);

  // 2. 员工确认后，B 群草稿才出现
  service.handleButtonCallback(buttonKey('D-A', 'sent'));
  assert.equal(store.getDraft('D-A')?.status, 'ACKNOWLEDGED');
  assert.equal(service.queueDepth('adv_1'), 2);

  await service.tick();
  assert.equal(bot.cards().length, 2);
  assert.equal(store.getActiveDraft('adv_1'), 'D-B');
  assert.match(cardTitle(bot.cards()[1]), /B 群/);

  // 3. 存档里在 A 群找到原文 → VERIFIED
  clock.advance(31_000);
  archive.add({
    msgid: 'msg_1',
    roomid: 'room_A',
    from: 'adv_1',
    text: BODY_A,
    msgtime: clock.now(),
  });
  const round = await service.tick();
  assert.equal(store.getDraft('D-A')?.status, 'VERIFIED');
  assert.equal(round.verified.some((v) => v.outcome === 'VERIFIED'), true);

  // 4. B 群草稿确认后，C 群草稿推送
  service.handleButtonCallback(buttonKey('D-B', 'sent'));
  await service.tick();
  assert.equal(store.getActiveDraft('adv_1'), 'D-C');
  assert.match(cardTitle(bot.cards()[2]), /C 群/);

  // 5. B 的正文出现在 C 群 → MISROUTE_ALERT
  clock.advance(31_000);
  archive.add({
    msgid: 'msg_2',
    roomid: 'room_C',
    from: 'adv_1',
    text: BODY_B,
    msgtime: clock.now(),
  });
  await service.tick();

  assert.equal(store.getDraft('D-B')?.status, 'MISROUTE_ALERT');
  assert.equal(store.getDraft('D-B')?.verification?.matchedRoomId, 'room_C');
  assert.equal(store.getAdvisor('adv_1')?.consecutiveMisroutes, 1);
  assert.ok(store.listAlerts().some((a) => a.kind === 'MISROUTE'));

  // 6. C 再次发错群 → 连续两次，顾问被暂停
  service.handleButtonCallback(buttonKey('D-C', 'sent'));
  await service.tick();
  clock.advance(31_000);
  archive.add({
    msgid: 'msg_3',
    roomid: 'room_A',
    from: 'adv_1',
    text: BODY_C,
    msgtime: clock.now(),
  });
  await service.tick();

  assert.equal(store.getDraft('D-C')?.status, 'MISROUTE_ALERT');
  assert.equal(store.getAdvisor('adv_1')?.consecutiveMisroutes, 2);
  assert.equal(store.getAdvisor('adv_1')?.status, 'paused');
  assert.ok(store.listAlerts().some((a) => a.kind === 'ADVISOR_PAUSED'));

  // 7. 暂停后新草稿不再推送
  service.enqueueDraft({
    id: 'D-D',
    advisorId: 'adv_1',
    groupRoomId: 'room_A',
    customerId: 'cust_zhang',
    customerName: '张女士',
    inboundMessageId: 'in_4',
    inboundSummary: '还有一个问题',
    body: '张女士您好，您说的第二个问题我们也一并记录并处理。',
  });
  await service.tick();
  assert.equal(store.getDraft('D-D')?.status, 'QUEUED');
  assert.equal(bot.cards().length, 3);
});

test('一次正确校验会把连续错群计数清零', async () => {
  const { service, store, archive, clock } = setup({
    verifier: { verifyDelayMs: 30_000 },
  });
  seed(service);

  const advisor = store.getAdvisor('adv_1');
  assert.ok(advisor);
  advisor.consecutiveMisroutes = 1;
  store.saveAdvisor(advisor);

  await service.tick();
  service.handleButtonCallback(buttonKey('D-A', 'sent'));

  clock.advance(31_000);
  archive.add({
    msgid: 'msg_ok',
    roomid: 'room_A',
    from: 'adv_1',
    text: BODY_A,
    msgtime: clock.now(),
  });
  await service.tick();

  assert.equal(store.getDraft('D-A')?.status, 'VERIFIED');
  assert.equal(store.getAdvisor('adv_1')?.consecutiveMisroutes, 0);
});

test('员工忘点确认但已发出：宽限期后自动回读并判定', async () => {
  const { service, store, archive, clock } = setup();
  seed(service);

  await service.tick();
  assert.equal(store.getActiveDraft('adv_1'), 'D-A');

  clock.advance(10 * 60_000 + 1_000);
  archive.add({
    msgid: 'msg_auto',
    roomid: 'room_A',
    from: 'adv_1',
    text: BODY_A,
    msgtime: clock.now(),
  });
  await service.tick();

  assert.equal(store.getDraft('D-A')?.status, 'VERIFIED');
  assert.equal(store.getActiveDraft('adv_1'), undefined);
});

test('已确认但存档里一直没有：重试到上限后判 UNVERIFIED 并告警', async () => {
  const { service, store, clock } = setup({
    verifier: {
      verifyDelayMs: 30_000,
      verifyRetryBackoffMs: 60_000,
      maxVerifyAttempts: 3,
    },
  });
  seed(service);

  await service.tick();
  service.handleButtonCallback(buttonKey('D-A', 'sent'));

  clock.advance(31_000);
  await service.tick(); // 第 1 次
  assert.equal(store.getDraft('D-A')?.status, 'ACKNOWLEDGED');

  clock.advance(60_000);
  await service.tick(); // 第 2 次
  assert.equal(store.getDraft('D-A')?.status, 'ACKNOWLEDGED');

  clock.advance(60_000);
  const round = await service.tick(); // 第 3 次 → UNVERIFIED
  assert.equal(store.getDraft('D-A')?.status, 'UNVERIFIED');
  // 回执要靠 draftId 找回草稿；缺了它员工收不到「没找到」的通知
  assert.equal(round.verified.find((v) => v.outcome === 'UNVERIFIED')?.draftId, 'D-A');
  // D-A 已不再占用队列，队首换成 B 群草稿
  assert.equal(store.getActiveDraft('adv_1'), 'D-B');
  assert.ok(store.listAlerts().some((a) => a.kind === 'UNVERIFIED'));
});

test('点「已发送」但内容有改动：由存档判定为 EDIT_SENT', async () => {
  const { service, store, archive, clock } = setup({
    verifier: { verifyDelayMs: 30_000 },
  });
  seed(service);

  await service.tick();
  // 员工只报「已发送」，是否照原文发出由存档回读判定
  service.handleButtonCallback(buttonKey('D-A', 'sent'));

  clock.advance(31_000);
  archive.add({
    msgid: 'msg_edited',
    roomid: 'room_A',
    from: 'adv_1',
    text: BODY_A.replace('今天下午', '今天上午'),
    msgtime: clock.now(),
  });
  await service.tick();

  assert.equal(store.getDraft('D-A')?.status, 'EDIT_SENT');
  assert.equal(store.getDraft('D-A')?.verification?.matchedRoomId, 'room_A');
});

test('重复点击或非 PUSHED 状态确认会报错', async () => {
  const { service } = setup();
  seed(service);

  assert.throws(() => service.acknowledge('D-A', 'sent'), /DRAFT_NOT_PUSHED/);

  await service.tick();
  service.acknowledge('D-A', 'sent');
  assert.throws(() => service.acknowledge('D-A', 'sent'), /ALREADY_ACKNOWLEDGED/);

  assert.throws(() => service.handleButtonCallback('not-a-key'), /INVALID_BUTTON_KEY/);
});

test('已进入终态的草稿被再次点击报 ALREADY_ACKNOWLEDGED（不是 DRAFT_NOT_PUSHED）', async () => {
  const { service, store } = setup();
  seed(service);
  await service.tick();

  const draft = store.getDraft('D-A');
  assert.ok(draft);
  draft.status = 'VERIFIED';
  store.saveDraft(draft);

  assert.throws(
    () => service.handleButtonCallback(buttonKey('D-A', 'sent')),
    /ALREADY_ACKNOWLEDGED D-A status=VERIFIED/,
  );
});

test('审计记录覆盖入队、推送、确认、校验', async () => {
  const { service, store, archive, clock } = setup({
    verifier: { verifyDelayMs: 30_000 },
  });
  seed(service);

  await service.tick();
  service.handleButtonCallback(buttonKey('D-A', 'sent'));
  clock.advance(31_000);
  archive.add({
    msgid: 'msg_audit',
    roomid: 'room_A',
    from: 'adv_1',
    text: BODY_A,
    msgtime: clock.now(),
  });
  await service.tick();

  const actions = store.listAudit().map((e) => `${e.actor}:${e.action}`);
  for (const expected of ['pipeline:enqueue', 'adv_1:push', 'adv_1:ack_sent', 'verifier:verify']) {
    assert.ok(actions.includes(expected), `缺少审计 ${expected}`);
  }
});
