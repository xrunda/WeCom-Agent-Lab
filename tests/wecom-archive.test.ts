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
    // 既有用例验证的是服务群链路；#31 的默认非服务群行为单独测
    isServiceGroup: () => true,
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

test('日志只含消息元数据，不含正文', async () => {
  const logs: string[] = [];
  const body = '患者说：最近血糖 12.8，晚上睡不着';
  const { adapter } = adapterWith(
    [
      dump(24, [
        record({
          msgid: 'msgid_CUSTOMER_123456',
          action: 'recv',
          from: 'wmCUSTOMER_ABCDEF',
          roomid: 'wrGROUP_ABCDEF123456',
          text: { content: body },
        }),
      ]),
    ],
    { logger: (line: string) => logs.push(line) },
  );

  const messages = await adapter.listInboundMessages({
    roomIds: ['wrGROUP_ABCDEF123456'],
    excludeSender: 'LiGuang',
    since: 0,
    until: 10_000,
  });

  assert.equal(messages[0].text, body);
  const output = logs.join('\n');
  assert.ok(!output.includes(body), output);
  assert.ok(!output.includes('msgid_CUSTOMER_123456'), output);
  assert.ok(!output.includes('wrGROUP_ABCDEF123456'), output);
  assert.match(output, /msgid=…123456/);
  assert.match(output, /room=…123456/);
  assert.match(output, /sender=external/);
});

test('未采纳原因不打印完整 msgid、roomid 和发送者', async () => {
  const logs: string[] = [];
  const { adapter } = adapterWith(
    [
      dump(24, [
        record({
          msgid: 'msgid_SELF_123456',
          action: 'send',
          from: 'LiGuang',
          roomid: 'wrGROUP_ABCDEF123456',
        }),
      ]),
    ],
    { logger: (line: string) => logs.push(line) },
  );

  const messages = await adapter.listInboundMessages({
    roomIds: ['wrGROUP_ABCDEF123456'],
    excludeSender: 'LiGuang',
    since: 0,
    until: 10_000,
  });

  assert.equal(messages.length, 0);
  const output = logs.join('\n');
  assert.ok(!output.includes('msgid_SELF_123456'), output);
  assert.ok(!output.includes('LiGuang'), output);
  assert.match(output, /未采纳 msgid=…123456：发送者是员工本人/);
});

test('默认把群视为非服务群：正文不落缓存，日志只留计数', async () => {
  const logs: string[] = [];
  const body = '这条正文不应该出现在任何存储或日志里';
  const { adapter } = adapterWith(
    [
      dump(24, [
        record({
          msgid: 'msgid_NON_SERVICE_123456',
          action: 'recv',
          from: 'wmCUSTOMER_ABCDEF',
          roomid: 'wrGROUP_ABCDEF123456',
          text: { content: body },
        }),
      ]),
    ],
    {
      isServiceGroup: undefined,
      logger: (line: string) => logs.push(line),
    },
  );

  const inbound = await adapter.listInboundMessages({
    roomIds: ['wrGROUP_ABCDEF123456'],
    excludeSender: 'LiGuang',
    since: 0,
    until: 10_000,
  });
  const sent = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 0, until: 10_000 });

  assert.equal(inbound.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(adapter.listCached()[0]?.text, undefined);

  const output = logs.join('\n');
  assert.ok(!output.includes(body), output);
  assert.ok(!output.includes('msgid_NON_SERVICE_123456'), output);
  assert.match(output, /非服务群 1 条仅计数/);
  assert.match(output, /未采纳 msgid=…123456：非服务群/);
});

test('重启后回读能补到重启前窗口内的发送记录，且不推进主游标', async () => {
  const sent = record({ msgid: 'm_before_restart', msgtime: 1_000 });
  const inbound = record({
    msgid: 'c_before_restart',
    action: 'recv',
    from: 'wmCUSTOMER',
    msgtime: 900,
  });
  const bodies: Record<number, string> = {
    0: dump(10, [inbound, sent]),
    10: dump(20, []),
    20: dump(20, []),
  };
  const calls: string[][] = [];
  const adapter = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    initialSeq: 10, // 模拟重启：持久化的 archive_seq=10
    run: async (args) => {
      calls.push(args);
      return bodies[Number(args[1])] ?? dump(20, []);
    },
  });

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 500, until: 5_000 });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].msgid, 'm_before_restart');
  // 主游标只前进到增量拉取的位置，不能因为补历史而回退
  assert.equal(adapter.getSeq(), 20);
  assert.ok(calls.some((args) => args[1] === '10'));
  assert.ok(calls.some((args) => args[1] === '0'));
  // 历史入站消息不能回到共享缓存，否则重启后 trigger 会重复触发
  assert.ok(adapter.listCached().every((r) => r.msgid !== 'c_before_restart'));
});

test('补拉历史只发生一次，后续回读仍从主游标增量拉取', async () => {
  const sent = record({ msgid: 'm_before_restart', msgtime: 1_000 });
  const calls: string[][] = [];
  let index = 0;
  const outputs = [dump(20, []), dump(10, [sent]), dump(20, []), dump(20, [])];
  const adapter = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    initialSeq: 10,
    run: async (args) => {
      calls.push(args);
      const out = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return out;
    },
  });

  const first = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 500, until: 5_000 });
  assert.equal(first.length, 1);

  calls.length = 0;
  const second = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 500, until: 5_000 });
  assert.equal(second.length, 1);
  // 第二次只从主游标 20 拉增量，不再回退到 0
  assert.ok(calls.every((args) => Number(args[1]) >= 20), JSON.stringify(calls));
});

test('补拉历史有批次上限，历史不可达时不会无限回拉', async () => {
  const calls: string[][] = [];
  const adapter = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    initialSeq: 100,
    batchSize: 2,
    maxBatchesPerPoll: 1,
    historyReplayRecords: 5,
    historyReplayBatches: 2,
    run: async (args) => {
      calls.push(args);
      const seq = Number(args[1]);
      return dump(seq + 1, [
        record({ msgid: `m_${seq}_a`, msgtime: 10_000 }),
        record({ msgid: `m_${seq}_b`, msgtime: 10_000 }),
      ]);
    },
  });

  await adapter.listSentMessages({ fromUser: 'LiGuang', since: 500, until: 20_000 });

  // 1 次增量 + 2 次回退窗口 × 2 批，有界退出
  assert.equal(calls.length, 5);
  assert.equal(adapter.getSeq(), 101);
});

test('补拉失败不丢恢复点，下一次回读会重试', async () => {
  const sent = record({ msgid: 'm_before_restart', msgtime: 1_000 });
  let failReplay = true;
  const adapter = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    initialSeq: 10,
    run: async (args) => {
      const seq = Number(args[1]);
      if (seq === 10) return dump(20, []);
      if (seq === 0) {
        if (failReplay) {
          failReplay = false;
          throw new Error('ARCHIVE_EXEC_FAILED test');
        }
        return dump(10, [sent]);
      }
      return dump(20, []);
    },
  });

  await assert.rejects(
    adapter.listSentMessages({ fromUser: 'LiGuang', since: 500, until: 5_000 }),
    /ARCHIVE_EXEC_FAILED/,
  );

  const messages = await adapter.listSentMessages({ fromUser: 'LiGuang', since: 500, until: 5_000 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].msgid, 'm_before_restart');
});
