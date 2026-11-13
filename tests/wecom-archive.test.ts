import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WeComArchiveAdapter,
  isExternalCustomerId,
  type ArchiveRecord,
} from '../src/c2/adapters/wecom-archive.ts';

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

test('#160 补建待回复索引：窗口内的服务群与受服务单聊都返回，含员工发言', async () => {
  const { adapter, calls } = adapterWith(
    [
      dump(120, [
        record({ msgid: 'g1', from: 'wmCUSTOMER', roomid: 'wrGROUP1', msgtime: 1_000 }),
        record({ msgid: 'g2', from: 'LiGuang', roomid: 'wrGROUP1', msgtime: 2_000 }),
        record({
          msgid: 'd1', from: 'wmCust1', roomid: '', tolist: ['LiGuang'], msgtime: 1_500,
        }),
        record({
          msgid: 'd2', from: 'LiGuang', roomid: '', tolist: ['wmCust1'], msgtime: 2_500,
        }),
        // 非服务群、窗口外、AI 助手会话都不进补建
        record({ msgid: 'x1', from: 'wmOther', roomid: 'wrOTHER', msgtime: 1_200 }),
        record({ msgid: 'x2', from: 'wmCUSTOMER', roomid: 'wrGROUP1', msgtime: 99_000 }),
        record({ msgid: 'x3', from: 'LiGuang', roomid: '', tolist: ['aiAssistant1'], msgtime: 1_600 }),
      ]),
    ],
    {
      initialSeq: 100,
      historyReplayRecords: 10,
      isServiceGroup: (roomId: string) => roomId === 'wrGROUP1',
      // 与线上判定一致：员工发出的、或对端是外部客户的单聊才算受服务单聊
      isServedDm: (r: ArchiveRecord) =>
        r.from.startsWith('wm') || (r.tolist ?? []).some((id) => id.startsWith('wm')),
    },
  );

  const records = await adapter.listSidebarHistory({ since: 0, until: 10_000 });

  assert.deepEqual(records.map((r) => r.msgid), ['g1', 'd1', 'g2', 'd2']);
  // 从持久化 seq 回退补拉，主游标不推进、共享缓存不写入
  assert.equal(calls[0][1], '90');
  assert.equal(adapter.getSeq(), 100);
  assert.equal(adapter.listCached().length, 0);
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

// ---- #159 单聊存档接入 ----

/** 与插件注入的 isServedDm 同构：顾问与外部客户之间的单聊 */
function servedDm(record: ArchiveRecord): boolean {
  if (record.roomid !== undefined && record.roomid !== '') return false;
  const to = (record.tolist ?? []).filter((id) => typeof id === 'string' && id !== '');
  const from = typeof record.from === 'string' ? record.from : '';
  if (from === 'LiGuang') return isExternalCustomerId(to[0] ?? '');
  return to.includes('LiGuang') && isExternalCustomerId(from);
}

test('受服务单聊保留正文，AI 助手会话只留元数据', async () => {
  const { adapter } = adapterWith(
    [
      dump(30, [
        record({ msgid: 'd1', roomid: '', from: 'wmCust1', tolist: ['LiGuang'], msgtime: 1000 }),
        record({ msgid: 'd2', roomid: '', from: 'LiGuang', tolist: ['wmCust1'], msgtime: 2000 }),
        record({ msgid: 'd3', roomid: '', from: 'LiGuang', tolist: ['aiAssistant1'], msgtime: 3000 }),
      ]),
    ],
    { isServiceGroup: () => false, isServedDm: servedDm },
  );

  await adapter.pull();
  const cached = adapter.listCached();
  assert.equal(cached.find((r) => r.msgid === 'd1')?.text?.content, '正文');
  assert.equal(cached.find((r) => r.msgid === 'd2')?.text?.content, '正文');
  // 与 AI 助手的单聊不属于客户会话：正文不落缓存（#31）
  assert.equal(cached.find((r) => r.msgid === 'd3')?.text, undefined);
});

test('listDmMessages 按员工配对返回，方向按 from 判定，switch 与杂音跳过', async () => {
  const { adapter } = adapterWith(
    [
      dump(40, [
        record({ msgid: 'd1', roomid: '', from: 'wmCust1', tolist: ['LiGuang'], msgtime: 1000 }),
        record({ msgid: 'd2', roomid: '', from: 'LiGuang', tolist: ['wmCust1'], msgtime: 2000 }),
        // 对端不是员工：与别的同事的单聊
        record({ msgid: 'd3', roomid: '', from: 'wmCust9', tolist: ['Colleague'], msgtime: 3000 }),
        // 员工发出但对端是 AI 助手
        record({ msgid: 'd4', roomid: '', from: 'LiGuang', tolist: ['aiAssistant1'], msgtime: 4000 }),
        // 空接收方
        record({ msgid: 'd5', roomid: '', from: 'LiGuang', tolist: [], msgtime: 5000 }),
        // 会话切换事件：没有 msgtime
        record({ msgid: 'd6', roomid: '', action: 'switch', from: 'LiGuang', tolist: [], time: 6000 } as unknown as ArchiveRecord),
        // 窗口外
        record({ msgid: 'd7', roomid: '', from: 'wmCust1', tolist: ['LiGuang'], msgtime: 99999 }),
      ]),
    ],
    { isServiceGroup: () => false, isServedDm: servedDm },
  );
  await adapter.pull();

  const messages = await adapter.listDmMessages({
    staffUserIds: ['LiGuang'],
    since: 0,
    until: 10000,
    includeMedia: true,
  });

  assert.deepEqual(
    messages.map((m) => m.msgid).sort(),
    ['d1', 'd2'],
  );
  const inbound = messages.find((m) => m.msgid === 'd1');
  assert.equal(inbound?.from, 'wmCust1');
  assert.deepEqual(inbound?.tolist, ['LiGuang']);
  assert.equal(inbound?.roomid, '');
  const outbound = messages.find((m) => m.msgid === 'd2');
  assert.equal(outbound?.from, 'LiGuang');
  assert.deepEqual(outbound?.tolist, ['wmCust1']);
});

test('listDmMessages 按时间窗过滤', async () => {
  const { adapter } = adapterWith(
    [
      dump(20, [
        record({ msgid: 'd1', roomid: '', from: 'wmCust1', tolist: ['LiGuang'], msgtime: 1000 }),
        record({ msgid: 'd2', roomid: '', from: 'wmCust1', tolist: ['LiGuang'], msgtime: 5000 }),
      ]),
    ],
    { isServiceGroup: () => false, isServedDm: servedDm },
  );
  await adapter.pull();

  const messages = await adapter.listDmMessages({
    staffUserIds: ['LiGuang'],
    since: 2000,
    until: 9000,
  });
  assert.deepEqual(messages.map((m) => m.msgid), ['d2']);
});

test('isExternalCustomerId 只认 wm/wo 前缀', () => {
  assert.equal(isExternalCustomerId('wmCust1'), true);
  assert.equal(isExternalCustomerId('woCn3iEQAA'), true);
  assert.equal(isExternalCustomerId('LiGuang'), false);
  assert.equal(isExternalCustomerId('aiAssistant1'), false);
  assert.equal(isExternalCustomerId(''), false);
});
