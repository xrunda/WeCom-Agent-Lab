import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, MockBot } from '../src/c2/memory.ts';
import { C2Service } from '../src/c2/service.ts';
import type { ArchiveTrigger } from '../src/c2/trigger.ts';
import type { Patient, PatientSessionRecord } from '../src/p1/types.ts';
import { parsePluginConfig } from '../plugins/zhiban-wecom/config.ts';
import { DomainStore, MemoryStoreBackend } from '../plugins/zhiban-wecom/domain.ts';
import { WecomRuntime } from '../plugins/zhiban-wecom/runtime.ts';
import type { PatientSink } from '../plugins/zhiban-wecom/runtime.ts';
import { parsePatientConfig } from '../plugins/zhiban-patient/config.ts';
import { LazyPatientBridge } from '../plugins/zhiban-patient/index.ts';
import { DshPatientSessions } from '../plugins/zhiban-patient/sessions.ts';
import type { SessionControllerLike } from '../plugins/zhiban-patient/sessions.ts';

const ADV = 'adv_1';

function wecomConfig() {
  return parsePluginConfig(
    {
      environment: 'demo',
      demoBotId: 'demo-bot',
      botId: 'demo-bot',
      botSecret: 'secret',
      archive: {
        binaryPath: '/bin/archive_dump',
        privateKeyPath: './private_key.pem',
        configPath: './config.txt',
      },
      serviceGroupRoomIds: ['wrGROUP1'],
      advisorId: ADV,
      advisorName: '王顾问',
      advisorChatId: ADV,
      groupName: '减重-张女士',
      mediaRootDir: '/tmp/zhiban-media-unused',
    },
    {},
  );
}

function wecomHarness(patient?: PatientSink) {
  const clock = new FakeClock(1_000_000);
  const store = new DomainStore(new MemoryStoreBackend());
  const bot = new MockBot(clock);
  const archive = { getSeq: () => 0 } as never;
  const service = new C2Service({ store, bot, archive, clock });
  service.addAdvisor({ id: ADV, name: '王顾问', chatId: ADV });
  service.bindGroup({ roomId: 'wrGROUP1', name: '减重-张女士', advisorId: ADV });

  const trigger = {
    async pollWithContext() {
      return {
        internal: [
          {
            msgid: 'm_staff',
            roomid: 'wrGROUP1',
            from: 'li.colleague',
            text: '我稍后回',
            msgtime: 1_000,
          },
        ],
        events: [
          {
            group: store.getGroup('wrGROUP1')!,
            message: {
              msgid: 'm_customer',
              roomid: 'wrGROUP1',
              from: 'wmCUSTOMER',
              text: '晚上吃什么',
              msgtime: 2_000,
            },
            draft: {
              body: '模板正文',
              inboundSummary: '晚上吃什么',
              riskLevel: 'low' as const,
            },
          },
        ],
        rooms: [{ roomId: 'wrGROUP1', members: [{ id: 'wmCUSTOMER', isExternal: true, lastActiveAt: 2_000 }] }],
      };
    },
    async poll() {
      return [];
    },
  } as unknown as ArchiveTrigger;

  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const runtime = new WecomRuntime({
    store,
    service,
    archive: archive as never,
    trigger,
    bot,
    config: wecomConfig(),
    clock,
    patient,
    emit: (type, data) => events.push({ type, data }),
    logger: (line) => logs.push(line),
  });
  return { clock, store, bot, service, runtime, events, logs };
}

test('zhiban-wecom 把群与消息转交患者域，接管后不再生成模板草稿', async () => {
  const calls: string[] = [];
  const patient: PatientSink = {
    observeRooms: (rooms) => calls.push(`observe:${rooms.length}`),
    routeInbound: (message) => {
      calls.push(`route:${message.msgid}`);
      return { handled: true, decision: { action: 'turn', reason: 'SERVING' } };
    },
    handleDraftVerified: async () => undefined,
    handleAdvisorText: async () => true,
  };
  const h = wecomHarness(patient);
  h.runtime.start();
  await h.runtime.pollOnce();
  await h.runtime.stop();

  assert.deepEqual(calls, ['observe:1', 'route:m_staff', 'route:m_customer']);
  assert.equal(h.store.listDrafts().length, 0);
});

test('患者域未接管时仍走旧模板链路', async () => {
  const h = wecomHarness(undefined);
  h.runtime.start();
  await h.runtime.pollOnce();
  await h.runtime.stop();

  const drafts = h.store.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.body, '模板正文');
});

test('顾问 1:1 文本转交患者域改稿', async () => {
  const received: Array<{ userId: string; text: string }> = [];
  const patient: PatientSink = {
    observeRooms: () => undefined,
    routeInbound: () => ({ handled: true, decision: { action: 'ignore', reason: 'X' } }),
    handleDraftVerified: async () => undefined,
    handleAdvisorText: async (userId, text) => {
      received.push({ userId, text });
      return true;
    },
  };
  const h = wecomHarness(patient);
  await h.runtime.handleAdvisorMessage(ADV, '语气温和一点');
  assert.deepEqual(received, [{ userId: ADV, text: '语气温和一点' }]);
});

