import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SILENT_DAYS,
  buildPatrolDigest,
  isDuplicateSignal,
  isSilent,
  matchComplaints,
  rankSignals,
} from '../src/c2/patrol.ts';
import type { PatrolSignal } from '../src/c2/patrol.ts';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 11, 1, 0, 0); // 11-11 09:00 +08

function signal(overrides: Partial<PatrolSignal> = {}): PatrolSignal {
  return {
    id: 'sig_1',
    kind: 'silent',
    advisorId: 'adv_1',
    roomId: 'wr_1',
    groupName: '减重-张女士',
    days: 8,
    at: NOW,
    ...overrides,
  };
}

test('#161 沉默判定：客户 ≥7 天没说话且顾问同期也没说话', () => {
  assert.equal(DEFAULT_SILENT_DAYS, 7);
  assert.equal(isSilent({ lastCustomerAt: NOW - 7 * DAY, now: NOW }), true);
  assert.equal(isSilent({ lastCustomerAt: NOW - 6 * DAY, now: NOW }), false);
  assert.equal(isSilent({ now: NOW }), false);
  // 顾问近期在群里说过话 → 不算没人管
  assert.equal(
    isSilent({ lastCustomerAt: NOW - 10 * DAY, lastAdvisorAt: NOW - 2 * DAY, now: NOW }),
    false,
  );
  // 顾问最后一次发言也在沉默窗口之前 → 仍然算沉默
  assert.equal(
    isSilent({ lastCustomerAt: NOW - 10 * DAY, lastAdvisorAt: NOW - 9 * DAY, now: NOW }),
    true,
  );
  assert.equal(isSilent({ lastCustomerAt: NOW - 3 * DAY, now: NOW, silentDays: 3 }), true);
});

test('#161 投诉关键词：宁可漏，不把正常健康讨论当投诉', () => {
  assert.equal(matchComplaints(''), undefined);
  assert.equal(matchComplaints('最近有点过敏，想问问能不能吃虾'), undefined);
  assert.deepEqual(matchComplaints('我要投诉你们')?.keywords, ['投诉']);
  assert.deepEqual(matchComplaints('孩子过敏加重了，很不满意')?.keywords, [
    '很不满意',
    '过敏加重',
  ]);
  assert.match(matchComplaints('没人管，我要退款')?.excerpt ?? '', /没人管/);
  const hit = matchComplaints(`${'前面'.repeat(30)}我要投诉${'后面'.repeat(30)}`);
  assert.ok((hit?.excerpt.length ?? 0) <= 30);
});

test('#161 排序：投诉优先于沉默；沉默越久越靠前', () => {
  const silent = signal({ id: 's1', days: 30 });
  const complaint = signal({ id: 'c1', kind: 'complaint', days: 0, keywords: ['投诉'] });
  const ranked = rankSignals([silent, complaint]);
  assert.equal(ranked[0]!.id, 'c1');

  const a = signal({ id: 'a', days: 8 });
  const b = signal({ id: 'b', days: 20 });
  assert.deepEqual(
    rankSignals([a, b]).map((item) => item.id),
    ['b', 'a'],
  );
});

test('#161 汇总：无信号不推，最多 3 条，带「另有 N 条」', () => {
  assert.equal(buildPatrolDigest([], { now: NOW }), undefined);

  const many = [
    signal({ id: '1', days: 8 }),
    signal({ id: '2', days: 9, roomId: 'wr_2', groupName: '增重-李先生' }),
    signal({ id: '3', days: 10, roomId: 'wr_3', groupName: '调理-王女士' }),
    signal({ id: '4', days: 11, roomId: 'wr_4', groupName: '产后-赵女士' }),
  ];
  const text = buildPatrolDigest(many, { now: NOW }) ?? '';
  assert.match(text, /今日巡检 · 3 个群需要关注/);
  assert.match(text, /另有 1 条/);
  assert.equal((text.match(/客户已沉默/g) ?? []).length, 3);
  assert.match(text, /今天不看/);
});

test('#161 无 patient.read 时汇总只显示群名', () => {
  const text =
    buildPatrolDigest([signal({ customerName: '张女士' })], {
      now: NOW,
      canReadPatient: false,
    }) ?? '';
  assert.match(text, /减重-张女士/);
  assert.equal(text.includes('张女士 · 张女士'), false);
});

test('#161 去重：同一客户 14 天内只提醒一次，按信号类型分开', () => {
  const recent = [
    { kind: 'silent' as const, roomId: 'wr_1', customerId: 'wm_1', at: NOW - 5 * DAY },
  ];
  assert.equal(
    isDuplicateSignal({ kind: 'silent', roomId: 'wr_1', customerId: 'wm_1' }, recent, {
      now: NOW,
    }),
    true,
  );
  assert.equal(
    isDuplicateSignal({ kind: 'complaint', roomId: 'wr_1', customerId: 'wm_1' }, recent, {
      now: NOW,
    }),
    false,
  );
  assert.equal(
    isDuplicateSignal({ kind: 'silent', roomId: 'wr_1', customerId: 'wm_1' }, recent, {
      now: NOW,
      perCustomerDays: 3,
    }),
    false,
  );
  // 没有客户 id 时按群去重
  assert.equal(
    isDuplicateSignal({ kind: 'silent', roomId: 'wr_1' }, recent, { now: NOW }),
    true,
  );
  assert.equal(
    isDuplicateSignal({ kind: 'silent', roomId: 'wr_2' }, recent, { now: NOW }),
    false,
  );
});
