import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import { MemoryService } from '../src/p1/memory.ts';
import type { MemoryBackend, MemoryRecord } from '../src/p1/memory.ts';
import { buildMemoryToolDefinitions } from '../src/p1/memory-tools.ts';
import { parseMemoryConfig } from '../plugins/zhiban-memory/config.ts';
import { observeServiceGroup, setupRuntime, SETTINGS } from './p1-helpers.ts';

class MemoryBackendFake implements MemoryBackend {
  readonly records = new Map<string, MemoryRecord>();
  failWrites = false;

  load(): MemoryRecord[] {
    return [...this.records.values()];
  }

  async put(record: MemoryRecord): Promise<void> {
    if (this.failWrites) throw new Error('DISK_FULL');
    this.records.set(record.id, { ...record });
  }
}

function setupMemory(overrides: { injectLimit?: number; tenantId?: string } = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const backend = new MemoryBackendFake();
  let seq = 0;
  const persistErrors: string[] = [];
  const service = new MemoryService({
    tenantId: overrides.tenantId ?? 'tn_test',
    backend,
    injectLimit: overrides.injectLimit,
    sandbox: true,
    now: () => clock.now(),
    newId: (prefix) => `${prefix}_${++seq}`,
    onPersistError: (error) => persistErrors.push(error.message),
  });
  return { clock, backend, service, persistErrors };
}

test('#35 写入记忆：校验分类/内容/主题，来源消息会保留', () => {
  const { service } = setupMemory();
  const record = service.write({
    patientId: 'pat_1',
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    sourceMsgId: 'm_1',
    sourceText: '我对海鲜过敏',
    createdBy: 'agent',
  });

  assert.match(record.id, /^mem_/);
  assert.equal(record.tenantId, 'tn_test');
  assert.equal(record.sandbox, true);
  assert.equal(record.createdAt, 1_700_000_000_000);
  assert.equal(record.sourceMsgId, 'm_1');
  assert.equal(record.sourceText, '我对海鲜过敏');

  assert.throws(
    () =>
      service.write({
        patientId: 'pat_1',
        category: 'nope' as never,
        content: 'x',
        subject: 'self',
        createdBy: 'agent',
      }),
    /INVALID_CATEGORY|category/,
  );
  assert.throws(
    () =>
      service.write({
        patientId: 'pat_1',
        category: 'other',
        content: '   ',
        subject: 'self',
        createdBy: 'agent',
      }),
    /EMPTY_CONTENT|不能为空/,
  );
  assert.throws(
    () =>
      service.write({
        patientId: 'pat_1',
        category: 'other',
        content: 'x'.repeat(201),
        subject: 'self',
        createdBy: 'agent',
      }),
    /CONTENT_TOO_LONG|200/,
  );
  assert.throws(
    () =>
      service.write({
        patientId: 'pat_1',
        category: 'other',
        content: 'x',
        subject: 'stranger' as never,
        createdBy: 'agent',
      }),
    /INVALID_SUBJECT|subject/,
  );
});

test('#35 同一句话不重复记；改口时 update 保留来源并写审计', () => {
  const { service } = setupMemory();
  const first = service.upsertFact({
    patientId: 'pat_1',
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    sourceMsgId: 'm_1',
    createdBy: 'agent',
  });
  const second = service.upsertFact({
    patientId: 'pat_1',
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    sourceMsgId: 'm_2',
    createdBy: 'agent',
  });
  assert.equal(second.id, first.id);
  assert.equal(second.sourceMsgId, 'm_2');
  assert.equal(service.list('pat_1').length, 1);

  const updated = service.update(first.id, { content: '对虾蟹过敏' }, 'staff', 'acc_1');
  assert.equal(updated.content, '对虾蟹过敏');
  assert.equal(updated.sourceMsgId, 'm_2');
  assert.equal(updated.revisedAt, 1_700_000_000_000);
  assert.equal(updated.updatedBy, 'staff');
  assert.equal(updated.updatedById, 'acc_1');

  const actions = service.audits().map((event) => event.action);
  assert.deepEqual(actions, ['memory.write', 'memory.update', 'memory.update']);
  assert.equal(service.audits().at(-1)?.actor, 'staff');
});

