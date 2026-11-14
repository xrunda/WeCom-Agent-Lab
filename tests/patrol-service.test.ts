import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, MockArchive, MockBot } from '../src/c2/index.ts';
import { PatrolService } from '../plugins/zhiban-wecom/patrol-service.ts';
import type { PatrolConfig, PatrolGroup, PatrolState } from '../plugins/zhiban-wecom/patrol-service.ts';

const DAY = 24 * 60 * 60_000;
/** 东八区 2026-11-11 09:00 */
const NOW = Date.UTC(2026, 10, 11, 1, 0, 0);
const ADVISOR = 'wang.guwen';

class FakeState implements PatrolState {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

function setup(options: {
  groups?: PatrolGroup[];
  config?: PatrolConfig;
  chatId?: string;
  canReadPatient?: boolean;
} = {}) {
  const clock = new FakeClock(NOW);
  const archive = new MockArchive();
  const bot = new MockBot(clock);
  const state = new FakeState();
  const alerts: string[] = [];
  const logs: string[] = [];
  const service = new PatrolService({
    archive,
    bot,
    clock,
    groups: () =>
      options.groups ?? [{ roomId: 'wr_1', name: '减重-张女士', advisorId: 'adv_1' }],
    advisorUserId: ADVISOR,
    advisorChatId: options.chatId ?? 'chat_adv_1',
    advisorId: 'adv_1',
    emitAlert: (alert) => alerts.push(alert.kind),
    state,
    patientNameForRoom: () => '张女士',
    canReadPatient: options.canReadPatient ?? true,
    ...(options.config ? { config: options.config } : {}),
    logger: (line) => logs.push(line),
  });
  return { clock, archive, bot, state, alerts, logs, service };
}

test('#161 沉默客户：每天至多一条汇总，只发顾问 1:1，告警进控制台', async () => {
  const { archive, bot, alerts, service, clock, logs } = setup();
  archive.add({
    msgid: 'm_old',
    roomid: 'wr_1',
    from: 'wm_patient',
    text: '最近有点忙',
    msgtime: NOW - 10 * DAY,
  });

  const signals = await service.run();
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, 'silent');
  assert.equal(signals[0]!.days, 10);
  assert.equal(signals[0]!.customerName, '张女士');
  assert.deepEqual(alerts, ['PATROL_SILENT']);

  const cards = bot.cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.chatId, 'chat_adv_1');
  const card = cards[0]!.message as {
    template_card: {
      main_title: { title: string };
      horizontal_content_list: Array<{ keyname: string; value: string }>;
      button_list: Array<{ text: string; key: string }>;
    };
  };
  assert.match(card.template_card.main_title.title, /今日巡检/);
  assert.equal(card.template_card.horizontal_content_list[0]!.keyname, '减重-张女士');
  assert.match(card.template_card.horizontal_content_list[0]!.value, /沉默 10 天/);
  assert.deepEqual(
    card.template_card.button_list.map((item) => item.text),
    ['查看', '今天不看'],
  );
  // 卡片不含客户原文
  assert.equal(JSON.stringify(card).includes('最近有点忙'), false);
  // 日志不含原文
  assert.equal(logs.some((line) => line.includes('最近有点忙')), false);

  // 同一天再跑不再发送
  assert.deepEqual(await service.run(), []);
  assert.equal(bot.cards().length, 1);

  // 次日仍在 14 天去重窗口内 → 不再提醒
  clock.advance(DAY);
  assert.deepEqual(await service.run(), []);
  assert.equal(bot.cards().length, 1);
});

test('#161 投诉信号：只记命中词，卡片与日志都不带原文', async () => {
  const { archive, bot, alerts, service, logs } = setup();
  archive.add({
    msgid: 'm_now',
    roomid: 'wr_1',
    from: 'wm_patient',
    text: '你们没人管，我要投诉退款',
    msgtime: NOW - 60 * 60_000,
  });

  await service.run();
  assert.deepEqual(alerts, ['PATROL_COMPLAINT']);
  const card = bot.cards()[0]!.message as {
    template_card: { horizontal_content_list: Array<{ value: string }> };
  };
  assert.match(card.template_card.horizontal_content_list[0]!.value, /投诉\/风险信号/);
  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes('没人管'), false);
  assert.equal(serialized.includes('退款'), false);
  const complaintLog = logs.find((line) => line.includes('巡检信号 complaint')) ?? '';
  assert.match(complaintLog, /keywords=3/);
  assert.equal(complaintLog.includes('没人管'), false);
});

