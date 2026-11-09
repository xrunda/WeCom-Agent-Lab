import {
  C2Service,
  FakeClock,
  MemoryStore,
  MockArchive,
  MockBot,
  buttonKey,
} from './index.ts';

const out = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const clockLabel = (t: number): string => new Date(t).toISOString().slice(11, 19);
const title = (s: string): void => out(`\n=== ${s} ===`);

async function main(): Promise<void> {
  const clock = new FakeClock(Date.parse('2026-01-05T09:00:00Z'));
  const store = new MemoryStore();
  const bot = new MockBot(clock);
  const archive = new MockArchive();

  const service = new C2Service({
    store,
    bot,
    archive,
    clock,
    config: { verifier: { verifyDelayMs: 30_000 } },
  });

  service.addAdvisor({ id: 'adv_li', name: '李顾问', chatId: 'chat_li_bot' });
  service.bindGroup({ roomId: 'room_A', name: 'A 群', advisorId: 'adv_li' });
  service.bindGroup({ roomId: 'room_B', name: 'B 群', advisorId: 'adv_li' });
  service.bindGroup({ roomId: 'room_C', name: 'C 群', advisorId: 'adv_li' });

  const bodyA = '张女士您好，您反馈的用餐记录问题我们已经收到，营养师今天下午会电话联系您。';
  const bodyB = '李先生您好，您的方案我们已调整，晚些时候会把新的安排发到群里。';
  const bodyC = '王女士您好，明天的随访时间改到上午十点，您看方便吗？';

  service.enqueueDraft({
    id: 'D-A',
    advisorId: 'adv_li',
    groupRoomId: 'room_A',
    customerId: 'cust_zhang',
    customerName: '张女士',
    inboundMessageId: 'in_1',
    inboundSummary: '今天的用餐记录好像没同步',
    body: bodyA,
    ruleIds: ['diet-log-missing'],
  });
  service.enqueueDraft({
    id: 'D-B',
    advisorId: 'adv_li',
    groupRoomId: 'room_B',
    customerId: 'cust_li',
    customerName: '李先生',
    inboundMessageId: 'in_2',
    inboundSummary: '方案什么时候更新',
    body: bodyB,
  });
  service.enqueueDraft({
    id: 'D-C',
    advisorId: 'adv_li',
    groupRoomId: 'room_C',
    customerId: 'cust_wang',
    customerName: '王女士',
    inboundMessageId: 'in_3',
    inboundSummary: '明天随访能不能改时间',
    body: bodyC,
  });

  title('1. 三条草稿同时到达，串行推送');
  out(`队列深度：${service.queueDepth('adv_li')}`);
  await service.tick();
  out(`推送后机器人收到的卡片数：${bot.cards().length}`);
  out(`推送后机器人收到的正文数：${bot.texts().length}`);
  out(`队列深度：${service.queueDepth('adv_li')}`);
  out(`当前活跃草稿：${store.getActiveDraft('adv_li')}`);
  out('\n卡片内容：');
  out(JSON.stringify(bot.cards()[0]?.message, null, 2));
  out(`\n正文气泡：${JSON.stringify(bot.texts()[0]?.message)}`);
  out(`\n卡片里是否包含正文：${JSON.stringify(bot.cards()[0]?.message).includes(bodyA)}`);

  title('2. 员工点"已发送"，下一条才会推送');
  service.handleButtonCallback(buttonKey('D-A', 'sent'));
  out(`D-A 状态：${store.getDraft('D-A')?.status}`);
  await service.tick();
  out(`活跃草稿：${store.getActiveDraft('adv_li')}`);
  const secondCard = bot.cards()[1]?.message;
  const secondTitle =
    secondCard?.msgtype === 'template_card' ? secondCard.template_card.main_title.title : '-';
  out(`卡片标题：${secondTitle}`);
  out(`机器人共收到卡片：${bot.cards().length}`);

  title('3. 会话存档回读到正确群，判定 VERIFIED');
  archive.add({
    msgid: 'msg_1',
    roomid: 'room_A',
    from: 'adv_li',
    text: bodyA,
    msgtime: clock.now() + 10_000,
  });
  clock.advance(31_000);
  const verified = await service.tick();
  out(`本轮校验结果：${verified.verified.map((v) => `${v.outcome}@${v.matchedRoomId}`).join(', ') || '无'}`);
  out(`D-A 状态：${store.getDraft('D-A')?.status}`);

  title('4. 员工把 B 群的回复发到了 C 群，触发错群告警');
  service.handleButtonCallback(buttonKey('D-B', 'sent'));
  await service.tick();
  out(`活跃草稿：${store.getActiveDraft('adv_li')}（C 群草稿）`);
  archive.add({
    msgid: 'msg_2',
    roomid: 'room_C',
    from: 'adv_li',
    text: bodyB,
    msgtime: clock.now() + 10_000,
  });
  clock.advance(31_000);
  const misroute = await service.tick();
  out(`本轮校验结果：${misroute.verified.map((v) => `${v.outcome}@${v.matchedRoomId}`).join(', ') || '无'}`);
  out(`D-B 状态：${store.getDraft('D-B')?.status}`);
  out(`李顾问连续错群次数：${store.getAdvisor('adv_li')?.consecutiveMisroutes}`);

  title('5. 再错一次，自动暂停该顾问');
  service.handleButtonCallback(buttonKey('D-C', 'sent'));
  await service.tick();
  archive.add({
    msgid: 'msg_3',
    roomid: 'room_A',
    from: 'adv_li',
    text: bodyC,
    msgtime: clock.now() + 10_000,
  });
  clock.advance(31_000);
  await service.tick();
  out(`李顾问状态：${store.getAdvisor('adv_li')?.status}`);

  service.enqueueDraft({
    id: 'D-D',
    advisorId: 'adv_li',
    groupRoomId: 'room_A',
    customerId: 'cust_zhang',
    customerName: '张女士',
    inboundMessageId: 'in_4',
    inboundSummary: '还有一个问题',
    body: '张女士您好，您说的第二个问题我们也一并记录并处理。',
  });
  await service.tick();
  out(`暂停后再入队 D-D，是否推送：${store.getDraft('D-D')?.status === 'PUSHED'}`);

  title('告警记录');
  for (const alert of store.listAlerts()) {
    out(`[${clockLabel(alert.at)}] ${alert.kind} - ${alert.message}`);
  }

  title('审计记录（最近 10 条）');
  for (const event of store.listAudit().slice(-10)) {
    out(`[${clockLabel(event.at)}] ${event.actor} ${event.action} ${event.target} -> ${event.result}`);
  }
}

await main();
