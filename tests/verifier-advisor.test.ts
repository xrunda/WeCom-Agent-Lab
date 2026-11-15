import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, MemoryStore, MockArchive, Verifier } from '../src/c2/index.ts';

import { makeDraft } from './helpers.ts';

test('回读匹配使用顾问企微 userid，而不是内部 advisorId', async () => {
  // P1 的 advisorId 是内部 id（adv_liguang），存档里的发送者是企微 userid
  // （LiGuang）；回读必须按 chatId 过滤，否则永远匹配不到员工发出的消息。
  const clock = new FakeClock(1_700_000_000_000);
  const store = new MemoryStore();
  const archive = new MockArchive();

  store.saveAdvisor({
    id: 'adv_1',
    name: '李光',
    chatId: 'LiGuang',
    status: 'active',
    consecutiveMisroutes: 0,
  });

  const now = clock.now();
  const draft = makeDraft({
    advisorId: 'adv_1',
    status: 'ACKNOWLEDGED',
    ackAt: now,
    nextVerifyAt: now,
  });
  store.saveDraft(draft);

  archive.add({
    msgid: 'm1',
    roomid: draft.groupRoomId,
    from: 'LiGuang',
    text: draft.body,
    msgtime: now,
  });

  const verifier = new Verifier({ store, archive, clock });
  const results = await verifier.runDue();

  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'VERIFIED');
  assert.equal(store.getDraft(draft.id)?.status, 'VERIFIED');
});

test('顾问没有 chatId 时回退到 advisorId', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new MemoryStore();
  const archive = new MockArchive();

  store.saveAdvisor({
    id: 'adv_1',
    name: '李光',
    status: 'active',
    consecutiveMisroutes: 0,
  });

  const now = clock.now();
  const draft = makeDraft({
    advisorId: 'adv_1',
    status: 'ACKNOWLEDGED',
    ackAt: now,
    nextVerifyAt: now,
  });
  store.saveDraft(draft);

  archive.add({
    msgid: 'm1',
    roomid: draft.groupRoomId,
    from: 'adv_1',
    text: draft.body,
    msgtime: now,
  });

  const verifier = new Verifier({ store, archive, clock });
  const results = await verifier.runDue();

  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'VERIFIED');
});

test('存档已确认顾问在本群发言但正文不符：记改稿后发送，不再判未核验', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new MemoryStore();
  const archive = new MockArchive();

  store.saveAdvisor({
    id: 'adv_1',
    name: '李光',
    chatId: 'LiGuang',
    status: 'active',
    consecutiveMisroutes: 0,
  });

  const now = clock.now();
  const draft = makeDraft({
    advisorId: 'adv_1',
    status: 'ACKNOWLEDGED',
    ackAt: now,
    ackSource: 'archive',
    nextVerifyAt: now,
  });
  store.saveDraft(draft);

  // 顾问用自己的话回复：送达是确凿的，只是没用草稿原文
  archive.add({
    msgid: 'm_own_words',
    roomid: draft.groupRoomId,
    from: 'LiGuang',
    text: '好的，三个问题我一起回复你，稍等。',
    msgtime: now,
  });

  const verifier = new Verifier({ store, archive, clock });
  const results = await verifier.runDue();

  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'EDIT_SENT');
  assert.equal(results[0].matchedMsgId, 'm_own_words');
  assert.ok((results[0].similarity ?? 1) < 0.9);
  assert.equal(store.getDraft(draft.id)?.status, 'EDIT_SENT');
  assert.equal(store.listAlerts().some((alert) => alert.kind === 'UNVERIFIED'), false);
});
