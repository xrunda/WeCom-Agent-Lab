import test from 'node:test';
import assert from 'node:assert/strict';

import { setupRuntime, observeServiceGroup } from './p1-helpers.ts';

const DRAFT = {
  body: '早上好，今天记得量一下血压，记录后发我。',
  inboundSummary: '主动提醒量血压',
  riskLevel: 'low' as const,
  citedMemoryIds: [],
  citedKnowledgeIds: [],
};

async function servingHarness(options: { maxProactivePerHour?: number; memory?: boolean } = {}) {
  const memory = options.memory
    ? { available: () => true, render: () => ['【患者长期记忆】', '- [mem_1] 对海鲜过敏（本人）'] }
    : undefined;
  const h = setupRuntime({
    memory,
    capabilities: () => ({ memory: Boolean(memory), care: true }),
    maxProactivePerHour: options.maxProactivePerHour,
  });
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '初始化' });
  };
  h.runtime.routeInbound({
    msgid: 'm_init',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '你好',
    msgtime: h.clock.now(),
  });
  h.clock.advance(30_000);
  await h.runtime.flushDue();
  return h;
}

test('#36 主动计划回合产出 proactive 草稿，且没有 inbound 消息 id', async () => {
  const h = await servingHarness({ memory: true });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, DRAFT);
  };

  const result = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_1',
    title: '提醒量血压',
  });

  assert.equal(result.status, 'draft');
  const enqueued = h.bridge.enqueued[0];
  assert.equal(enqueued.source, 'proactive');
  assert.deepEqual(enqueued.inboundMessageIds, []);
  assert.equal(enqueued.customerId, 'wm_patient');
  assert.equal(enqueued.advisorId, 'adv_1');
  assert.equal(h.runtime.stats().proactiveDrafts, 1);

  const prompt = h.sessions.prompts.at(-1)?.text ?? '';
  assert.match(prompt, /主动触发/);
  assert.match(prompt, /计划到期：提醒量血压/);
  assert.match(prompt, /患者长期记忆/);
  assert.ok(h.events.some((event) => event.type === 'patient.proactive.started'));
});

test('#36 主动回合不需要发消息时 reply_skip，不产生草稿也不套模板', async () => {
  const h = await servingHarness();
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '刚提醒过' });
  };

  const result = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_1',
    title: '提醒喝水',
  });

  assert.deepEqual(result, { status: 'skipped' });
  assert.equal(h.bridge.enqueued.length, 0);
  assert.equal(h.runtime.stats().proactiveSkipped, 1);
});

test('#36 模型没调工具时不生成模板草稿，只记录 proactive.failed', async () => {
  const h = await servingHarness();
  h.sessions.onPrompt = async () => undefined;

  const result = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_1',
    title: '提醒量血压',
  });

  assert.equal(result.status, 'failed');
  assert.equal(h.bridge.enqueued.length, 0);
  assert.ok(h.events.some((event) => event.type === 'patient.proactive.failed'));
});

test('#36 患者正在回合中：主动计划顺延，不抢资源', async () => {
  const h = await servingHarness();
  let release: (() => void) | undefined;
  h.sessions.onPrompt = (sessionId) =>
    new Promise<void>((resolve) => {
      release = () => {
        void h.runtime.replySkip(sessionId, { reason: '迟到回复' }).then(() => resolve());
      };
    });

  const first = h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_1',
    title: '提醒量血压',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_2',
    title: '提醒喝水',
  });
  assert.equal(second.status, 'deferred');
  if (second.status === 'deferred') assert.equal(second.reason, 'ACTIVE_TURN');
  assert.equal(h.runtime.stats().proactiveDeferred, 1);

  release?.();
  await first;
});

test('#36 同一顾问每小时主动草稿限流，超出返回 retryAt 顺延', async () => {
  const h = await servingHarness({ maxProactivePerHour: 1 });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, DRAFT);
  };

  const first = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_1',
    title: '提醒量血压',
  });
  assert.equal(first.status, 'draft');

  const second = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_2',
    title: '提醒喝水',
  });
  assert.equal(second.status, 'deferred');
  if (second.status === 'deferred') {
    assert.equal(second.reason, 'HOURLY_LIMIT');
    assert.equal(second.retryAt, h.clock.now() + 3_600_000 + 1_000);
  }
  assert.equal(h.bridge.enqueued.length, 1);
});

test('#36 未同意存档 / 群未启用 / 患者未服务时不发主动消息', async () => {
  const h = await servingHarness();
  const group = h.store.getGroupByRoomId('wr_g1')!;
  h.service.setMemberConsent(group.id, 'wm_patient', 'disagreed');
  assert.deepEqual(
    await h.runtime.startProactiveTurn({ patientId: 'pat_1', planId: 'p', title: 't' }),
    { status: 'failed', reason: 'CONSENT_DISAGREED' },
  );

  h.service.setMemberConsent(group.id, 'wm_patient', 'agreed');
  h.service.setGroupStatus(group.id, 'collect_only');
  assert.deepEqual(
    await h.runtime.startProactiveTurn({ patientId: 'pat_1', planId: 'p', title: 't' }),
    { status: 'failed', reason: 'GROUP_NOT_SERVING' },
  );

  h.service.setGroupStatus(group.id, 'serving');
  h.service.updatePatient('pat_1', { status: 'paused' });
  assert.deepEqual(
    await h.runtime.startProactiveTurn({ patientId: 'pat_1', planId: 'p', title: 't' }),
    { status: 'failed', reason: 'PATIENT_NOT_SERVING' },
  );
});

test('#36 患者提问还在合并窗口内时，主动计划让位，先出患者草稿', async () => {
  const h = await servingHarness();
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, DRAFT);
  };

  h.runtime.routeInbound({
    msgid: 'm_question',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '今天头晕',
    msgtime: h.clock.now(),
  });
  const result = await h.runtime.startProactiveTurn({
    patientId: 'pat_1',
    planId: 'pln_1',
    title: '提醒量血压',
  });
  assert.equal(result.status, 'deferred');
  if (result.status === 'deferred') assert.equal(result.reason, 'ACTIVE_TURN');
  assert.equal(h.bridge.enqueued.length, 0);

  h.clock.advance(30_000);
  await h.runtime.flushDue();
  assert.equal(h.bridge.enqueued.length, 1);
  assert.equal(h.bridge.enqueued[0]?.source, 'inbound');
});

test('#36 patientContextForSession 在回合外不暴露患者', async () => {
  const h = await servingHarness();
  assert.equal(h.runtime.patientContextForSession('session_pat_1'), undefined);
});
