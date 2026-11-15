/**
 * 侧边栏「草稿生成中」状态：客户消息到达后到草稿推出前，运行时要把进度暴露出去，
 * 否则顾问在侧边栏里看到的就是一段没有任何反馈的空白等待。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupRuntime, observeServiceGroup } from './p1-helpers.ts';

const DRAFT_INPUT = {
  body: '您好，今天先按原方案吃药，明天上午来门诊复测。',
  inboundSummary: '问头晕要不要停药',
  riskLevel: 'medium' as const,
  citedMemoryIds: [],
  citedKnowledgeIds: [],
};

function inbound(roomId = 'wr_g1', text = '早上吃完药有点头晕，要不要停？') {
  return { msgid: `m_${text}`, roomId, from: 'wm_patient', text, msgtime: 1_700_000_000_000 };
}

function servingRuntime() {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  return h;
}

test('没有客户消息时没有生成进度', () => {
  const h = servingRuntime();
  assert.equal(h.runtime.draftProgress('wr_g1'), undefined);
});

test('客户消息进合并窗口是 queued，回合中是 generating，草稿推给顾问后退场', async () => {
  const h = servingRuntime();
  const seen: unknown[] = [];
  h.sessions.onPrompt = async (sessionId) => {
    seen.push(h.runtime.draftProgress('wr_g1'));
    await h.runtime.replyDraft(sessionId, DRAFT_INPUT);
  };

  h.runtime.routeInbound(inbound());
  const queued = h.runtime.draftProgress('wr_g1');
  assert.equal(queued?.state, 'queued');
  assert.equal(queued?.since, h.clock.now());

  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal((seen[0] as { state: string }).state, 'generating');
  // 草稿已经推到顾问侧，占位退出，由草稿卡片接管
  assert.equal(h.runtime.draftProgress('wr_g1'), undefined);
});

test('回合跳过（无需回复）时生成进度立刻收掉，不留占位', async () => {
  const h = servingRuntime();
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '客户只是道谢' });
  };

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued.length, 0);
  assert.equal(h.runtime.draftProgress('wr_g1'), undefined);
});

test('卡在合并窗口超过 3 分钟视为结束，避免占位一直挂着', () => {
  const h = servingRuntime();
  h.runtime.routeInbound(inbound());
  h.clock.advance(4 * 60_000);
  assert.equal(h.runtime.draftProgress('wr_g1'), undefined);
  // 清理后再次查询也不会复活
  assert.equal(h.runtime.draftProgress('wr_g1'), undefined);
});

test('不同群互不影响', () => {
  const h = servingRuntime();
  h.runtime.routeInbound(inbound());
  assert.equal(h.runtime.draftProgress('wr_other'), undefined);
  assert.equal(h.runtime.draftProgress('wr_g1')?.state, 'queued');
});
