/**
 * 顾问 Agent 待办格式化与企微拆条（#167）。
 * 全部虚构数据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTodoSnapshot,
  formatActiveDraftMeta,
  formatSnapshotLine,
  formatTodoText,
  openDrafts,
  splitForWecom,
} from '../src/p1/advisor/format.ts';

const NOW = Date.UTC(2026, 10, 14, 2); // 10:00 CST

test('buildTodoSnapshot 只保留未完成的草稿', () => {
  const snapshot = buildTodoSnapshot({
    drafts: [
      { id: 'd1', groupName: '群 1', riskLevel: 'low', status: 'PUSHED', since: NOW },
      { id: 'd2', groupName: '群 2', riskLevel: 'low', status: 'VERIFIED', since: NOW },
    ],
    promises: [],
    alerts: [],
    now: NOW,
  });
  assert.equal(snapshot.drafts.length, 1);
  assert.equal(snapshot.drafts[0]!.id, 'd1');
});

test('formatTodoText：计数、最久等待、今日承诺、告警', () => {
  const text = formatTodoText(
    buildTodoSnapshot({
      drafts: [
        { id: 'd1', groupName: '群 1', riskLevel: 'medium', status: 'PUSHED', since: NOW - 2 * 3600_000 },
      ],
      promises: [
        { id: 'prom_1', groupName: '群 1', excerpt: '明天提醒我量血压', dueAt: NOW + 3 * 3600_000, dueLabel: '今天 18:00' },
      ],
      alerts: [{ id: 'a1', title: '员工发言命中红线', at: NOW - 60_000 }],
      pendingReplies: 2,
      now: NOW,
    }),
  );
  assert.match(text, /待处理草稿 1 条（最久 2 小时）/);
  assert.match(text, /今日到期承诺 1 条（最近 今天 18:00）/);
  assert.match(text, /未处理告警 1 条/);
  assert.match(text, /待回复会话 2 个/);
  // 逐条带 id 与摘要，让 Agent 能按 id 处理
  assert.match(text, /草稿 d1 · 群 1 · 待确认 · 中风险/);
  assert.match(text, /承诺 prom_1 · 群 1 · 明天提醒我量血压 · 今天 18:00/);
});

test('formatSnapshotLine：前置上下文的一行计数，无数据时如实说没有', () => {
  const line = formatSnapshotLine(
    buildTodoSnapshot({
      drafts: [{ id: 'd1', groupName: '群 1', riskLevel: 'high', status: 'PUSHED', since: NOW - 3600_000 }],
      promises: [],
      alerts: [],
      now: NOW,
    }),
  );
  assert.match(line, /未完成草稿 1（最久 1 小时）/);
  assert.equal(
    formatSnapshotLine(buildTodoSnapshot({ drafts: [], promises: [], alerts: [], now: NOW })),
    '现在没有待办',
  );
});

test('formatActiveDraftMeta：只放元数据，不带客户正文', () => {
  const meta = formatActiveDraftMeta({
    groupName: '客户-汪女士-20261108',
    riskLevel: 'medium',
    status: 'PUSHED',
    version: 2,
  });
  assert.match(meta!, /第 2 版/);
  assert.match(meta!, /中风险/);
});

test('openDrafts 状态闭集：已确认 / 忽略不算待办', () => {
  const drafts = [
    { id: 'd1', groupName: 'g', riskLevel: 'low' as const, status: 'QUEUED', since: NOW },
    { id: 'd2', groupName: 'g', riskLevel: 'low' as const, status: 'SKIPPED', since: NOW },
  ];
  assert.equal(openDrafts(drafts).length, 1);
});

test('splitForWecom 按字节拆条且不丢字符', () => {
  const long = '第'.repeat(500) + '\n' + '行'.repeat(900);
  const chunks = splitForWecom(long, 2000);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), long);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 2000));
  assert.deepEqual(splitForWecom('短文本', 2000), ['短文本']);
  assert.deepEqual(splitForWecom('', 2000), []);
});
