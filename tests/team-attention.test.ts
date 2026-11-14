import test from 'node:test';
import assert from 'node:assert/strict';

import type { Draft } from '../src/c2/types.ts';
import type { AlertRecord } from '../src/p1/console-types.ts';
import {
  dashboardTeamAttention,
  TEAM_ATTENTION_THRESHOLDS,
} from '../src/p1/console-views.ts';
import type { AdvisorRecord, Patient } from '../src/p1/types.ts';

// 2026-11-12 14:00（Asia/Shanghai），保证 90 分钟内的事件都落在同一天。
const NOW = Date.UTC(2026, 10, 12, 6, 0, 0);
const MINUTE = 60_000;
const at = (minutesAgo: number): number => NOW - minutesAgo * MINUTE;

function patient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'pat_1',
    tenantId: 'tn_test',
    displayName: '某客户',
    externalUserId: 'wm_1',
    tags: [],
    advisorId: 'adv_1',
    consent: 'agreed',
    status: 'serving',
    demo: false,
    accompaniedSince: at(10_000),
    lastActiveAt: at(45),
    createdAt: at(10_000),
    updatedAt: at(45),
    ...overrides,
  };
}

function advisor(overrides: Partial<AdvisorRecord> = {}): AdvisorRecord {
  return {
    id: 'adv_1',
    tenantId: 'tn_test',
    wecomUserId: 'user_1',
    name: '王顾问',
    status: 'active',
    chatBound: true,
    consecutiveMisroutes: 0,
    createdAt: at(10_000),
    updatedAt: at(10_000),
    ...overrides,
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'draft_1',
    advisorId: 'adv_1',
    groupRoomId: 'room_1',
    groupName: '服务群',
    customerId: 'wm_1',
    customerName: '某客户',
    inboundMessageId: 'm_1',
    inboundSummary: '客户消息',
    body: '草稿正文',
    ruleIds: [],
    riskLevel: 'low',
    status: 'QUEUED',
    createdAt: at(20),
    queuedAt: at(20),
    nextAttemptAt: at(20),
    pushAttempts: 0,
    verifyAttempts: 0,
    ...overrides,
  };
}

function alert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: 'alert_1',
    tenantId: 'tn_test',
    kind: 'redline',
    severity: 'critical',
    status: 'open',
    title: '红线命中',
    message: '告警正文（不进入团队关注）',
    draftId: null,
    patientId: null,
    advisorId: 'adv_1',
    groupId: null,
    note: null,
    resolvedBy: null,
    resolvedAt: null,
    escalatedTo: null,
    createdAt: at(20),
    updatedAt: at(20),
    sandbox: false,
    ...overrides,
  };
}

function build(input: {
  advisors?: AdvisorRecord[];
  patients?: Patient[];
  drafts?: Draft[];
  alerts?: AlertRecord[];
}) {
  return dashboardTeamAttention({
    now: NOW,
    timeZone: 'Asia/Shanghai',
    drafts: input.drafts ?? [],
    patients: input.patients ?? [],
    advisors: input.advisors ?? [advisor()],
    groups: [],
    bindings: [],
    alerts: input.alerts ?? [],
  });
}

test('未解决告警按服务人员收敛成一行，L1 优先且不重复', () => {
  const view = build({
    patients: [patient({ lastActiveAt: at(5) })],
    alerts: [
      alert({ id: 'a1', kind: 'redline', createdAt: at(20) }),
      alert({ id: 'a2', kind: 'redline', createdAt: at(10) }),
      alert({ id: 'a3', kind: 'misroute', createdAt: at(5), status: 'acknowledged' }),
      alert({ id: 'a4', kind: 'unverified', createdAt: at(3), status: 'resolved' }),
    ],
  });

  assert.equal(view.people.length, 1);
  const person = view.people[0]!;
  assert.equal(person.advisorId, 'adv_1');
  assert.equal(person.level, 'L1');
  assert.deepEqual(
    person.reasons.map((reason) => reason.code),
    ['redline', 'misroute'],
  );
  assert.equal(person.reasons[0]!.text, '高风险草稿 2 条待处理');
  assert.equal(person.reasons[0]!.waitMinutes, 20);
  assert.equal(person.oldestWaitMinutes, 20);
  assert.equal(person.suggestion, '去质检与告警跟进高风险草稿');
  assert.equal(view.summary.peopleCount, 1);
  assert.equal(view.summary.immediateCount, 1);
  // 告警正文与患者姓名不应出现在团队关注里。
  assert.equal(JSON.stringify(view).includes('告警正文'), false);
  assert.equal(JSON.stringify(view).includes('某客户'), false);
});

