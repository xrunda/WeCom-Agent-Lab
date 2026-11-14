import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, MockBot } from '../src/c2/index.ts';
import { PromiseService } from '../src/c2/promise-service.ts';
import type { PromiseRecord } from '../src/c2/promises.ts';
import { makeDraft } from './helpers.ts';

/** 东八区 2026-11-11（周三）10:00 */
const AT = Date.UTC(2026, 10, 11, 2, 0, 0);

class FakePromiseStore {
  private readonly map = new Map<string, PromiseRecord>();

  listPromises(): PromiseRecord[] {
    return [...this.map.values()];
  }

  getPromise(id: string): PromiseRecord | undefined {
    return this.map.get(id);
  }

  savePromise(record: PromiseRecord): void {
    this.map.set(record.id, { ...record });
  }
}

function setup(chatId: string | null = 'chat_adv_1') {
  const clock = new FakeClock(AT);
  const bot = new MockBot(clock);
  const store = new FakePromiseStore();
  const logs: string[] = [];
  const service = new PromiseService({
    store,
    bot,
    clock,
    chatIdFor: () => chatId ?? undefined,
    logger: (line) => logs.push(line),
  });
  return { clock, bot, store, service, logs };
}

function ingest(service: PromiseService, msgId: string, text = '我明天下午把新的餐单发给您。') {
  return service.ingestText({
    advisorId: 'adv_1',
    roomId: 'wr_1',
    groupName: '减重-张女士',
    customerId: 'wm_1',
    customerName: '张女士',
    text,
    msgId,
    at: AT,
  });
}

test('#160 同一 msgid 重复扫描只入账一次', () => {
  const { service, store } = setup();
  const first = ingest(service, 'msg_1');
  assert.equal(first.length, 1);
  assert.equal(first[0]!.status, 'pending');
  assert.equal(first[0]!.excerpt, '我明天下午把新的餐单发给您');
  assert.equal(first[0]!.dueAt, Date.parse('2026-11-12T10:00:00.000Z'));

  const again = ingest(service, 'msg_1');
  assert.equal(again.length, 0);
  assert.equal(store.listPromises().length, 1);
});

test('#160 已确认发出的草稿按草稿 id + 版本入账，重复确认不重复', () => {
  const { service, store } = setup();
  const draft = makeDraft({
    id: 'D1',
    body: '我明天把餐单发给您。',
    version: 2,
    groupName: '减重-张女士',
  });
  const first = service.ingestDraft(draft);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.sourceMsgId, 'draft:D1:v2');
  assert.equal(service.ingestDraft(draft).length, 0);
  assert.equal(store.listPromises().length, 1);
});

test('#160 到期才提醒，一条承诺只提醒一次；只发顾问 1:1', async () => {
  const { clock, bot, service } = setup();
  const [promise] = ingest(service, 'msg_1');
  assert.ok(promise);

  assert.equal((await service.dueScan()).length, 0);

  clock.advance(32 * 60 * 60_000); // 次日 18:00（东八区）
  const reminded = await service.dueScan();
  assert.equal(reminded.length, 1);
  assert.equal(bot.cards().length, 1);
  const sent = bot.cards()[0]!;
  assert.equal(sent.chatId, 'chat_adv_1');
  const card = sent.message as {
    template_card: {
      main_title: { title: string };
      horizontal_content_list: Array<{ keyname: string; value: string }>;
      button_list: Array<{ text: string; key: string }>;
    };
  };
  assert.match(card.template_card.main_title.title, /承诺到期/);
  assert.match(card.template_card.main_title.title, /减重-张女士/);
  assert.match(card.template_card.horizontal_content_list[0]!.value, /我明天下午把新的餐单发给您/);
  assert.deepEqual(
    card.template_card.button_list.map((item) => item.text),
    ['已处理', '稍后提醒', '这不是承诺'],
  );
  assert.equal(card.template_card.button_list[0]!.key, `promise:${promise.id}:done`);

  // 再次扫描不重复提醒
  assert.equal((await service.dueScan()).length, 0);
  assert.equal(bot.cards().length, 1);
});

