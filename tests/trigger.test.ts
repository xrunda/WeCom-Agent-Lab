import test from 'node:test';
import assert from 'node:assert/strict';

import { ArchiveTrigger } from '../src/c2/trigger.ts';
import type { ComposeFn } from '../src/c2/trigger.ts';
import { MemoryStore, MockArchive, FakeClock } from '../src/c2/memory.ts';
import type { CustomerGroup } from '../src/c2/types.ts';

const ADV = 'LiGuang';
const ROOM = 'wrGROUP1';

function seedGroup(store: MemoryStore, overrides: Partial<CustomerGroup> = {}): void {
  store.saveGroup({
    roomId: ROOM,
    name: '存档测试群',
    advisorId: ADV,
    status: 'mapped',
    ...overrides,
  });
}

function echoCompose(): ComposeFn {
  return ({ message }) => ({
    body: `收到：「${message.text}」`,
    inboundSummary: message.text,
  });
}

function build(options: {
  clock?: FakeClock;
  archive?: MockArchive;
  store?: MemoryStore;
  compose?: ComposeFn;
  startedAt?: number;
  logger?: (line: string) => void;
} = {}) {
  const clock = options.clock ?? new FakeClock(20_000);
  const store = options.store ?? new MemoryStore();
  const archive = options.archive ?? new MockArchive();
  const trigger = new ArchiveTrigger({
    archive,
    store,
    clock,
    compose: options.compose ?? echoCompose(),
    config: {
      roomIds: [ROOM],
      excludeSender: ADV,
      startedAt: options.startedAt ?? 10_000,
    },
    logger: options.logger,
  });
  return { clock, store, archive, trigger };
}

test('客户在群里发消息 → 生成一条草稿事件', async () => {
  const { archive, store, trigger } = build();
  seedGroup(store);
  archive.add({
    msgid: 'c1',
    roomid: ROOM,
    from: 'wmCUST_A1B2C3',
    text: '今天晚饭吃什么',
    msgtime: 10_500,
  });

  const events = await trigger.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].message.msgid, 'c1');
  assert.equal(events[0].group.roomId, ROOM);
  assert.match(events[0].draft.body, /今天晚饭吃什么/);
});

test('同一条消息只触发一次', async () => {
  const { archive, store, trigger } = build();
  seedGroup(store);
  archive.add({ msgid: 'c1', roomid: ROOM, from: 'wmCUST', text: '你好', msgtime: 10_500 });

  assert.equal((await trigger.poll()).length, 1);
  assert.equal((await trigger.poll()).length, 0);
});

test('员工自己发的消息不触发（避免把自己的回复当成客户提问）', async () => {
  const { archive, store, trigger } = build();
  seedGroup(store);
  archive.add({ msgid: 'mine', roomid: ROOM, from: ADV, text: '我发的', msgtime: 10_500 });

  assert.equal((await trigger.poll()).length, 0);
});

test('未绑定的群不触发', async () => {
  const { archive, store, trigger } = build();
  // 不 seed 任何群
  archive.add({ msgid: 'c1', roomid: ROOM, from: 'wmCUST', text: '你好', msgtime: 10_500 });

  assert.equal((await trigger.poll()).length, 0);
});

test('启动之前的历史消息不重放', async () => {
  const { archive, store, trigger } = build({ startedAt: 10_000 });
  seedGroup(store);
  archive.add({ msgid: 'old', roomid: ROOM, from: 'wmCUST', text: '历史', msgtime: 9_000 });

  assert.equal((await trigger.poll()).length, 0);
});

test('compose 返回 undefined 时跳过', async () => {
  const { archive, store, trigger } = build({ compose: () => undefined });
  seedGroup(store);
  archive.add({ msgid: 'c1', roomid: ROOM, from: 'wmCUST', text: '你好', msgtime: 10_500 });

  assert.equal((await trigger.poll()).length, 0);
});

test('多条客户消息按 msgtime 升序返回', async () => {
  const { archive, store, trigger } = build();
  seedGroup(store);
  archive.add({ msgid: 'late', roomid: ROOM, from: 'wmB', text: '第二条', msgtime: 11_000 });
  archive.add({ msgid: 'early', roomid: ROOM, from: 'wmA', text: '第一条', msgtime: 10_500 });

  const events = await trigger.poll();

  assert.deepEqual(
    events.map((e) => e.message.msgid),
    ['early', 'late'],
  );
});

test('触发日志只含 msgid 尾号、roomid 尾号与发送者类型，不含正文', async () => {
  const logs: string[] = [];
  const { archive, store, trigger } = build({ logger: (line) => logs.push(line) });
  seedGroup(store);
  const body = '客户说：最近血压 160/100，头很晕';
  archive.add({
    msgid: 'msgid_CUSTOMER_123456',
    roomid: ROOM,
    from: 'wmCUSTOMER_ABCDEF',
    text: body,
    msgtime: 10_500,
  });

  assert.equal((await trigger.poll()).length, 1);

  const output = logs.join('\n');
  assert.ok(!output.includes(body), output);
  assert.ok(!output.includes('msgid_CUSTOMER_123456'), output);
  assert.ok(!output.includes('wmCUSTOMER_ABCDEF'), output);
  assert.ok(!output.includes('存档测试群'), output);
  assert.match(output, /命中客户消息 msgid=…123456 msgtype=text room=…GROUP1 sender=external/);
});
