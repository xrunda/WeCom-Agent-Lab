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
    name: '李广',
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
    name: '李广',
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