test('zhiban-patient 配置校验：必填、范围与默认值', () => {
  const config = parsePatientConfig({
    tenantId: 'tn_1',
    workspaceRoot: '/tmp/zhiban',
    advisorId: 'adv_1',
    advisorName: '王顾问',
    agentName: '小安',
    patientTerm: '患者',
  });
  assert.equal(config.advisorWecomUserId, 'adv_1');
  assert.equal(config.mergeWindowMs, 30_000);
  assert.equal(config.turnTimeoutMs, 15_000);
  assert.equal(config.requireConsentForTurn, false);
  assert.equal(config.settings.tone, '亲切、专业、简洁');

  assert.throws(() => parsePatientConfig({ tenantId: 'tn_1' }), /workspaceRoot|advisorId/);
  assert.throws(
    () =>
      parsePatientConfig({
        tenantId: 'tn_1',
        workspaceRoot: '/tmp/zhiban',
        advisorId: 'adv_1',
        advisorName: '王顾问',
        agentName: '小安',
        patientTerm: '患者',
        mergeWindowMs: 10,
      }),
    /mergeWindowMs/,
  );
  assert.throws(
    () =>
      parsePatientConfig({
        tenantId: 'tn_1',
        workspaceRoot: '/tmp/zhiban',
        advisorId: 'adv_1',
        advisorName: '王顾问',
        agentName: '小安',
        patientTerm: '患者',
        requireConsentForTurn: 'yes',
      }),
    /requireConsentForTurn/,
  );
});

test('患者会话适配器：按患者复用 Session、prompt 与上下文注入', async () => {
  const created: string[] = [];
  const prompts: unknown[] = [];
  const injected: unknown[] = [];
  let idle = true;
  const controller: SessionControllerLike = {
    async create(request) {
      created.push(request.cwd);
      return { sessionId: request.sessionId ?? 'session_x' };
    },
    async resolveAgent(sessionId) {
      return {
        agent: {
          async whenIdle() {
            if (!idle) await new Promise(() => undefined);
          },
          inject(message) {
            injected.push(message);
          },
        },
      };
    },
    async prompt(request) {
      prompts.push(request);
      return { accepted: true };
    },
  };
  const sessions = new Map<string, PatientSessionRecord>();
  const patient = {
    id: 'pat_1',
    displayName: '张女士',
    tenantId: 'tn_1',
    tags: [],
    consent: 'agreed',
    status: 'serving',
    demo: false,
    accompaniedSince: 0,
    createdAt: 0,
    updatedAt: 0,
  } as Patient;
  const port = new DshPatientSessions(
    { sessionController: controller },
    {
      workspaceRoot: '/tmp/zhiban-ws',
      agentPreset: 'zhiban',
      findSession: (patientId) => sessions.get(patientId),
      saveSession: (record) => sessions.set(record.patientId, record),
    },
  );

  const first = await port.ensure(patient);
  assert.equal(first.workspacePath, '/tmp/zhiban-ws/pat_1');
  assert.deepEqual(created, ['/tmp/zhiban-ws/pat_1']);

  const second = await port.ensure(patient);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(created.length, 1);

  await port.prompt(first.sessionId, '提示词');
  assert.equal((prompts[0] as { content: Array<{ text: string }> }).content[0]?.text, '提示词');

  await port.injectContext(first.sessionId, '[群上下文] 我稍后回');
  assert.equal(
    (injected[0] as { content: Array<{ text: string }> }).content[0]?.text,
    '[群上下文] 我稍后回',
  );
  assert.equal((injected[0] as { role: string }).role, 'user');

  assert.equal(await port.waitIdle(first.sessionId, 50), 'idle');
  idle = false;
  assert.equal(await port.waitIdle(first.sessionId, 20), 'timeout');
});

test('LazyPatientBridge：wecom 未就绪时读安全降级、写明确报错', async () => {
  const bridge = new LazyPatientBridge(() => undefined);
  assert.deepEqual(bridge.listVerifiedBodies('wm_x'), []);
  assert.equal(bridge.getDraft('draft_1'), undefined);
  assert.equal(bridge.getActiveDraft('adv_1'), undefined);
  await assert.rejects(
    bridge.enqueueDraft({
      advisorId: 'adv_1',
      groupRoomId: 'wr_1',
      patientId: 'pat_1',
      customerId: 'wm_x',
      customerName: '张女士',
      inboundMessageIds: ['m1'],
      mediaIds: [],
      inboundSummary: '问题',
      body: '正文',
      riskLevel: 'low',
      source: 'inbound',
      fallback: false,
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    }),
    /WECOM_BRIDGE_UNAVAILABLE/,
  );
  await assert.rejects(bridge.notifyAdvisor('提示'), /WECOM_BRIDGE_UNAVAILABLE/);
});
