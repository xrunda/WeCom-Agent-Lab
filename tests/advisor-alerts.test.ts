/**
 * 顾问待办「未处理告警」映射（#167）：以控制台告警为准，只看本人 redline + open。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openRedlineAlertsFor } from '../src/p1/advisor/alerts.ts';

const NOW = 1_700_000_000_000;

test('只保留本人名下、redline、open、非沙盒的告警', () => {
  const items = [
    { id: 'a1', kind: 'redline', status: 'open', title: '员工发言命中红线', advisorId: 'adv_1', createdAt: NOW, severity: 'warning' },
    // 已处理：控制台点过处理，guard 里仍可能是 open，但这里必须排除
    { id: 'a2', kind: 'redline', status: 'resolved', title: '已处理的红线', advisorId: 'adv_1', createdAt: NOW - 1 },
    // 别人的
    { id: 'a3', kind: 'redline', status: 'open', title: '别人的红线', advisorId: 'adv_2', createdAt: NOW - 2 },
    // 其他类型不在告警页口径内
    { id: 'a4', kind: 'escalate', status: 'open', title: '已升级人工', advisorId: 'adv_1', createdAt: NOW - 3 },
    // 沙盒
    { id: 'a5', kind: 'redline', status: 'open', title: '沙盒告警', advisorId: 'adv_1', createdAt: NOW - 4, sandbox: true },
  ];
  const result = openRedlineAlertsFor(items, 'adv_1');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, 'a1');
  assert.equal(result[0]!.severity, 'warning');
});

test('按时间倒序，最近一条排前面', () => {
  const items = [
    { id: 'old', kind: 'redline', status: 'open', title: '旧', advisorId: 'adv_1', createdAt: NOW - 1000 },
    { id: 'new', kind: 'redline', status: 'open', title: '新', advisorId: 'adv_1', createdAt: NOW },
  ];
  assert.deepEqual(
    openRedlineAlertsFor(items, 'adv_1').map((item) => item.id),
    ['new', 'old'],
  );
});
