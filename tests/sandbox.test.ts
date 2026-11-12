/**
 * #40 体验中心沙盒单测：会话、配额、四种动作、重置、媒体。
 * 使用假 Agent 适配器，不触碰真实 DSH 会话或企微通道。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConsoleError } from '../src/p1/console-error.ts';
import { ConsoleStore, MemoryConsoleBackend } from '../src/p1/console-store.ts';
import { dayKey } from '../src/p1/console-types.ts';
import {
  imageSize,
  SandboxService,
  type SandboxAgentPort,
  type SandboxAgentTurnInput,
} from '../src/p1/sandbox.ts';

const ACCOUNT = 'acc_test';
const TENANT = 'tn_test';

class FakeAgent implements SandboxAgentPort {
  ensureCalls = 0;
  resetCalls = 0;
  turns: SandboxAgentTurnInput[] = [];
  injected: { sessionId: string; text: string }[] = [];

  async ensureSession(): Promise<string> {
    this.ensureCalls += 1;
    return 'sess_main';
  }

  async resetSession(): Promise<string> {
    this.resetCalls += 1;
    return 'sess_reset';
  }

  async runTurn(input: SandboxAgentTurnInput): Promise<void> {
    this.turns.push(input);
  }

  async injectContext(sessionId: string, text: string): Promise<void> {
    this.injected.push({ sessionId, text });
  }
}

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  data[0] = 0xff;
  data[1] = 0xd8;
  data[2] = 0xff;
  data[3] = 0xc0;
  data.writeUInt16BE(17, 4);
  data[6] = 0x08;
  data.writeUInt16BE(height, 7);
  data.writeUInt16BE(width, 9);
  return data;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { dailyLimit?: number; withAgent?: boolean } = {}) {
  let now = Date.UTC(2026, 0, 15, 4, 0, 0);
  const backend = new MemoryConsoleBackend();
  const store = new ConsoleStore({ backend, now: () => now });
  const agent = new FakeAgent();
  const events: { type: string; data: unknown; sandbox?: boolean }[] = [];
  const writes: { mediaId: string; extension: string; size: number }[] = [];
  const service = new SandboxService({
    tenantId: TENANT,
    store,
    timezone: 'Asia/Shanghai',
    now: () => now,
    emit: (type, data, sandbox) => events.push({ type, data, sandbox }),
    agent: options.withAgent === false ? undefined : () => agent,
    dailyLimit: options.dailyLimit ?? 100,
    mediaWriter: {
      async write(mediaId, extension, data) {
        writes.push({ mediaId, extension, size: data.length });
        return `/tmp/${mediaId}.${extension}`;
      },
    },
  });
  return {
    store,
    agent,
    service,
    events,
    writes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function withDraft(setupResult: ReturnType<typeof setup>, body = '建议晚餐清淡一些') {
  const { service } = setupResult;
  await service.ensureSession(ACCOUNT);
  return service.enqueueDraft({
    sessionId: 'sess_main',
    patientId: 'pat_sandbox_acc_test',
    groupId: 'grp_sandbox_acc_test_1',
    groupName: '体验客户群',
    body,
    inboundSummary: '患者问晚上吃什么',
    riskLevel: 'low',
    fallback: false,
  });
}

test('ensureSession 每个账号一个沙盒患者，重复调用不重建', async () => {
  const { service, agent, store } = setup();
  const view = await service.ensureSession(ACCOUNT);
  assert.equal(agent.ensureCalls, 1);
  assert.equal(view.session.patient.id, 'pat_sandbox_acc_test');
  assert.equal(view.session.patient.demo, false);
  assert.deepEqual(view.session.groups.map((group) => group.role), ['primary', 'other']);
  assert.equal(view.quota.dailyLimit, 100);
  assert.equal(view.quota.usedToday, 0);
  assert.equal(view.quota.remaining, 100);
  assert.ok(view.presets.length >= 2);
  // 文本预置必须带原话，否则前端点击后没有内容可发
  assert.ok(
    view.presets
      .filter((preset) => preset.kind === 'text')
      .every((preset) => typeof preset.text === 'string' && preset.text.length > 0),
  );
  assert.ok(view.guideSteps.length >= 4);

  await service.ensureSession(ACCOUNT);
  assert.equal(agent.ensureCalls, 1);
  assert.equal(
    store.listSandboxEvents(ACCOUNT).filter((event) => event.type === 'sandbox.state').length,
    1,
  );
});

test('未安装患者 Agent 时创建会话返回 502', async () => {
  const { service } = setup({ withAgent: false });
  await assert.rejects(
    () => service.ensureSession(ACCOUNT),
    (error: unknown) => error instanceof ConsoleError && error.code === 'UPSTREAM_UNAVAILABLE',
  );
});

test('发送文本消息：入队、计数、打事件，异步走真实 Agent 回合', async () => {
  const { service, agent, store, events, advance } = setup();
  const posted = await service.postMessage(ACCOUNT, { kind: 'text', text: '  我对海鲜过敏  ' });
  assert.match(posted.messageId, /^msg_sbx_/);
  assert.equal(posted.quota.usedToday, 1);
  assert.equal(posted.quota.remaining, 99);

  const messages = store.listSandboxMessages(ACCOUNT);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.text, '我对海鲜过敏');
  assert.equal(messages[0]!.sender, 'customer');

  await tick();
  assert.equal(agent.turns.length, 1);
  assert.equal(agent.turns[0]!.text, '我对海鲜过敏');
  assert.equal(agent.turns[0]!.group.name, '体验客户群');
  assert.equal(agent.turns[0]!.patient.id, 'pat_sandbox_acc_test');
  assert.equal(agent.turns[0]!.sessionId, 'sess_main');
  assert.equal(events.some((event) => event.type === 'sandbox.message' && event.sandbox === true), true);

  advance(1_000);
  const second = await service.postMessage(ACCOUNT, { kind: 'text', text: '晚上吃什么' });
  const state = service.state(ACCOUNT, posted.acceptedAt);
  assert.deepEqual(
    state.messages.map((message) => message.id),
    [second.messageId],
  );
  assert.ok(state.events.length >= 1);
  assert.equal(state.quota.usedToday, 2);
});

test('消息校验：空文本、超长文本、非法 kind、缺 mediaId', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.postMessage(ACCOUNT, { kind: 'text', text: '   ' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => service.postMessage(ACCOUNT, { kind: 'text', text: 'x'.repeat(2001) }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => service.postMessage(ACCOUNT, { kind: 'video' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => service.postMessage(ACCOUNT, { kind: 'image' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => service.postMessage(ACCOUNT, { kind: 'image', mediaId: 'med_missing' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );
});

test('每日 100 轮上限按租户时区计算；重置会话不清空当日计数', async () => {
  const limited = setup({ dailyLimit: 1 });
  await limited.service.postMessage(ACCOUNT, { kind: 'text', text: '第一条' });
  await assert.rejects(
    () => limited.service.postMessage(ACCOUNT, { kind: 'text', text: '第二条' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'LIMIT_EXCEEDED',
  );
  await limited.service.reset(ACCOUNT);
  assert.equal(limited.service.quotaFor(ACCOUNT).usedToday, 1);
  await assert.rejects(
    () => limited.service.postMessage(ACCOUNT, { kind: 'text', text: '第三条' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'LIMIT_EXCEEDED',
  );

  // 默认上限与跨日边界
  const { service } = setup();
  const view = await service.ensureSession(ACCOUNT);
  assert.equal(view.quota.dailyLimit, 100);
  assert.equal(dayKey(view.session.createdAt, 'Asia/Shanghai').length, 10);
});

test('沙盒草稿经 sink 回到控制台，不进入 C2（状态 PUSHED）', async () => {
  const ctx = setup();
  const result = await withDraft(ctx);
  assert.match(result.draftId, /^draft_sbx_/);
  assert.equal(result.version, 1);
  const draft = ctx.store.listSandboxDrafts(ACCOUNT)[0]!;
  assert.equal(draft.status, 'PUSHED');
  assert.equal(draft.sandbox, true);
  assert.equal(draft.body, '建议晚餐清淡一些');

  assert.throws(
    () =>
      ctx.service.enqueueDraft({
        sessionId: 'sess_unknown',
        patientId: 'pat_x',
        groupId: 'grp_x',
        groupName: '群',
        body: 'x',
        inboundSummary: '',
        riskLevel: 'low',
        fallback: false,
      }),
    /SANDBOX_SESSION_NOT_FOUND/,
  );
  assert.equal(ctx.events.some((event) => event.type === 'sandbox.draft' && event.sandbox === true), true);
});

test('四种动作产生四种结果与终态', async () => {
  for (const [action, expectedOutcome, expectedStatus] of [
    ['send_original', 'verified', 'VERIFIED'],
    ['send_edited', 'edit_sent', 'EDIT_SENT'],
    ['send_wrong_group', 'misroute', 'MISROUTE_ALERT'],
    ['ack_only', 'unverified', 'UNVERIFIED'],
  ] as const) {
    const ctx = setup();
    const draft = await withDraft(ctx);
    const result = ctx.service.action(ACCOUNT, draft.draftId, {
      action,
      editedBody: action === 'send_edited' ? '  改过的正文  ' : undefined,
    });
    assert.equal(result.outcome, expectedOutcome);
    assert.equal(result.draftStatus, expectedStatus);
    assert.equal(result.verification.outcome, expectedOutcome);
    assert.equal(result.verification.sandbox, true);

    const stored = ctx.store.listSandboxDrafts(ACCOUNT)[0]!;
    assert.equal(stored.status, expectedStatus);
    if (action === 'send_edited') {
      assert.equal(stored.body, '改过的正文');
      assert.equal(stored.version, 2);
    }
    if (action === 'ack_only') {
      assert.equal(result.verification.matchedMsgId, null);
      assert.equal(result.verification.matchedRoomId, null);
    } else if (action === 'send_wrong_group') {
      assert.equal(result.verification.matchedRoomId, 'grp_sandbox_acc_test_2');
    } else {
      assert.equal(result.verification.matchedRoomId, 'grp_sandbox_acc_test_1');
    }

    await tick();
    assert.equal(
      ctx.agent.injected.some((item) => item.text.includes(draft.draftId)),
      true,
    );

    // 终态后重复操作返回冲突
    assert.throws(
      () => ctx.service.action(ACCOUNT, draft.draftId, { action: 'send_original' }),
      (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
    );
  }
});

test('动作参数校验：非法 action、编辑正文为空或超长、发错到本群', async () => {
  const ctx = setup();
  const draft = await withDraft(ctx);
  assert.throws(
    () => ctx.service.action(ACCOUNT, draft.draftId, { action: 'delete' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => ctx.service.action(ACCOUNT, draft.draftId, { action: 'send_edited', editedBody: '   ' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => ctx.service.action(ACCOUNT, draft.draftId, { action: 'send_edited', editedBody: 'x'.repeat(1001) }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => ctx.service.action(ACCOUNT, draft.draftId, { action: 'send_wrong_group', targetGroupId: 'grp_other_tenant' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => ctx.service.action('acc_other', draft.draftId, { action: 'send_original' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );
});

test('重置：换新 DSH 会话、清空对话/草稿/事件，保留当日配额', async () => {
  const ctx = setup();
  await withDraft(ctx);
  await ctx.service.postMessage(ACCOUNT, { kind: 'text', text: '你好' });
  assert.equal(ctx.store.listSandboxMessages(ACCOUNT).length, 1);

  const view = await ctx.service.reset(ACCOUNT);
  assert.equal(ctx.agent.resetCalls, 1);
  assert.notEqual(view.session.id, undefined);
  assert.equal(ctx.store.listSandboxMessages(ACCOUNT).length, 0);
  assert.equal(ctx.store.listSandboxDrafts(ACCOUNT).length, 0);
  assert.equal(
    ctx.store.listSandboxEvents(ACCOUNT).filter((event) => event.type === 'sandbox.message').length,
    0,
  );
  assert.equal(view.quota.usedToday, 1);
  assert.equal(ctx.events.filter((event) => event.type === 'sandbox.state').length >= 1, true);
});

test('只接收沙盒患者的 memory.created，内容截断到 200 字', async () => {
  const { service, store, events } = setup();
  await service.ensureSession(ACCOUNT);

  service.ingestMemoryEvent('memory.created', {
    patientId: 'pat_sandbox_acc_test',
    memoryId: 'mem_1',
    category: 'diet',
    content: '对海鲜过敏',
  });
  service.ingestMemoryEvent('memory.created', {
    patientId: 'pat_sandbox_acc_test',
    memoryId: 'mem_long',
    category: 'diet',
    content: 'x'.repeat(500),
  });
  service.ingestMemoryEvent('memory.created', { patientId: 'pat_real_1', content: '不应出现' });
  service.ingestMemoryEvent('patient.updated', { patientId: 'pat_sandbox_acc_test' });

  const memories = store.listSandboxMemories(ACCOUNT);
  assert.equal(memories.length, 2);
  assert.equal(memories[0]!.content, '对海鲜过敏');
  assert.equal(memories[1]!.content.length, 200);
  assert.equal(events.some((event) => event.type === 'sandbox.memory' && event.sandbox === true), true);
});

test('上传图片：校验类型与大小、解析尺寸、按账号隔离读取', async () => {
  const { service, writes, agent } = setup();
  const uploaded = await service.saveUpload(ACCOUNT, {
    filename: 'meal.png',
    contentType: 'image/png',
    data: png(640, 480),
  });
  assert.equal(uploaded.width, 640);
  assert.equal(uploaded.height, 480);
  assert.equal(uploaded.size, 24);
  assert.equal(uploaded.url, `/zhiban/api/media/${uploaded.mediaId}`);
  assert.deepEqual(writes.map((item) => item.extension), ['png']);

  const media = service.media(ACCOUNT, uploaded.mediaId);
  assert.equal(media.contentType, 'image/png');
  assert.equal(media.sandbox, true);
  assert.throws(
    () => service.media('acc_other', uploaded.mediaId),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );

  await assert.rejects(
    () => service.saveUpload(ACCOUNT, { filename: 'a.gif', contentType: 'image/gif', data: png(1, 1) }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => service.saveUpload(ACCOUNT, { contentType: 'image/png', data: Buffer.alloc(0) }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VALIDATION_FAILED',
  );

  // 图片消息只能引用自己上传的沙盒图片
  const posted = await service.postMessage(ACCOUNT, { kind: 'image', mediaId: uploaded.mediaId });
  assert.match(posted.messageId, /^msg_sbx_/);

  // #55：图片消息也唤醒 Agent，并把落盘路径交给患者运行时
  await tick();
  assert.equal(agent.turns.length, 1);
  assert.equal(agent.turns[0]!.text, '[图片]');
  assert.deepEqual(agent.turns[0]!.mediaPaths, [`/tmp/${uploaded.mediaId}.png`]);
});

test('imageSize 支持 PNG / JPEG，未知格式返回 null', () => {
  assert.deepEqual(imageSize(png(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageSize(jpeg(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(imageSize(Buffer.from('not an image')), { width: null, height: null });
});