test('#35 软删除后 list/render 不再引用，但记录与审计仍在', () => {
  const { service } = setupMemory();
  const record = service.write({
    patientId: 'pat_1',
    category: 'goal',
    content: '三个月减重 5 公斤',
    subject: 'self',
    createdBy: 'agent',
  });

  service.remove(record.id, 'staff', 'acc_1');

  assert.equal(service.list('pat_1').length, 0);
  assert.equal(service.list('pat_1', { includeDeleted: true }).length, 1);
  assert.deepEqual(service.render('pat_1'), []);
  assert.equal(service.get(record.id)?.deletedAt, 1_700_000_000_000);
  assert.equal(service.get(record.id)?.deletedBy, 'acc_1');
  assert.equal(service.audits().at(-1)?.action, 'memory.delete');
  assert.throws(() => service.remove('mem_missing'), /NOT_FOUND/);
});

test('#35 每轮注入按分类分组、带 id 与主题，受 injectLimit 限制', () => {
  const { service } = setupMemory({ injectLimit: 2 });
  service.write({
    patientId: 'pat_1',
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    createdBy: 'agent',
  });
  service.write({
    patientId: 'pat_1',
    category: 'family',
    content: '女儿上小学',
    subject: 'family',
    createdBy: 'agent',
  });
  service.write({
    patientId: 'pat_1',
    category: 'goal',
    content: '控糖',
    subject: 'self',
    createdBy: 'agent',
  });

  const lines = service.render('pat_1').join('\n');
  assert.match(lines, /饮食禁忌\/过敏/);
  assert.match(lines, /\[mem_1\] 对海鲜过敏（本人）/);
  // 按分类排序后取前 2 条：dietary_taboo → goal；family 被上限截掉
  assert.match(lines, /\[mem_3\] 控糖（本人）/);
  assert.doesNotMatch(lines, /女儿上小学/);
  assert.deepEqual(service.render('pat_other'), []);
});

test('#35 落盘失败不阻塞路由，错误交给告警回调', async () => {
  const { backend, service, persistErrors } = setupMemory();
  backend.failWrites = true;
  const record = service.write({
    patientId: 'pat_1',
    category: 'routine',
    content: '每天 7 点起床',
    subject: 'self',
    createdBy: 'agent',
  });
  await service.flush();
  assert.equal(service.get(record.id)?.content, '每天 7 点起床');
  assert.deepEqual(persistErrors, ['DISK_FULL']);
});

test('#35 工具定义：会话缺失、参数校验、写入与列表', async () => {
  const { service } = setupMemory();
  const tools = buildMemoryToolDefinitions({
    contextForSession: (sessionId) =>
      sessionId === 'session_pat_1'
        ? { patientId: 'pat_1', sourceMsgId: 'm_9', defaultSubject: 'self' }
        : undefined,
    write: (sessionId, input) => {
      const context = { patientId: 'pat_1' };
      assert.equal(sessionId, 'session_pat_1');
      return service.write({
        patientId: context.patientId,
        category: input.category,
        content: input.content,
        subject: input.subject,
        sourceMsgId: input.sourceMsgId,
        sourceText: input.sourceText,
        createdBy: 'agent',
      });
    },
    update: (_sessionId, input) => service.update(input.id, input),
    list: (_sessionId, input) => service.list('pat_1', { category: input.category }),
  });

  const write = tools.find((tool) => tool.name === 'memory_write')!;
  const update = tools.find((tool) => tool.name === 'memory_update')!;
  const list = tools.find((tool) => tool.name === 'memory_list')!;
  assert.ok(write && update && list);

  const args = {
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    sourceText: '我对海鲜过敏',
  };
  await assert.rejects(write.execute(args, { agent: undefined }), /INVALID_TOOL_ARGS .*会话/);
  await assert.rejects(
    write.execute({ ...args, category: 'bad' }, { agent: { id: 'session_pat_1' } }),
    /INVALID_TOOL_ARGS .*category/,
  );
  await assert.rejects(
    write.execute(args, { agent: { id: 'session_unknown' } }),
    /INVALID_TOOL_ARGS .*没有关联患者/,
  );

  const result = (await write.execute(args, { agent: { id: 'session_pat_1' } })) as {
    id: string;
    content: string;
  };
  assert.equal(result.content, '对海鲜过敏');
  assert.equal(service.get(result.id)?.sourceMsgId, 'm_9');

  const listed = (await list.execute({}, { agent: { id: 'session_pat_1' } })) as {
    items: Array<{ id: string }>;
  };
  assert.equal(listed.items.length, 1);

  const updated = (await update.execute(
    { id: result.id, content: '对虾蟹过敏' },
    { agent: { id: 'session_pat_1' } },
  )) as { content: string };
  assert.equal(updated.content, '对虾蟹过敏');

  await assert.rejects(
    update.execute({ id: result.id }, { agent: { id: 'session_pat_1' } }),
    /INVALID_TOOL_ARGS/,
  );
});

