import test from 'node:test';
import assert from 'node:assert/strict';

import type { Draft } from '../src/c2/types.ts';
import { buildPatientTimeline } from '../src/p1/console-views.ts';
import { paginate } from '../src/p1/console-types.ts';
import type { MemoryRecord } from '../src/p1/memory.ts';
import type { Patient } from '../src/p1/types.ts';

const PATIENT = {
  id: 'pat_1',
  tenantId: 'tn_test',
  displayName: '王女士',
  tags: [],
  consent: 'agreed',
  status: 'serving',
  demo: false,
  accompaniedSince: 0,
  createdAt: 0,
  updatedAt: 0,
} as Patient;

function inboundDraft(id: string, inboundAt: number, replyAt: number): Draft {
  return {
    id,
    lastInboundAt: inboundAt,
    inboundSummary: `${id} 的客户消息`,
    revisions: [{ version: 1, createdAt: replyAt, createdBy: 'agent', body: `${id} 的回复` }],
  } as unknown as Draft;
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_1',
    tenantId: 'tn_test',
    patientId: 'pat_1',
    category: 'body',
    content: '66 岁，有高血压，偶尔会胸闷气短。',
    subject: 'self',
    sourceText: '我今年66岁……平时有高血压，偶尔会胸闷气短',
    createdBy: 'agent',
    createdAt: 1_000,
    updatedAt: 1_000,
    sandbox: false,
    ...overrides,
  };
}

test('时间线按最新在前返回，分页第一页保留最新事件', () => {
  const drafts: Draft[] = [];
  for (let index = 1; index <= 25; index += 1) {
    drafts.push(inboundDraft(`draft_${index}`, index * 1_000, index * 1_000 + 500));
  }
  const events = buildPatientTimeline({
    patient: PATIENT,
    drafts,
    memories: [],
    carePlans: [],
    alerts: [],
  });

  assert.equal(events.length, 50);
  assert.equal(events[0].at, 25_500);
  assert.equal(events.at(-1)?.at, 1_000);

  const firstPage = paginate(events, 1, 20);
  assert.equal(firstPage.total, 50);
  assert.equal(firstPage.items[0].at, 25_500);
  assert.equal(firstPage.items.at(-1)?.at, 16_000);
  // 第二页才出现较早的事件，最新事件不会因为分页被挤掉
  assert.equal(paginate(events, 2, 20).items[0].at, 15_500);
});

test('记忆修正单独生成「修正记忆」事件，不把新内容倒填到旧时间点', () => {
  const events = buildPatientTimeline({
    patient: PATIENT,
    drafts: [],
    memories: [
      memory({
        content: '68 岁，有高血压，偶尔会胸闷气短。',
        createdAt: 1_000,
        updatedAt: 5_000,
        revisedAt: 5_000,
        updatedBy: 'agent',
      }),
    ],
    carePlans: [],
    alerts: [],
  });

  assert.deepEqual(
    events.map((event) => [event.at, event.title, event.detail]),
    [
      [5_000, '修正记忆', '68 岁，有高血压，偶尔会胸闷气短。'],
      [1_000, '记录记忆', '我今年66岁……平时有高血压，偶尔会胸闷气短'],
    ],
  );
  assert.equal(events[1].actor.type, 'agent');
  assert.equal(events[0].actor.type, 'agent');
});

test('顾问修正记忆时，修正事件归属顾问', () => {
  const events = buildPatientTimeline({
    patient: PATIENT,
    drafts: [],
    memories: [
      memory({ content: '68 岁', updatedAt: 5_000, revisedAt: 5_000, updatedBy: 'staff' }),
    ],
    carePlans: [],
    alerts: [],
  });
  const revised = events.find((event) => event.title === '修正记忆');
  assert.equal(revised?.actor.type, 'advisor');
});

test('只更新来源、内容没变的记忆不产生修正事件', () => {
  const events = buildPatientTimeline({
    patient: PATIENT,
    drafts: [],
    memories: [memory({ updatedAt: 9_000 })],
    carePlans: [],
    alerts: [],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, '记录记忆');
  assert.equal(events[0].detail, '66 岁，有高血压，偶尔会胸闷气短。');
});
