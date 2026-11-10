import test from 'node:test';
import assert from 'node:assert/strict';

import { setupRuntime, observeServiceGroup } from './p1-helpers.ts';

function msg(
  msgid: string,
  text: string,
  options: { from?: string; msgtime?: number; msgtype?: string; mediaPath?: string } = {},
) {
  return {
    msgid,
    roomId: 'wr_g1',
    from: options.from ?? 'wm_patient',
    text,
    msgtime: options.msgtime ?? 1_700_000_000_000,
    msgtype: options.msgtype,
    mediaPath: options.mediaPath,
  };
}

test('#63 连发 2 条文字 + 1 张图片合并成一轮', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  let prompt = '';
  h.sessions.onPrompt = async (sessionId, text) => {
    prompt = text;
    await h.runtime.replyDraft(sessionId, {
      body: '收到，火锅后第二天清淡一点，多喝水。',
      inboundSummary: '吃火锅后怎么调整',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  const base = h.clock.now();
  h.runtime.routeInbound(msg('m1', '我今天', { msgtime: base }));
  h.runtime.routeInbound(msg('m2', '吃了火锅', { msgtime: base + 5000 }));
  h.runtime.routeInbound(
    msg('m3', '', {
      msgtime: base + 10_000,
      msgtype: 'image',
      mediaPath: '/tmp/media/hotpot.jpg',
    }),
  );

  h.clock.set(base + 10_000);
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.sessions.prompts.length, 1);
  assert.match(prompt, /我今天/);
  assert.match(prompt, /吃了火锅/);
  assert.match(prompt, /\[图片\] \/tmp\/media\/hotpot\.jpg/);
  assert.equal(h.bridge.enqueued.length, 1);
  const enqueued = h.bridge.enqueued[0];
  assert.deepEqual(enqueued.inboundMessageIds, ['m1', 'm2', 'm3']);
  assert.deepEqual(enqueued.mediaIds, ['/tmp/media/hotpot.jpg']);
  assert.equal(enqueued.inboundSummary, '吃火锅后怎么调整');
  assert.equal(h.runtime.stats().mergedBatches, 1);
  assert.equal(h.runtime.stats().turns, 1);
});

test('#63 静默窗口未到不放行，满 30 秒才合并', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '测试' });
  };

  h.runtime.routeInbound(msg('m1', '在吗'));
  h.clock.advance(29_999);
  await h.runtime.flushDue();
  assert.equal(h.sessions.prompts.length, 0);

  h.clock.advance(1);
  await h.runtime.flushDue();
  assert.equal(h.sessions.prompts.length, 1);
});

test('#63 持续连发到 2 分钟上限强制放行', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '测试' });
  };

  const base = h.clock.now();
  h.runtime.routeInbound(msg('m1', '一', { msgtime: base }));
  h.clock.set(base + 110_000);
  h.runtime.routeInbound(msg('m2', '二', { msgtime: base + 110_000 }));
  h.clock.set(base + 120_000);
  await h.runtime.flushDue();

  assert.equal(h.sessions.prompts.length, 1);
  assert.equal(h.runtime.stats().mergedBatches, 1);
});

test('#63 内部员工发言只注入上下文，不触发回合', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });

  const result = h.runtime.routeInbound(
    msg('m1', '我先把复诊时间发群里', { from: 'wang.guwen' }),
  );
  assert.equal(result.handled, true);
  assert.equal(result.decision.action, 'context');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.sessions.prompts.length, 0);
  assert.equal(h.sessions.contexts.length, 1);
  assert.match(h.sessions.contexts[0]!.text, /\[群上下文\]/);
  assert.match(h.sessions.contexts[0]!.text, /复诊时间/);
  assert.equal(h.runtime.stats().contextMessages, 1);
  assert.equal(h.runtime.stats().turns, 0);
});

test('#63 内部员工发言与已核验正文重复时去重', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.bridge.verifiedBodies.set('wang.guwen', ['您好，明天上午十点复诊。']);

  const result = h.runtime.routeInbound(
    msg('m1', ' 您好，明天上午十点复诊。', { from: 'wang.guwen' }),
  );
  assert.equal(result.handled, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.sessions.contexts.length, 0);
  assert.equal(h.runtime.stats().duplicatesSkipped, 1);
});