test('#35 患者回合注入记忆，草稿引用 id 原样进入 C2', async () => {
  const { service } = setupMemory();
  service.write({
    patientId: 'pat_1',
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    createdBy: 'agent',
  });
  const memory = {
    available: () => true,
    render: (patientId: string) => service.render(patientId),
  };
  const h = setupRuntime({ memory, capabilities: () => ({ memory: true, care: false }) });
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, {
      body: '今晚建议清蒸鱼和杂粮饭，避开海鲜。',
      inboundSummary: '问晚饭',
      riskLevel: 'low',
      citedMemoryIds: ['mem_1'],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound({
    msgid: 'm_1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '晚上吃什么？',
    msgtime: h.clock.now(),
  });
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  const prompt = h.sessions.prompts[0]?.text ?? '';
  assert.match(prompt, /患者长期记忆/);
  assert.match(prompt, /对海鲜过敏/);
  assert.equal(h.bridge.enqueued[0]?.source, 'inbound');
  assert.deepEqual(h.bridge.enqueued[0]?.inboundMessageIds, ['m_1']);

  const system = h.runtime.systemPrompt();
  assert.match(system, /memory_write/);
  assert.match(system, /家属说的事 subject=family/);
});

test('#35 未安装记忆插件时提示词不出现记忆工具，且不注入记忆', async () => {
  const h = setupRuntime({ capabilities: () => ({ memory: false, care: false }) });
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '无需回复' });
  };
  h.runtime.routeInbound({
    msgid: 'm_1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '你好',
    msgtime: h.clock.now(),
  });
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.doesNotMatch(h.sessions.prompts[0]?.text ?? '', /患者长期记忆/);
  assert.doesNotMatch(h.runtime.systemPrompt(), /memory_write/);
});

test('#35 家属发言：记忆工具默认 subject=family，来源指向该消息', async () => {
  const h = setupRuntime();
  const group = observeServiceGroup(h, {
    status: 'serving',
    advisorId: 'adv_1',
    externalIds: ['wm_patient', 'wm_family'],
  });
  const familyMember = h.store.findMember(group.id, 'wm_family');
  assert.ok(familyMember);
  h.service.annotateMember(group.id, familyMember.id, 'family');
  let context: unknown;
  h.sessions.onPrompt = async (sessionId) => {
    context = h.runtime.patientContextForSession(sessionId);
    await h.runtime.replySkip(sessionId, { reason: '家属发言' });
  };

  h.runtime.routeInbound({
    msgid: 'm_family',
    roomId: 'wr_g1',
    from: 'wm_family',
    text: '我妈对海鲜过敏',
    msgtime: h.clock.now(),
  });
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.deepEqual(context, {
    patientId: 'pat_1',
    sourceMsgId: 'm_family',
    defaultSubject: 'family',
  });
  assert.notEqual(SETTINGS.agentName, '');
});