test('#160 未绑定 1:1 时不发卡片，保留待提醒状态', async () => {
  const { clock, bot, service } = setup(null);
  ingest(service, 'msg_1');
  clock.advance(32 * 60 * 60_000);
  assert.equal((await service.dueScan()).length, 0);
  assert.equal(bot.cards().length, 0);
});

test('#160 同一顾问同时到期合并为一张卡片，最多 3 条，其余顺延到次日', async () => {
  const { clock, bot, store, service } = setup();
  for (let i = 1; i <= 5; i += 1) ingest(service, `msg_${i}`);

  clock.advance(32 * 60 * 60_000);
  const first = await service.dueScan();
  assert.equal(first.length, 3);
  assert.equal(bot.cards().length, 1);
  const card = bot.cards()[0]!.message as {
    template_card: {
      sub_title_text: string;
      horizontal_content_list: unknown[];
    };
  };
  assert.equal(card.template_card.horizontal_content_list.length, 3);
  assert.match(card.template_card.sub_title_text, /另有 2 条/);

  const overflow = store
    .listPromises()
    .filter((item) => item.remindedAt === undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(overflow.length, 2);
  assert.equal(overflow[0]!.dueAt, Date.parse('2026-11-13T01:00:00.000Z')); // 11-13 09:00 +08

  // 当天不再发第二张
  assert.equal((await service.dueScan()).length, 0);
  assert.equal(bot.cards().length, 1);

  clock.advance(15 * 60 * 60_000); // 11-13 09:00
  const second = await service.dueScan();
  assert.equal(second.length, 2);
  assert.equal(bot.cards().length, 2);
});

test('#160 已处理 / 这不是承诺关闭条目，不再出现在扫描里', async () => {
  const { clock, service, store } = setup();
  const [a] = ingest(service, 'msg_1');
  const [b] = ingest(service, 'msg_2');
  assert.ok(a && b);

  const done = service.handleButtonKey(`promise:${a.id}:done`);
  assert.equal(done?.closed[0]?.status, 'done');
  const dismissed = service.handleButtonKey(`promise:${b.id}:false`);
  assert.equal(dismissed?.closed[0]?.status, 'dismissed');

  clock.advance(32 * 60 * 60_000);
  assert.equal((await service.dueScan()).length, 0);
  assert.equal(service.pending().length, 0);
  assert.equal(store.getPromise(a.id)?.closedAt, AT);
});

test('#160 稍后提醒最多 2 次，每次顺延 1 天', async () => {
  const { clock, bot, service, store } = setup();
  const [promise] = ingest(service, 'msg_1');
  assert.ok(promise);

  clock.advance(32 * 60 * 60_000);
  await service.dueScan();
  const firstSnooze = service.handleButtonKey(`promise:${promise.id}:later`);
  assert.equal(firstSnooze?.snoozed.length, 1);
  assert.equal(store.getPromise(promise.id)?.dueAt, Date.parse('2026-11-13T10:00:00.000Z'));
  assert.equal(store.getPromise(promise.id)?.remindedAt, undefined);
  assert.match(store.getPromise(promise.id)?.dueLabel ?? '', /第 1 次顺延/);

  clock.advance(24 * 60 * 60_000);
  await service.dueScan();
  const secondSnooze = service.handleButtonKey(`promise:${promise.id}:later`);
  assert.equal(secondSnooze?.snoozed.length, 1);

  clock.advance(24 * 60 * 60_000);
  await service.dueScan();
  const third = service.handleButtonKey(`promise:${promise.id}:later`);
  assert.equal(third?.snoozed.length, 0, '第三次顺延不再生效');
  assert.equal(bot.cards().length, 3);
  assert.equal(store.getPromise(promise.id)?.status, 'pending');
});

test('#160 未知按钮或已关闭条目返回空结果，不抛错', () => {
  const { service } = setup();
  assert.equal(service.handleButtonKey('ack:x:sent'), undefined);
  const [promise] = ingest(service, 'msg_1');
  assert.ok(promise);
  service.handleButtonKey(`promise:${promise.id}:done`);
  const again = service.handleButtonKey(`promise:${promise.id}:done`);
  assert.equal(again?.closed.length, 0);
});
