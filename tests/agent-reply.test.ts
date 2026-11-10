import test from 'node:test';
import assert from 'node:assert/strict';

import { validateReplyDraft, validateReplySkip, buildReplyToolDefinitions } from '../src/p1/reply-tools.ts';
import { setupRuntime, observeServiceGroup, SETTINGS } from './p1-helpers.ts';

const DRAFT_INPUT = {
  body: '您好，今晚可以吃半碗杂粮饭，搭配清蒸鱼和绿叶菜。',
  inboundSummary: '问晚饭怎么吃',
  riskLevel: 'low' as const,
  citedMemoryIds: [],
  citedKnowledgeIds: [],
};

function inbound(roomId = 'wr_g1', text = '今晚吃什么？') {
  return { msgid: `m_${text}`, roomId, from: 'wm_patient', text, msgtime: 1_700_000_000_000 };
}

test('#34 工具参数校验：正文、摘要、风险等级、引用数组', () => {
  assert.equal(validateReplyDraft(DRAFT_INPUT).ok, true);
  assert.equal(validateReplyDraft({ ...DRAFT_INPUT, body: '   ' }).ok, false);
  assert.equal(validateReplyDraft({ ...DRAFT_INPUT, body: 'x'.repeat(1001) }).ok, false);
  assert.equal(validateReplyDraft({ ...DRAFT_INPUT, inboundSummary: '' }).ok, false);
  assert.equal(validateReplyDraft({ ...DRAFT_INPUT, inboundSummary: 'x'.repeat(81) }).ok, false);
  assert.equal(validateReplyDraft({ ...DRAFT_INPUT, riskLevel: 'critical' }).ok, false);
  assert.equal(validateReplyDraft({ ...DRAFT_INPUT, citedMemoryIds: [1] }).ok, false);
  assert.equal(validateReplyDraft(null).ok, false);

  assert.equal(validateReplySkip({ reason: '客户只是道谢' }).ok, true);
  assert.equal(validateReplySkip({ reason: '' }).ok, false);
  assert.equal(validateReplySkip({ reason: 'x'.repeat(201) }).ok, false);
});

test('#34 Agent 调用 reply_draft：草稿经桥入队，不进降级', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, DRAFT_INPUT);
  };

  assert.equal(h.runtime.routeInbound(inbound()).handled, true);
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued.length, 1);
  const enqueued = h.bridge.enqueued[0];
  assert.equal(enqueued.body, DRAFT_INPUT.body);
  assert.equal(enqueued.fallback, false);
  assert.equal(enqueued.source, 'inbound');
  assert.equal(enqueued.advisorId, 'adv_1');
  assert.equal(enqueued.customerId, 'wm_patient');
  assert.equal(h.runtime.stats().turns, 1);
  assert.equal(h.runtime.stats().replies, 1);
  assert.equal(h.runtime.stats().fallbacks, 0);
  const created = h.events.find((event) => event.type === 'draft.created');
  assert.ok(created);
  assert.equal((created.data as { fallback: boolean }).fallback, false);
});

test('#34 模型没调工具：降级为模板草稿并计 fallbacks', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async () => undefined;

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued.length, 1);
  const enqueued = h.bridge.enqueued[0];
  assert.equal(enqueued.fallback, true);
  assert.match(enqueued.body, /王顾问/);
  assert.equal(h.runtime.stats().fallbacks, 1);
  assert.equal(h.runtime.stats().replies, 0);
});

test('#34 回合超时：降级并计 timeouts', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.outcome = 'timeout';

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued[0]?.fallback, true);
  assert.equal(h.runtime.stats().timeouts, 1);
  assert.equal(h.runtime.stats().fallbacks, 1);
});

test('#34 模型报错：降级并计 errors', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.failPrompt = true;

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued[0]?.fallback, true);
  assert.equal(h.runtime.stats().errors, 1);
  assert.equal(h.runtime.stats().fallbacks, 1);
});

test('#34 会话创建失败也降级，不丢消息', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.ensure = async () => {
    throw new Error('WORKSPACE_DENIED');
  };

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued.length, 1);
  assert.equal(h.bridge.enqueued[0]?.fallback, true);
});

test('#34 reply_skip：记录不回复，不产生草稿也不降级', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '客户只是道谢' });
  };

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued.length, 0);
  assert.equal(h.runtime.stats().skips, 1);
  assert.equal(h.runtime.stats().fallbacks, 0);
  assert.ok(h.events.some((event) => event.type === 'patient.reply.skipped'));
});

