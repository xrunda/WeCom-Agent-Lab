import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diceCoefficient,
  matchSentMessage,
  normalizeText,
} from '../src/c2/matcher.ts';
import type { SentMessage } from '../src/c2/types.ts';

const NOW = 1_700_000_000_000;

const longBody = '您好，关于您今天反馈的问题，我们已经记录并会尽快安排同事跟进处理。';

function msg(overrides: Partial<SentMessage> = {}): SentMessage {
  return {
    msgid: 'm1',
    roomid: 'room_A',
    from: 'adv_1',
    text: longBody,
    msgtime: NOW,
    ...overrides,
  };
}

test('normalizeText 统一全半角、大小写并去掉标点空白', () => {
  assert.equal(normalizeText('ＡＢＣ， 你好！'), 'abc你好');
  assert.equal(normalizeText('a-b_c d'), 'abcd');
});

test('diceCoefficient 的基本性质', () => {
  assert.equal(diceCoefficient('今天吃什么', '今天吃什么'), 1);
  assert.equal(diceCoefficient('完全不同的内容', '另外一段文字'), 0);
  assert.ok(diceCoefficient('今天吃什么好呢', '今天吃什么') > 0.5);
});

test('精确匹配且群正确 → VERIFIED', () => {
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_A',
    messages: [msg()],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'VERIFIED');
  assert.equal(res.matchedRoomId, 'room_A');
  assert.equal(res.similarity, 1);
});

test('精确匹配但在别的群 → MISROUTE_ALERT', () => {
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_B',
    messages: [msg({ roomid: 'room_A' })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'MISROUTE_ALERT');
  assert.equal(res.matchedRoomId, 'room_A');
});

test('标点空白差异不影响精确匹配', () => {
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_A',
    messages: [msg({ text: ` ${longBody.replaceAll('，', ',')} ` })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'VERIFIED');
});

test('同一群内做了轻微编辑 → EDIT_SENT', () => {
  const edited = longBody.replace('尽快', '尽早');
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_A',
    messages: [msg({ text: edited })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'EDIT_SENT');
  assert.ok((res.similarity ?? 0) >= 0.9 && (res.similarity ?? 0) < 1);
});

test('轻微编辑但发到了别的群 → MISROUTE_ALERT', () => {
  const edited = longBody.replace('尽快', '尽早');
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_B',
    messages: [msg({ text: edited, roomid: 'room_C' })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'MISROUTE_ALERT');
  assert.equal(res.matchedRoomId, 'room_C');
});

test('正文过短时只接受精确匹配，不做模糊判断', () => {
  const res = matchSentMessage({
    body: '好的',
    expectedRoomId: 'room_A',
    messages: [msg({ text: '好的呢' })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'UNVERIFIED');
});

test('完全没有匹配 → UNVERIFIED', () => {
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_A',
    messages: [msg({ text: '这是一条完全无关的消息内容，长度也不短。' })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'UNVERIFIED');
});

test('空正文 → UNVERIFIED', () => {
  const res = matchSentMessage({
    body: '   ',
    expectedRoomId: 'room_A',
    messages: [msg()],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'UNVERIFIED');
});

test('多条候选中优先命中目标群', () => {
  const res = matchSentMessage({
    body: longBody,
    expectedRoomId: 'room_B',
    messages: [msg({ msgid: 'wrong', roomid: 'room_A' }), msg({ msgid: 'right', roomid: 'room_B' })],
    checkedAt: NOW,
  });
  assert.equal(res.outcome, 'VERIFIED');
  assert.equal(res.matchedMsgId, 'right');
});
