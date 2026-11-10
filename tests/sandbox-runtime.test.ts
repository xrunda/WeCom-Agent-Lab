/**
 * #40 沙盒运行时单测：真 Agent 回合、草稿进 sink、不碰 C2 与统计。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PatientAgentRuntime } from '../src/p1/runtime.ts';
import type {
  SandboxDraftInput,
  SandboxDraftSink,
  SandboxTurnInput,
} from '../src/p1/runtime.ts';
import { FakeBridge, FakeSessions, SETTINGS, setupPatient, TENANT } from './p1-helpers.ts';

function sandboxSetup(options: { withSink?: boolean } = {}) {
  const base = setupPatient();
  const sessions = new FakeSessions();
  const bridge = new FakeBridge();
  const drafts: SandboxDraftInput[] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  let seq = 0;
  const sink: SandboxDraftSink = {
    enqueueDraft(input) {
      drafts.push(input);
      seq += 1;
      return { draftId: `draft_sbx_${seq}`, version: 1 };
    },
  };
  const runtime = new PatientAgentRuntime({
    service: base.service,
    settings: { ...SETTINGS },
    bridge,
    sessions,
    emit: (type, data) => events.push({ type, data }),
    logger: () => undefined,
    mergeWindowMs: 30_000,
    mergeMaxWaitMs: 120_000,
    now: () => base.clock.now(),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    sandboxSink: options.withSink === false ? undefined : () => sink,
  });
  const input: SandboxTurnInput = {
    sessionId: 'session_pat_sandbox_acc_test',
    patient: {
      id: 'pat_sandbox_acc_test',
      tenantId: TENANT,
      displayName: '体验患者',
      externalUserId: 'wm_sandbox_acc_test',
    },
    group: {
      id: 'grp_sandbox_acc_test_1',
      roomId: 'wr_sandbox_acc_test_1',
      name: '体验客户群',
    },
    text: '我对海鲜过敏',
    mediaPaths: [],
    at: base.clock.now(),
  };
  return { ...base, sessions, bridge, drafts, events, runtime, input };
}

test('沙盒回合用真 Agent 提示词；未产出工具调用时回落到 sink 模板草稿', async () => {
  const ctx = sandboxSetup();
  await ctx.runtime.runSandboxTurn(ctx.input);

  assert.equal(ctx.sessions.prompts.length, 1);
  assert.equal(ctx.sessions.prompts[0]!.sessionId, ctx.input.sessionId);
  assert.equal(ctx.sessions.prompts[0]!.text.includes('我对海鲜过敏'), true);
  assert.equal(ctx.sessions.prompts[0]!.text.includes('小安'), true);

  assert.equal(ctx.drafts.length, 1);
  const draft = ctx.drafts[0]!;
  assert.equal(draft.sessionId, ctx.input.sessionId);
  assert.equal(draft.patientId, 'pat_sandbox_acc_test');
  assert.equal(draft.groupId, 'grp_sandbox_acc_test_1');
  assert.equal(draft.groupName, '体验客户群');
  assert.equal(draft.fallback, true);
  assert.equal(draft.riskLevel, 'low');
  assert.equal(draft.inboundSummary.includes('我对海鲜过敏'), true);

  // 不进 C2、不计数、不派发正式草稿事件
  assert.equal(ctx.bridge.enqueued.length, 0);
  assert.deepEqual(ctx.runtime.stats(), {
    turns: 0,
    replies: 0,
    skips: 0,
    fallbacks: 0,
    timeouts: 0,
    errors: 0,
    mergedBatches: 0,
    contextMessages: 0,
    revisions: 0,
    duplicatesSkipped: 0,
    proactiveDrafts: 0,
    proactiveSkipped: 0,
    proactiveDeferred: 0,
  });
  assert.equal(ctx.events.length, 0);
});

test('Agent 调 reply_draft 时草稿原样交给 sink，标记非模板', async () => {
  const ctx = sandboxSetup();
  ctx.sessions.onPrompt = async (sessionId) => {
    await ctx.runtime.replyDraft(sessionId, {
      body: '晚餐建议避开海鲜，选择清淡的蛋白质。',
      inboundSummary: '患者说自己对海鲜过敏',
      riskLevel: 'medium',
      citedMemoryIds: ['mem_allergy'],
      citedKnowledgeIds: [],
    });
  };

  await ctx.runtime.runSandboxTurn(ctx.input);
  assert.equal(ctx.drafts.length, 1);
  const draft = ctx.drafts[0]!;
  assert.equal(draft.fallback, false);
  assert.equal(draft.body, '晚餐建议避开海鲜，选择清淡的蛋白质。');
  assert.equal(draft.riskLevel, 'medium');
  assert.deepEqual(draft.citedMemoryIds, ['mem_allergy']);
  assert.equal(ctx.bridge.enqueued.length, 0);
  assert.equal(ctx.runtime.stats().replies, 0);
});

test('Agent 调 reply_skip 时不产生草稿，也不计跳过统计', async () => {
  const ctx = sandboxSetup();
  ctx.sessions.onPrompt = async (sessionId) => {
    await ctx.runtime.replySkip(sessionId, { reason: '无需回复' });
  };

  await ctx.runtime.runSandboxTurn(ctx.input);
  assert.equal(ctx.drafts.length, 0);
  assert.equal(ctx.runtime.stats().skips, 0);
  assert.equal(ctx.bridge.enqueued.length, 0);
});

test('没有控制台 sink 时沙盒回合拒绝执行', async () => {
  const ctx = sandboxSetup({ withSink: false });
  await assert.rejects(
    () => ctx.runtime.runSandboxTurn(ctx.input),
    /SANDBOX_SINK_UNAVAILABLE/,
  );
  assert.equal(ctx.sessions.prompts.length, 0);
});

test('applySettings 立即影响系统提示词与下一轮提示词', async () => {
  const ctx = sandboxSetup();
  assert.equal(ctx.runtime.systemPrompt().includes('小安'), true);

  ctx.runtime.applySettings({ agentName: '小新', patientTerm: '会员', tone: '温和、简短' });
  const prompt = ctx.runtime.systemPrompt();
  assert.equal(prompt.includes('「小新」'), true);
  assert.equal(prompt.includes('「会员」'), true);
  assert.equal(prompt.includes('温和、简短'), true);
  // 空白值不覆盖已有设置
  ctx.runtime.applySettings({ agentName: '   ' });
  assert.equal(ctx.runtime.systemPrompt().includes('小新'), true);

  await ctx.runtime.runSandboxTurn(ctx.input);
  assert.equal(ctx.sessions.prompts.at(-1)!.text.includes('小新'), true);
});