test('#34 同一回合重复调用工具被拒绝', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  let secondError = '';
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, DRAFT_INPUT);
    await h.runtime.replyDraft(sessionId, DRAFT_INPUT).catch((error: Error) => {
      secondError = error.message;
    });
    await h.runtime.replySkip(sessionId, { reason: '重复' }).catch((error: Error) => {
      secondError = error.message;
    });
  };

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.match(secondError, /ALREADY_REPLIED/);
  assert.equal(h.bridge.enqueued.length, 1);
  assert.equal(h.runtime.stats().skips, 0);
});

test('#34 回合结束后再调用工具报 NO_ACTIVE_TURN', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '无需回复' });
  };

  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  await assert.rejects(h.runtime.replyDraft('session_pat_1', DRAFT_INPUT), /NO_ACTIVE_TURN|TURN_CLOSED/);
});

test('#34 核验结果写回患者会话，不唤醒新回合', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.runtime.routeInbound(inbound());
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  h.bridge.seedDraft({
    id: 'draft_v1',
    customerId: 'wm_patient',
    groupRoomId: 'wr_g1',
    version: 1,
    status: 'VERIFIED',
  });
  await h.runtime.handleDraftVerified('draft_v1', 'VERIFIED');

  const injected = h.sessions.contexts.find((item) => item.text.includes('已核验'));
  assert.ok(injected);
  assert.match(injected.text, /第 1 版/);
  assert.ok(h.events.some((event) => event.type === 'patient.verification.injected'));
  assert.equal(h.runtime.stats().turns, 1);
});

test('#34 DSH 工具定义：会话 id 路由、参数错误、concludeTurn', async () => {
  const calls: Array<{ sessionId: string; body: string }> = [];
  let concluded = 0;
  const tools = buildReplyToolDefinitions({
    async replyDraft(sessionId, input) {
      calls.push({ sessionId, body: input.body });
      return { draftId: 'draft_1', version: 1 };
    },
    async replySkip() {
      return { skipped: true };
    },
  });
  const draftTool = tools.find((tool) => tool.name === 'reply_draft');
  const skipTool = tools.find((tool) => tool.name === 'reply_skip');
  assert.ok(draftTool && skipTool);

  await assert.rejects(
    draftTool.execute(DRAFT_INPUT, { agent: undefined }),
    /INVALID_TOOL_ARGS .*没有关联的 Agent 会话/,
  );
  await assert.rejects(
    draftTool.execute({ ...DRAFT_INPUT, body: '' }, { agent: { id: 'session_1' } }),
    /INVALID_TOOL_ARGS .*body 不能为空/,
  );
  assert.equal(calls.length, 0);

  const result = await draftTool.execute(DRAFT_INPUT, {
    agent: { id: 'session_1' },
    concludeTurn: () => {
      concluded += 1;
    },
  });
  assert.deepEqual(result, { draftId: 'draft_1', version: 1 });
  assert.deepEqual(calls, [{ sessionId: 'session_1', body: DRAFT_INPUT.body }]);
  assert.equal(concluded, 1);

  await assert.rejects(
    skipTool.execute({ reason: '' }, { agent: { id: 'session_1' } }),
    /INVALID_TOOL_ARGS .*reason 不能为空/,
  );
});

test('#34 系统提示词包含红线与工具契约，不含患者原文', () => {
  const h = setupRuntime();
  const prompt = h.runtime.systemPrompt();
  assert.match(prompt, /小安/);
  assert.match(prompt, /reply_draft/);
  assert.match(prompt, /reply_skip/);
  assert.match(prompt, /120/);
  assert.match(prompt, /直接复制发到客户群/);
  assert.equal(SETTINGS.patientTerm, '患者');
});

test('#34 reply_draft 工具说明要求正文可直接转发', () => {
  const tools = buildReplyToolDefinitions({
    async replyDraft() {
      return { draftId: 'draft_1', version: 1 };
    },
    async replySkip() {
      return { skipped: true };
    },
  });
  const draftTool = tools.find((tool) => tool.name === 'reply_draft');
  assert.ok(draftTool);
  assert.match(draftTool.description, /直接.*转发到客户群/);
  assert.match(JSON.stringify(draftTool.parameters), /直接复制到客户群/);
});