test('#161 顾问近期在群里说过话不算沉默；别的顾问的群不扫', async () => {
  const { archive, bot, service } = setup({
    groups: [
      { roomId: 'wr_1', name: '减重-张女士', advisorId: 'adv_1' },
      { roomId: 'wr_9', name: '别人的群', advisorId: 'adv_9' },
    ],
  });
  archive.add({
    msgid: 'm_old',
    roomid: 'wr_1',
    from: 'wm_patient',
    text: '好的',
    msgtime: NOW - 10 * DAY,
  });
  archive.add({
    msgid: 'm_adv',
    roomid: 'wr_1',
    from: ADVISOR,
    text: '明天再跟进',
    msgtime: NOW - 2 * DAY,
  });
  archive.add({
    msgid: 'm_other',
    roomid: 'wr_9',
    from: 'wm_other',
    text: '我要投诉',
    msgtime: NOW - 60 * 60_000,
  });

  assert.deepEqual(await service.run(), []);
  assert.equal(bot.cards().length, 0);
});

test('#161 没有信号当天不发；08:30 之前不扫描', async () => {
  const early = setup();
  early.clock.advance(-31 * 60_000); // 08:29 之前
  assert.deepEqual(await early.service.run(), []);

  const quiet = setup();
  quiet.archive.add({
    msgid: 'm_adv',
    roomid: 'wr_1',
    from: ADVISOR,
    text: '今天的安排',
    msgtime: NOW - 2 * DAY,
  });
  assert.deepEqual(await quiet.service.run(), []);
  assert.equal(quiet.bot.cards().length, 0);
  assert.deepEqual(quiet.alerts, []);
});

test('#161 「今天不看」只抑制推送，告警仍进控制台', async () => {
  const { archive, bot, alerts, service, state } = setup();
  archive.add({
    msgid: 'm_old',
    roomid: 'wr_1',
    from: 'wm_patient',
    text: '最近有点忙',
    msgtime: NOW - 10 * DAY,
  });
  state.set('patrol_state', { mutedDay: '2026-11-11', recent: [] });

  await service.run();
  assert.deepEqual(alerts, ['PATROL_SILENT']);
  assert.equal(bot.cards().length, 0);
});

test('#161 未绑定 1:1 时不发卡片', async () => {
  const { archive, bot, service } = setup({ chatId: '' });
  archive.add({
    msgid: 'm_old',
    roomid: 'wr_1',
    from: 'wm_patient',
    text: '最近有点忙',
    msgtime: NOW - 10 * DAY,
  });
  await service.run();
  assert.equal(bot.cards().length, 0);
});

test('#161 无 patient.read 时不带客户名', async () => {
  const { archive, service } = setup({ canReadPatient: false });
  archive.add({
    msgid: 'm_old',
    roomid: 'wr_1',
    from: 'wm_patient',
    text: '最近有点忙',
    msgtime: NOW - 10 * DAY,
  });
  const [signal] = await service.run();
  assert.ok(signal);
  assert.equal(signal.customerName, undefined);
});

test('#161 按钮：本人「今天不看」写入当天抑制；别人的按钮无效', async () => {
  const { service, state, clock } = setup();
  assert.equal(service.handleButtonKey('patrol:adv_9:mute'), undefined);
  assert.equal(state.get('patrol_state'), undefined);

  assert.equal(service.handleButtonKey('patrol:adv_1:mute'), 'mute');
  assert.deepEqual(state.get('patrol_state'), { mutedDay: '2026-11-11', recent: [] });
  assert.equal(service.handleButtonKey('patrol:adv_1:show'), 'show');

  // 次日按钮不再带上昨天的抑制
  clock.advance(DAY);
  assert.equal(service.handleButtonKey('patrol:adv_1:mute'), 'mute');
  assert.deepEqual(state.get('patrol_state'), { recent: [], mutedDay: '2026-11-12' });
});
