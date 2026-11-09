import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUTTON_ACTIONS,
  buildBody,
  buildCard,
  buildDraftMessages,
  buttonKey,
  parseButtonKey,
} from '../src/c2/message.ts';
import { makeDraft } from './helpers.ts';

test('按钮 key 可以往返解析', () => {
  for (const action of BUTTON_ACTIONS) {
    const key = buttonKey('draft_7', action);
    assert.deepEqual(parseButtonKey(key), { draftId: 'draft_7', action });
  }
});

test('非法按钮 key 返回 null', () => {
  for (const key of ['', 'ack', 'ack:d1', 'ack:d1:unknown', 'other:d1:sent', 'ack:a:b:sent']) {
    assert.equal(parseButtonKey(key), null, key);
  }
});

test('卡片带群名、客户名、摘要和三个按钮', () => {
  const draft = makeDraft({
    id: 'draft_A',
    groupName: 'A 群 · 张女士',
    customerName: '张女士',
    inboundSummary: '今天的用餐记录没同步',
    ruleIds: ['rule_1', 'rule_2'],
    riskLevel: 'high',
    body: '这段正文不应该出现在卡片里',
  });
  const card = buildCard(draft, 3);

  assert.equal(card.msgtype, 'template_card');
  assert.equal(card.template_card.task_id.length > 0, true);
  assert.equal(card.template_card.task_id.length <= 32, true);
  assert.match(card.template_card.main_title.title, /A 群 · 张女士/);
  assert.match(card.template_card.main_title.title, /张女士/);
  assert.equal(card.template_card.main_title.desc, '后面还有 2 条');
  assert.match(card.template_card.sub_title_text ?? '', /用餐记录/);
  assert.deepEqual(
    card.template_card.button_list.map((b) => b.key),
    [buttonKey('draft_A', 'sent'), buttonKey('draft_A', 'skipped')],
  );
  assert.deepEqual(
    card.template_card.horizontal_content_list?.map((x) => x.value),
    ['张女士', 'rule_1、rule_2', '高'],
  );
});

test('标题只放群名，客户名放到「客户」一行，避免标题被截断', () => {
  const draft = makeDraft({ groupName: '客户-汪女士-20261108', customerName: '外部客户 9NfOsA' });
  const card = buildCard(draft, 1);
  assert.equal(card.template_card.main_title.title, '待回复 · 客户-汪女士-20261108');
  assert.deepEqual(card.template_card.horizontal_content_list?.[0], {
    keyname: '客户',
    value: '外部客户 9NfOsA',
  });
});

test('客户行带上最后发言时间，按东八区显示', () => {
  // 2026-11-08T14:26:00Z = 北京时间 22:26
  const draft = makeDraft({ customerName: '外部客户 9NfOsA', lastInboundAt: Date.UTC(2026, 10, 8, 14, 26) });
  const list = buildCard(draft, 1).template_card.horizontal_content_list ?? [];
  assert.deepEqual(list[0], { keyname: '客户', value: '外部客户 9NfOsA · 22:26' });
});

test('有群成员时卡片多一行「群成员」', () => {
  const draft = makeDraft({ groupName: '客户-汪女士', groupMembers: ['汪星', '外部客户 9NfOsA'] });
  const list = buildCard(draft, 1).template_card.horizontal_content_list ?? [];
  assert.deepEqual(list[1], { keyname: '群成员', value: '汪星、外部客户 9NfOsA' });
});

test('群名本身就是成员拼接时，不再重复列一遍成员', () => {
  const draft = makeDraft({
    groupName: '汪星、外部客户 9NfOsA',
    groupNameSource: 'members',
    groupMembers: ['汪星', '外部客户 9NfOsA'],
  });
  const list = buildCard(draft, 1).template_card.horizontal_content_list ?? [];
  assert.equal(
    list.some((item) => item.keyname === '群成员'),
    false,
  );
});

test('没有群成员时不显示空行', () => {
  const list = buildCard(makeDraft(), 1).template_card.horizontal_content_list ?? [];
  assert.equal(
    list.some((item) => item.keyname === '群成员'),
    false,
  );
});

test('卡片绝不包含正文，避免复制卡片时把上下文带走', () => {
  const draft = makeDraft({ body: '这是一段绝对不应该出现在卡片中的正文' });
  const serialized = JSON.stringify(buildCard(draft, 1));
  assert.equal(serialized.includes(draft.body), false);
});

test('队列只有一条时提示语正确', () => {
  const card = buildCard(makeDraft(), 1);
  assert.equal(card.template_card.main_title.desc, '当前仅此一条');
});

test('正文气泡只含正文', () => {
  const draft = makeDraft({ body: '张女士您好，回复正文。' });
  assert.deepEqual(buildBody(draft), {
    msgtype: 'text',
    text: { content: '张女士您好，回复正文。' },
  });
});

test('buildDraftMessages 同时给出卡片和正文，顺序为卡片在前', () => {
  const draft = makeDraft();
  const { card, body } = buildDraftMessages(draft, 2);
  assert.equal(card.msgtype, 'template_card');
  assert.equal(body.msgtype, 'text');
  assert.equal(body.text.content, draft.body);
});