test('#35 回合内调用 memory_write：来源消息正确，下一轮自动注入', async () => {
  const { service } = setupMemory();
  const h = setupRuntime({
    memory: { available: () => true, render: (patientId) => service.render(patientId) },
    capabilities: () => ({ memory: true, care: false }),
  });
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });

  const tools = buildMemoryToolDefinitions({
    contextForSession: (sessionId) => h.runtime.patientContextForSession(sessionId),
    write: (sessionId, input) => {
      const context = h.runtime.patientContextForSession(sessionId)!;
      return service.upsertFact({
        patientId: context.patientId,
        category: input.category,
        content: input.content,
        subject: input.subject,
        sourceMsgId: input.sourceMsgId,
        sourceText: input.sourceText,
        createdBy: 'agent',
      });
    },
    update: (_sessionId, input) => service.update(input.id, input),
    list: (sessionId, input) => {
      const context = h.runtime.patientContextForSession(sessionId)!;
      return service.list(context.patientId, { category: input.category });
    },
  });
  const writeTool = tools.find((tool) => tool.name === 'memory_write')!;

  h.sessions.onPrompt = async (sessionId) => {
    await writeTool.execute(
      { category: 'dietary_taboo', content: '对海鲜过敏', subject: 'self', sourceText: '我对海鲜过敏' },
      { agent: { id: sessionId } },
    );
    await h.runtime.replySkip(sessionId, { reason: '已记录' });
  };
  h.runtime.routeInbound({
    msgid: 'm_allergy',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '我对海鲜过敏',
    msgtime: h.clock.now(),
  });
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  const [record] = service.list('pat_1');
  assert.ok(record);
  assert.equal(record.category, 'dietary_taboo');
  assert.equal(record.subject, 'self');
  assert.equal(record.sourceMsgId, 'm_allergy');
  assert.equal(record.sourceText, '我对海鲜过敏');

  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replyDraft(sessionId, {
      body: '今晚可以吃清蒸鱼和杂粮饭，避开海鲜。',
      inboundSummary: '问晚饭',
      riskLevel: 'low',
      citedMemoryIds: [record.id],
      citedKnowledgeIds: [],
    });
  };
  h.runtime.routeInbound({
    msgid: 'm_dinner',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '晚上吃什么？',
    msgtime: h.clock.now(),
  });
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  const prompt = h.sessions.prompts.at(-1)?.text ?? '';
  assert.match(prompt, /\[mem_1\] 对海鲜过敏（本人）/);
  assert.deepEqual(h.bridge.enqueued[0]?.citedMemoryIds, [record.id]);
});

test('#35 删除记忆后下一轮不再注入', () => {
  const { service } = setupMemory();
  const record = service.write({
    patientId: 'pat_1',
    category: 'dietary_taboo',
    content: '对海鲜过敏',
    subject: 'self',
    createdBy: 'agent',
  });
  assert.match(service.render('pat_1').join('\n'), /对海鲜过敏/);
  service.remove(record.id, 'staff', 'acc_1');
  assert.deepEqual(service.render('pat_1'), []);
});

test('zhiban-memory 配置：租户必填、注入上限范围、sandbox', () => {
  const config = parseMemoryConfig({ tenantId: 'tn_1' });
  assert.equal(config.tenantId, 'tn_1');
  assert.equal(config.sandbox, false);
  assert.equal(config.injectLimit, 30);

  assert.equal(
    parseMemoryConfig({ tenantId: 'tn_1', sandbox: true, injectLimit: 5 }).injectLimit,
    5,
  );
  assert.throws(() => parseMemoryConfig({}), /tenantId|缺少配置项/);
  assert.throws(() => parseMemoryConfig({ tenantId: 'tn_1', injectLimit: 0 }), /injectLimit/);
  assert.throws(() => parseMemoryConfig({ tenantId: 'tn_1', sandbox: 'yes' }), /sandbox/);
  assert.throws(() => parseMemoryConfig(null), /必须是对象/);
});
