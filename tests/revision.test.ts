import test from 'node:test';
import assert from 'node:assert/strict';

import { PatientAgentRuntime } from '../src/p1/runtime.ts';
import { setupPatient, observeServiceGroup, FakeSessions, c2Bridge, SETTINGS } from './p1-helpers.ts';
import { setup as setupC2, bindDefaultAdvisor } from './helpers.ts';

function buildHarness() {
  const c2 = setupC2();
  bindDefaultAdvisor(c2.service, { advisorId: 'adv_1', chatId: 'chat_a1' });
  c2.service.bindGroup({
    roomId: 'wr_g1',
    name: '减重-张女士',
    advisorId: 'adv_1',
    chatId: 'chat_a1',
  });

  const patient = setupPatient();
  const sessions = new FakeSessions();
  const bridge = c2Bridge(c2.service);
  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const runtime = new PatientAgentRuntime({
    service: patient.service,
    settings: SETTINGS,
    bridge,
    sessions,
    emit: (type, data) => events.push({ type, data }),
    logger: (line) => logs.push(line),
    mergeWindowMs: 30_000,
    mergeMaxWaitMs: 120_000,
    now: () => patient.clock.now(),
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
  const group = observeServiceGroup(patient, { status: 'serving', advisorId: 'adv_1' });

  return { c2, patient, sessions, bridge, runtime, events, logs, group };
}

function inbound(text = '今晚吃什么？') {
  return {
    msgid: `m_${text}`,
    roomId: 'wr_g1',
    from: 'wm_patient',
    text,
    msgtime: 1_700_000_000_000,
  };
}

function draftView(c2: ReturnType<typeof setupC2>) {
  const drafts = c2.store.listDrafts();
  return {
    count: drafts.length,
    latest: drafts[drafts.length - 1],
  };
}

test('#163 顾问一句话改稿：v1 → 改稿指令 → v2，旧版本失效', async () => {
  const h = buildHarness();
  let turnCount = 0;
  h.sessions.onPrompt = async (sessionId) => {
    turnCount += 1;
    await h.runtime.replyDraft(sessionId, {
      body: turnCount === 1 ? '第一版：今晚清淡饮食。' : '第二版：今晚清淡饮食，明天记得复诊。',
      inboundSummary: '问晚饭怎么吃',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound(inbound());
  h.patient.clock.advance(30_000);
  await h.runtime.flushDue();
  assert.equal(h.c2.store.listDrafts().length, 1);
  const draftId = h.c2.store.listDrafts()[0]!.id;
  assert.equal(h.c2.store.getDraft(draftId)?.version, 1);

  await h.c2.service.tick();
  assert.equal(h.c2.store.getDraft(draftId)?.status, 'PUSHED');
  // #163：1:1 不再推送卡片，侧边栏直接读草稿
  assert.equal(draftView(h.c2).count, 1);
  assert.equal(draftView(h.c2).latest?.version, 1);
  assert.equal(h.c2.bot.cards().length, 0);

  const handled = await h.runtime.handleAdvisorText('wang.guwen', '语气再温和一点，加上明天复诊');
  assert.equal(handled, true);
  const revised = h.c2.store.getDraft(draftId)!;
  assert.equal(revised.version, 2);
  assert.equal(revised.status, 'QUEUED');
  assert.equal(revised.body, '第二版：今晚清淡饮食，明天记得复诊。');
  assert.equal(revised.revisionInstruction, '语气再温和一点，加上明天复诊');
  assert.equal(revised.revisions?.length, 2);
  assert.equal(revised.revisions?.[1]?.version, 2);

  await h.c2.service.tick();
  assert.equal(h.c2.store.getDraft(draftId)?.status, 'PUSHED');
  // 侧边栏展示第 2 版；旧版本按钮仍会被判为过期
  assert.equal(h.c2.store.getDraft(draftId)?.version, 2);
  assert.equal(h.c2.bot.cards().length, 0);

  assert.throws(() => h.c2.service.handleButtonCallback(`ack:${draftId}:sent`), /STALE_CARD/);
  const acked = h.c2.service.handleButtonCallback(`ack:${draftId}:v2:sent`);
  assert.equal(acked.status, 'ACKNOWLEDGED');

  const audits = h.c2.store.listAudit().map((event) => event.action);
  assert.ok(audits.includes('draft.revision.request'));
  assert.ok(audits.includes('draft.revision'));
  assert.ok(h.events.some((event) => event.type === 'draft.revision.requested'));
  assert.ok(h.events.some((event) => event.type === 'draft.revised'));
});

test('#56 改稿提示词带上指令与目标版本', async () => {
  const h = buildHarness();
  const prompts: string[] = [];
  h.sessions.onPrompt = async (sessionId, text) => {
    prompts.push(text);
    await h.runtime.replyDraft(sessionId, {
      body: prompts.length === 1 ? '第一版' : '第二版',
      inboundSummary: '问晚饭',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound(inbound());
  h.patient.clock.advance(30_000);
  await h.runtime.flushDue();
  await h.c2.service.tick();

  await h.runtime.handleAdvisorText('wang.guwen', '把复诊时间写清楚');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /【顾问改稿指令】/);
  assert.match(prompts[1]!, /把复诊时间写清楚/);
  assert.match(prompts[1]!, /重写第 2 版/);
  assert.equal((h.c2.store.listDrafts()[0]?.version ?? 0), 2);
});

test('#56 没有待处理草稿时只回用法提示', async () => {
  const h = buildHarness();
  const handled = await h.runtime.handleAdvisorText('wang.guwen', '帮我改一下');
  assert.equal(handled, true);
  assert.equal(h.c2.store.listDrafts().length, 0);
  const lastText = h.c2.bot.texts().at(-1);
  assert.match(JSON.stringify(lastText?.message), /用法：收到草稿后/);
});

test('#56 改稿失败时保留旧版本并提示顾问', async () => {
  const h = buildHarness();
  h.sessions.onPrompt = async () => {
    throw new Error('MODEL_DOWN');
  };

  h.runtime.routeInbound(inbound());
  h.patient.clock.advance(30_000);
  await h.runtime.flushDue();
  // 第一轮降级为模板草稿
  await h.c2.service.tick();
  const draftId = h.c2.store.listDrafts()[0]!.id;
  const before = h.c2.store.getDraft(draftId)!;
  assert.equal(before.version, 1);
  assert.equal(before.fallback, true);

  await h.runtime.handleAdvisorText('wang.guwen', '换个说法');
  const after = h.c2.store.getDraft(draftId)!;
  assert.equal(after.version, 1);
  assert.equal(after.status, 'PUSHED');
  const texts = h.c2.bot.texts().map((record) => JSON.stringify(record.message));
  assert.ok(texts.some((text) => /改稿没有完成/.test(text)));
  assert.ok(h.events.some((event) => event.type === 'draft.revision.failed'));
});

test('#56 同一患者上一轮未结束时拒绝新的改稿指令', async () => {
  const h = buildHarness();
  // 先制造一条已推送的旧草稿，让顾问有东西可改
  h.c2.service.enqueueDraft({
    advisorId: 'adv_1',
    groupRoomId: 'wr_g1',
    customerId: 'wm_patient',
    customerName: '张女士',
    inboundMessageId: 'seed_1',
    inboundSummary: '上一轮的问题',
    body: '上一轮的草稿正文',
  });
  await h.c2.service.tick();

  let noticeDuringTurn = '';
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.handleAdvisorText('wang.guwen', '并行改一下');
    const last = h.c2.bot.texts().at(-1);
    noticeDuringTurn = last ? JSON.stringify(last.message) : '';
    await h.runtime.replySkip(sessionId, { reason: '测试' });
  };

  h.runtime.routeInbound(inbound());
  h.patient.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.match(noticeDuringTurn, /上一轮还在生成/);
  assert.equal(h.c2.store.listAudit().some((event) => event.action === 'draft.revision.request'), false);
});