test('#63 内部上下文会带进下一轮患者回合的提示词', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  let prompt = '';
  h.sessions.onPrompt = async (sessionId, text) => {
    prompt = text;
    await h.runtime.replySkip(sessionId, { reason: '测试' });
  };

  h.runtime.routeInbound(msg('m1', '复诊时间改到周五了', { from: 'wang.guwen' }));
  await new Promise((resolve) => setImmediate(resolve));
  h.runtime.routeInbound(msg('m2', '那我周五来'));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.sessions.prompts.length, 1);
  assert.match(prompt, /【近期群内上下文/);
  assert.match(prompt, /复诊时间改到周五了/);
});

test('#63 家属发言：提示模型不能当作患者本人事实', async () => {
  const h = setupRuntime();
  const group = observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  const member = h.store.findMember(group.id, 'wm_patient');
  assert.ok(member);
  h.service.annotateMember(group.id, member.id, 'family');

  let prompt = '';
  h.sessions.onPrompt = async (sessionId, text) => {
    prompt = text;
    await h.runtime.replySkip(sessionId, { reason: '测试' });
  };
  h.runtime.routeInbound(msg('m1', '我妈今天头晕'));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.match(prompt, /本次发言人是「家属」/);
  assert.match(prompt, /不能把内容直接当作患者本人的事实/);
});

test('#63 collect_only 群的消息只写上下文，不产出草稿', async () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'collect_only', advisorId: 'adv_1' });

  const result = h.runtime.routeInbound(msg('m1', '随便聊聊'));
  assert.equal(result.handled, true);
  assert.equal(result.decision.action, 'context');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.sessions.prompts.length, 0);
  assert.equal(h.sessions.contexts.length, 1);
  assert.equal(h.bridge.enqueued.length, 0);
});

test('#63 pending 群只登记、不自动服务；未知群交回旧链路', () => {
  const h = setupRuntime();
  observeServiceGroup(h); // 默认 pending

  const pending = h.runtime.routeInbound(msg('m1', '你好'));
  assert.equal(pending.handled, true);
  assert.equal(pending.decision.action, 'ignore');
  assert.equal(pending.decision.reason, 'GROUP_PENDING');
  assert.equal(h.bridge.enqueued.length, 0);

  const unknown = h.runtime.routeInbound({ ...msg('m2', '你好'), roomId: 'wr_unknown' });
  assert.equal(unknown.handled, false);
  assert.equal(unknown.decision.reason, 'GROUP_UNKNOWN');
});

test('#63 后到的消息短于静默窗口时合并定时器必须重排，不能把这批消息卡死', async () => {
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const h = setupRuntime({
    schedule: (fn, delayMs) => {
      const timer = { fn, delay: delayMs };
      timers.push(timer);
      return timer;
    },
  });
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '测试' });
  };

  const base = h.clock.now();
  // 第一条先到，定时器按它建好
  h.runtime.routeInbound(msg('m1', '我今天', { msgtime: base }));
  // 10 秒后第二条才到。此时不能重置定时器，但它到点后必须按剩余时间重排
  h.clock.set(base + 10_000);
  h.runtime.routeInbound(msg('m2', '吃了火锅', { msgtime: base + 10_000 }));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 30_000);

  // 第一个定时器在“最后一条消息”之后只有 20 秒就响，尚未满静默窗口
  h.clock.set(base + 30_000);
  timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sessions.prompts.length, 0, '未满静默窗口不应放行');
  assert.equal(timers.length, 1, '必须按剩余时间重排定时器');
  assert.equal(timers[0]!.delay, 10_000);

  // 静默窗口满 30 秒后放行
  h.clock.set(base + 40_000);
  timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sessions.prompts.length, 1);
  assert.equal(h.runtime.stats().mergedBatches, 1);
  assert.equal(timers.length, 0);
});
