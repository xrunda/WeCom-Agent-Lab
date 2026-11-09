import test from 'node:test';
import assert from 'node:assert/strict';

import { WeComArchiveAdapter, type ArchiveRecord } from '../src/c2/adapters/wecom-archive.ts';

function record(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    msgid: 'm1',
    action: 'send',
    from: 'LiGuang',
    tolist: ['joe'],
    roomid: 'wrGROUP1',
    msgtime: 1000,
    msgtype: 'text',
    text: { content: '正文' },
    ...overrides,
  };
}

function adapterWith(outputs: string[], config: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  let index = 0;
  const adapter = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    run: async (args) => {
      calls.push(args);
      const out = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return out;
    },
    ...config,
  });
  return { adapter, calls };
}

function dump(nextSeq: number, messages: ArchiveRecord[]): string {
  return JSON.stringify({ nextSeq, count: messages.length, messages });
}

test('只返回员工发出（action=send）的文字消息', async () => {
  const { adapter } = adapterWith([
    dump(21, [
      record({ msgid: 'm1', msgtime: 1000 }),
      record({ msgid: 'm2', action: 'recv' }),
      record({ msgid: 'm3', from: 'Other' }),
      record({ msgid: 'm4', msgtype: 'image', text: undefined }),
    ]),
  ]);

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 5000 });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].msgid, 'm1');
  assert.equal(messages[0].text, '正文');
  assert.equal(messages[0].roomid, 'wrGROUP1');
});

test('按时间窗过滤（msgtime 毫秒）', async () => {
  const { adapter } = adapterWith([
    dump(23, [
      record({ msgid: 'm1', msgtime: 1_000 }),
      record({ msgid: 'm2', msgtime: 5_000 }),
      record({ msgid: 'm3', msgtime: 9_000 }),
    ]),
  ]);

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 2_000, until: 6_000 });

  assert.deepEqual(
    messages.map((m) => m.msgid),
    ['m2'],
  );
});

test('seq 游标推进，第二次拉取从新起点开始', async () => {
  const { adapter, calls } = adapterWith([dump(21, [record({ msgid: 'm1' })])]);

  await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });
  assert.equal(calls[0][1], '0');

  await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });
  assert.equal(calls[1][1], '21');
  assert.equal(adapter.getSeq(), 21);
});

test('同一 msgid 重复出现只保留一条', async () => {
  const { adapter } = adapterWith([
    dump(21, [record({ msgid: 'm1' })]),
    dump(21, [record({ msgid: 'm1' })]),
  ]);

  const first = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });
  const second = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(adapter.listCached().length, 1);
});

test('拉满一批时继续拉下一批，直到不足一批', async () => {
  const batch = Array.from({ length: 2 }, (_, i) => record({ msgid: `m${i}`, msgtime: 1000 + i }));
  const { adapter, calls } = adapterWith(
    [dump(11, batch), dump(20, [record({ msgid: 'm9', msgtime: 2000 })])],
    { batchSize: 2 },
  );

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });

  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], '11');
  assert.equal(messages.length, 3);
});

test('没有新消息时只拉一次', async () => {
  const { adapter, calls } = adapterWith([dump(21, [])]);

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });

  assert.equal(calls.length, 1);
  assert.equal(messages.length, 0);
});

test('输出不是合法 JSON 时抛 ARCHIVE_BAD_OUTPUT', async () => {
  const { adapter } = adapterWith(['GetChatData 拉取结果 ...']);

  await assert.rejects(
    adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 }),
    /ARCHIVE_BAD_OUTPUT/,
  );
});

test('listInboundMessages 只取指定群里、非员工本人发的文字消息', async () => {
  const { adapter } = adapterWith([
    dump(24, [
      record({ msgid: 'c1', action: 'recv', from: 'wmCUST1', roomid: 'wrGROUP1', msgtime: 1_000 }),
      record({ msgid: 'self', action: 'send', from: 'LiGuang', roomid: 'wrGROUP1', msgtime: 1_000 }),
      record({ msgid: 'other', action: 'recv', from: 'wmCUST2', roomid: 'wrOTHER', msgtime: 1_000 }),
      record({ msgid: 'solo', action: 'recv', from: 'wmCUST1', roomid: '', msgtime: 1_000 }),
      record({ msgid: 'img', action: 'recv', from: 'wmCUST1', roomid: 'wrGROUP1', msgtime: 1_000, msgtype: 'image', text: undefined }),
    ]),
  ]);

  const messages = await adapter.listInboundMessages({
    roomIds: ['wrGROUP1'],
    excludeSender: 'LiGuang',
    since: 0,
    until: 10_000,
  });

  assert.deepEqual(
    messages.map((m) => m.msgid),
    ['c1'],
  );
  assert.equal(messages[0].from, 'wmCUST1');
  assert.equal(messages[0].action, 'recv');
  assert.equal(messages[0].text, '正文');
});

test('listInboundMessages 按 msgtime 时间窗过滤', async () => {
  const { adapter } = adapterWith([
    dump(24, [
      record({ msgid: 'old', action: 'recv', from: 'wmCUST1', msgtime: 1_000 }),
      record({ msgid: 'hit', action: 'recv', from: 'wmCUST1', msgtime: 5_000 }),
      record({ msgid: 'new', action: 'recv', from: 'wmCUST1', msgtime: 9_000 }),
    ]),
  ]);

  const messages = await adapter.listInboundMessages({
    roomIds: ['wrGROUP1'],
    excludeSender: 'LiGuang',
    since: 2_000,
    until: 6_000,
  });

  assert.deepEqual(
    messages.map((m) => m.msgid),
    ['hit'],
  );
});

test('群消息保留 roomid，单聊 roomid 为空串', async () => {
  const { adapter } = adapterWith([
    dump(22, [
      record({ msgid: 'g1', roomid: 'wrGROUP1' }),
      record({ msgid: 's1', roomid: '', tolist: ['joe'] }),
    ]),
  ]);

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });

  assert.equal(messages.find((m) => m.msgid === 'g1')?.roomid, 'wrGROUP1');
  assert.equal(messages.find((m) => m.msgid === 's1')?.roomid, '');
});