test('队列阻塞从 15 分钟起算，客户消息 30 / 60 分钟分 L2 与 L1', () => {
  const blocked = build({
    advisors: [advisor({ id: 'adv_1', name: '王顾问' })],
    patients: [patient({ lastActiveAt: at(5) })],
    drafts: [
      draft({
        status: 'PUSHED',
        createdAt: at(25),
        pushedAt: at(19),
      }),
    ],
  });
  assert.equal(blocked.people.length, 1);
  assert.equal(blocked.people[0]!.level, 'L1');
  assert.equal(blocked.people[0]!.reasons[0]!.code, 'queue_blocked');
  assert.equal(blocked.people[0]!.reasons[0]!.waitMinutes, 19);

  const notYet = build({
    advisors: [advisor({ id: 'adv_1', name: '王顾问' })],
    patients: [patient({ lastActiveAt: at(5) })],
    drafts: [draft({ status: 'PUSHED', createdAt: at(15), pushedAt: at(14) })],
  });
  assert.equal(notYet.people.length, 0);

  const l2 = build({
    advisors: [advisor({ id: 'adv_1', name: '王顾问' })],
    patients: [patient({ lastActiveAt: at(30) })],
  });
  assert.equal(l2.people[0]!.level, 'L2');
  assert.equal(l2.people[0]!.reasons[0]!.code, 'no_reply');
  assert.equal(l2.people[0]!.reasons[0]!.waitMinutes, 30);

  const l1 = build({
    advisors: [advisor({ id: 'adv_1', name: '王顾问' })],
    patients: [patient({ lastActiveAt: at(60) })],
  });
  assert.equal(l1.people[0]!.level, 'L1');
  assert.equal(l1.people[0]!.reasons[0]!.code, 'no_reply');

  // 新草稿晚于客户消息 → 已有人跟进，不再提示。
  const followed = build({
    advisors: [advisor({ id: 'adv_1', name: '王顾问' })],
    patients: [patient({ lastActiveAt: at(60) })],
    drafts: [draft({ createdAt: at(50) })],
  });
  assert.equal(followed.people.length, 0);
});

test('积压、慢响应与高改稿率聚合为 L2 建议', () => {
  const slowDrafts = [30, 31, 32, 33].map((minutes, index) =>
    draft({
      id: `draft_slow_${index}`,
      lastInboundAt: at(minutes),
      createdAt: at(minutes - 30),
      status: index < 2 ? 'PUSHED' : 'QUEUED',
      pushedAt: index < 2 ? at(minutes - 20) : undefined,
      ackAction: index < 2 ? 'skipped' : undefined,
    }),
  );
  const fastDrafts = [0, 1, 2, 3, 4].map((index) =>
    draft({
      id: `draft_fast_${index}`,
      advisorId: 'adv_2',
      customerId: 'wm_2',
      lastInboundAt: at(1),
      createdAt: at(0),
      status: 'VERIFIED',
      ackAction: 'sent',
    }),
  );

  const view = build({
    advisors: [
      advisor({ id: 'adv_1', name: '王顾问' }),
      advisor({ id: 'adv_2', name: '李顾问' }),
    ],
    patients: [
      patient({ id: 'pat_1', externalUserId: 'wm_1', lastActiveAt: at(120) }),
      patient({
        id: 'pat_2',
        externalUserId: 'wm_2',
        advisorId: 'adv_2',
        lastActiveAt: at(120),
      }),
    ],
    drafts: [...slowDrafts, ...fastDrafts],
  });

  const slow = view.people.find((person) => person.advisorId === 'adv_1');
  assert.ok(slow);
  assert.equal(slow.level, 'L2');
  assert.deepEqual(
    slow.reasons.map((reason) => reason.code),
    ['backlog', 'slow_response', 'high_revision'],
  );
  assert.equal(slow.pendingCount, 4);
  assert.equal(slow.patientCount, 1);

  const fast = view.people.find((person) => person.advisorId === 'adv_2');
  assert.equal(fast, undefined);
  assert.equal(
    TEAM_ATTENTION_THRESHOLDS.backlogCount,
    3,
  );
});

test('没有需要关注的事项时返回空列表与运行摘要', () => {
  const view = build({
    patients: [patient({ lastActiveAt: at(5) })],
    drafts: [draft({ status: 'VERIFIED', ackAction: 'sent' })],
  });
  assert.equal(view.people.length, 0);
  assert.equal(view.summary.peopleCount, 0);
  assert.equal(view.summary.immediateCount, 0);
  assert.equal(view.summary.verifiedToday, 1);
});
