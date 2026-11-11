import test from 'node:test';
import assert from 'node:assert/strict';

import { WeComArchiveAdapter } from '../src/c2/adapters/wecom-archive.ts';
import { FakeClock, MockBot } from '../src/c2/memory.ts';
import { C2Service } from '../src/c2/service.ts';
import { ArchiveTrigger } from '../src/c2/trigger.ts';
import type { Draft } from '../src/c2/types.ts';
import { parsePluginConfig, type WecomPluginConfig } from '../plugins/zhiban-wecom/config.ts';
import { DomainStore, MemoryStoreBackend } from '../plugins/zhiban-wecom/domain.ts';
import type { GroupInfoClient } from '../plugins/zhiban-wecom/group-info.ts';
import type { RoomAgreeClient } from '../plugins/zhiban-wecom/room-agree.ts';
import { WecomRuntime, makeTemplateCompose } from '../plugins/zhiban-wecom/runtime.ts';
import type { PatientSink } from '../plugins/zhiban-wecom/runtime.ts';

const CUSTOMER_TEXT = '客户说血糖有点高，晚上睡不好';
const ADV = 'adv_1';

function config(): WecomPluginConfig {
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

interface Harness {
  clock: FakeClock;
  store: DomainStore;
  bot: MockBot;
  service: C2Service;
  runtime: WecomRuntime;
  events: Array<{ type: string; data: unknown }>;
  logs: string[];
}

function harness(
  options: {
    environment?: 'demo' | 'dev';
    groupInfo?: Pick<GroupInfoClient, 'memberNames' | 'roomInfo'>;
    roomAgree?: Pick<RoomAgreeClient, 'roomConsent'>;
    patient?: PatientSink;
  } = {},
): Harness {
  const clock = new FakeClock(1_000_000);
  const store = new DomainStore(new MemoryStoreBackend());
  const pluginConfig = { ...config(), environment: options.environment ?? 'demo' };
  let pulls = 0;
  const archive = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    run: async (args) => {
      pulls += 1;
      const seq = Number(args[1]);
      if (seq === 0) {
        return JSON.stringify({
          nextSeq: 10,
          messages: [
            {
              msgid: 'msg_customer_1',
              action: 'recv',
              from: 'wmCUSTOMER',
              roomid: 'wrGROUP1',
              msgtime: clock.now() - 5_000,
              msgtype: 'text',
              text: { content: CUSTOMER_TEXT },
            },
          ],
        });
      }
      return JSON.stringify({
        nextSeq: 20 + pulls,
        messages: [
          {
            msgid: 'msg_advisor_1',
            action: 'send',
            from: ADV,
            roomid: 'wrGROUP1',
            msgtime: clock.now() - 1_000,
            msgtype: 'text',
            text: { content: makeTemplateCompose(pluginConfig)({ group: { roomId: 'wrGROUP1', name: '减重-张女士', advisorId: ADV, status: 'mapped' }, message: { msgid: 'x', roomid: 'wrGROUP1', from: 'wmCUSTOMER', text: CUSTOMER_TEXT, msgtime: 0 } })?.body ?? '' },
          },
        ],
      });
    },
  });

  const bot = new MockBot(clock);
  const service = new C2Service({ store, bot, archive, clock });
  service.addAdvisor({ id: ADV, name: '王顾问', chatId: ADV });
  service.bindGroup({ roomId: 'wrGROUP1', name: '减重-张女士', advisorId: ADV });

  const trigger = new ArchiveTrigger({
    archive,
    store,
    clock,
    compose: makeTemplateCompose(pluginConfig),
    config: { roomIds: ['wrGROUP1'], excludeSender: ADV, startedAt: 0 },
  });

  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const runtime = new WecomRuntime({
    store,
    service,
    archive,
    trigger,
    bot,
    config: pluginConfig,
    clock,
    emit: (type, data) => {
      events.push({ type, data });
    },
    logger: (line) => logs.push(line),
    groupInfo: options.groupInfo,
    roomAgree: options.roomAgree,
    patient: options.patient,
  });

  return { clock, store, bot, service, runtime, events, logs };
}

test('pollOnce 生成草稿并推送卡片 + 正文，事件按契约发出', async () => {
  const h = harness();
  h.runtime.start();
  try {
    await h.runtime.pollOnce();

    const drafts = h.store.listDrafts();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].status, 'PUSHED');
    assert.equal(h.bot.cards().length, 1);
    assert.equal(h.bot.texts().length, 1);

    const types = h.events.map((e) => e.type);
    assert.ok(types.includes('draft.created'));
    assert.ok(types.includes('draft.pushed'));
    const pushed = h.events.find((e) => e.type === 'draft.pushed')?.data as {
      draftId: string;
      status: string;
    };
    assert.equal(pushed.status, 'PUSHED');
  } finally {
    await h.runtime.stop();
  }
});

test('顾问点「已发送」后回读存档，核验事件发出', async () => {
  const h = harness();
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
    const draft = h.store.listDrafts()[0];
    assert.equal(draft.status, 'PUSHED');

    await h.runtime.handleButtonKey(`ack:${draft.id}:sent`);
    assert.equal(h.store.getDraft(draft.id)?.status, 'ACKNOWLEDGED');
    const ackReceipt = h.bot.texts().at(-1)?.message;
    assert.match(JSON.stringify(ackReceipt), /已记录「已发送」/);

    // 超过 verifyDelayMs（3 分钟）后再 tick
    h.clock.advance(200_000);
    await h.runtime.tickOnce();

    const verified = h.events.find((e) => e.type === 'draft.verified')?.data as {
      draftId: string;
      outcome: string;
    };
    assert.equal(verified.draftId, draft.id);
    assert.equal(verified.outcome, 'VERIFIED');
    assert.equal(h.store.getDraft(draft.id)?.status, 'VERIFIED');
    const verifyReceipt = h.bot.texts().at(-1)?.message;
    assert.match(JSON.stringify(verifyReceipt), /✅ 校验通过/);
  } finally {
    await h.runtime.stop();
  }
});

test('重复点击卡片按钮只忽略，不报错、不重复发事件', async () => {
  const h = harness();
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
    const draft = h.store.listDrafts()[0];
    await h.runtime.handleButtonKey(`ack:${draft.id}:sent`);
    const before = h.events.filter((e) => e.type === 'draft.acked').length;

    await h.runtime.handleButtonKey(`ack:${draft.id}:sent`);

    const after = h.events.filter((e) => e.type === 'draft.acked').length;
    assert.equal(after, before);
  } finally {
    await h.runtime.stop();
  }
});

test('停机超过阈值时发出 DOWNTIME 告警并写审计', async () => {
  const h = harness();
  h.store.setMeta('last_run_at', h.clock.now() - 20 * 60_000);
  h.runtime.start({ downtimeGapMs: 20 * 60_000 });
  try {
    const alert = h.store.listAlerts().find((a) => a.kind === 'DOWNTIME');
    assert.ok(alert);
    assert.ok(h.events.some((e) => e.type === 'alert.created'));
    assert.ok(h.store.listAudit().some((a) => a.action === 'downtime'));
  } finally {
    await h.runtime.stop();
  }
});

test('demo 长连接被关闭时告警；dev 只记日志', async () => {
  const demo = harness({ environment: 'demo' });
  demo.runtime.handleBotClose(4001);
  assert.ok(demo.store.listAlerts().some((a) => a.kind === 'BOT_DISCONNECTED'));

  const dev = harness({ environment: 'dev' });
  dev.runtime.handleBotClose(4001);
  assert.equal(dev.store.listAlerts().length, 0);
});

test('存档 seq 与最后运行时刻落盘', async () => {
  const h = harness();
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
    await h.runtime.stop();

    const seq = h.store.getMeta<number>('archive_seq');
    assert.equal(seq, 10);
    assert.equal(typeof h.store.getMeta<number>('last_run_at'), 'number');
  } finally {
    // stop 已调用；这里再调用是幂等的
    await h.runtime.stop();
  }
});

test('运行日志不出现客户消息正文', async () => {
  const h = harness();
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
    const output = h.logs.join('\n');
    assert.ok(!output.includes(CUSTOMER_TEXT), output);
  } finally {
    await h.runtime.stop();
  }
});

test('重启后旧卡片仍能确认（草稿从领域存储恢复）', async () => {
  const backend = new MemoryStoreBackend();
  const clock = new FakeClock(1_000_000);
  const pluginConfig = config();
  const run = async (args: string[]): Promise<string> => {
    const seq = Number(args[1]);
    if (seq === 0) {
      return JSON.stringify({
        nextSeq: 10,
        messages: [
          {
            msgid: 'msg_customer_1',
            action: 'recv',
            from: 'wmCUSTOMER',
            roomid: 'wrGROUP1',
            msgtime: clock.now() - 5_000,
            msgtype: 'text',
            text: { content: CUSTOMER_TEXT },
          },
        ],
      });
    }
    return JSON.stringify({ nextSeq: 20, messages: [] });
  };

  // 第一轮：接消息、推送、落盘
  const store1 = new DomainStore(backend);
  const archive1 = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    run,
  });
  const bot1 = new MockBot(clock);
  const service1 = new C2Service({ store: store1, bot: bot1, archive: archive1, clock });
  service1.addAdvisor({ id: ADV, name: '王顾问', chatId: ADV });
  service1.bindGroup({ roomId: 'wrGROUP1', name: '减重-张女士', advisorId: ADV });
  const runtime1 = new WecomRuntime({
    store: store1,
    service: service1,
    archive: archive1,
    trigger: new ArchiveTrigger({
      archive: archive1,
      store: store1,
      clock,
      compose: makeTemplateCompose(pluginConfig),
      config: { roomIds: ['wrGROUP1'], excludeSender: ADV, startedAt: 0 },
    }),
    bot: bot1,
    config: pluginConfig,
    clock,
    emit: () => undefined,
  });
  runtime1.start();
  await runtime1.pollOnce();
  await runtime1.stop();
  assert.equal(store1.listDrafts()[0].status, 'PUSHED');

  // 第二轮：从同一后端重建，不重新拉存档，直接点上一轮的卡片
  const store2 = new DomainStore(backend);
  assert.equal(store2.listDrafts().length, 1);
  const archive2 = new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
    run,
  });
  archive2.setSeq(store2.getMeta<number>('archive_seq') ?? 0);
  const bot2 = new MockBot(clock);
  const service2 = new C2Service({ store: store2, bot: bot2, archive: archive2, clock });
  const runtime2 = new WecomRuntime({
    store: store2,
    service: service2,
    archive: archive2,
    trigger: new ArchiveTrigger({
      archive: archive2,
      store: store2,
      clock,
      compose: makeTemplateCompose(pluginConfig),
      config: { roomIds: ['wrGROUP1'], excludeSender: ADV, startedAt: 0 },
    }),
    bot: bot2,
    config: pluginConfig,
    clock,
    emit: () => undefined,
  });

  await runtime2.handleButtonKey('ack:draft_1:sent');
  assert.equal(store2.getDraft('draft_1')?.status, 'ACKNOWLEDGED');
});

test('重启后草稿 id 从已有最大序号继续（maxDraftSeq）', async () => {
  const { maxDraftSeq } = await import('../plugins/zhiban-wecom/index.ts');
  const drafts = [{ id: 'draft_1' }, { id: 'draft_7' }, { id: 'custom' }] as Draft[];
  assert.equal(maxDraftSeq(drafts), 7);
});

test('重启后回读补历史：重启前已确认的草稿仍能核验为 VERIFIED', async () => {
  const backend = new MemoryStoreBackend();
  const clock = new FakeClock(1_000_000);
  const pluginConfig = config();
  const adapterConfig = {
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup: () => true,
  };

  const run1 = async (args: string[]): Promise<string> => {
    if (Number(args[1]) === 0) {
      return JSON.stringify({
        nextSeq: 10,
        messages: [
          {
            msgid: 'msg_customer_restart',
            action: 'recv',
            from: 'wmCUSTOMER',
            roomid: 'wrGROUP1',
            msgtime: clock.now() - 5_000,
            msgtype: 'text',
            text: { content: CUSTOMER_TEXT },
          },
        ],
      });
    }
    return JSON.stringify({ nextSeq: 20, messages: [] });
  };

  const store1 = new DomainStore(backend);
  const archive1 = new WeComArchiveAdapter({ ...adapterConfig, run: run1 });
  const bot1 = new MockBot(clock);
  const service1 = new C2Service({ store: store1, bot: bot1, archive: archive1, clock });
  service1.addAdvisor({ id: ADV, name: '王顾问', chatId: ADV });
  service1.bindGroup({ roomId: 'wrGROUP1', name: '减重-张女士', advisorId: ADV });
  const runtime1 = new WecomRuntime({
    store: store1,
    service: service1,
    archive: archive1,
    trigger: new ArchiveTrigger({
      archive: archive1,
      store: store1,
      clock,
      compose: makeTemplateCompose(pluginConfig),
      config: { roomIds: ['wrGROUP1'], excludeSender: ADV, startedAt: 0 },
    }),
    bot: bot1,
    config: pluginConfig,
    clock,
    emit: () => undefined,
  });

  runtime1.start();
  await runtime1.pollOnce();
  const draft = store1.listDrafts()[0];
  assert.ok(draft);
  const body = draft.body;
  await runtime1.handleButtonKey(`ack:${draft.id}:sent`);
  await runtime1.stop();
  assert.equal(store1.getDraft(draft.id)?.status, 'ACKNOWLEDGED');
  const savedSeq = store1.getMeta<number>('archive_seq') ?? 0;
  assert.ok(savedSeq > 0);

  // 重启后主游标从 savedSeq 续拉，不回看；Verifier 回读窗口内的历史由适配器补拉
  const run2 = async (args: string[]): Promise<string> => {
    if (Number(args[1]) === 0) {
      return JSON.stringify({
        nextSeq: 10,
        messages: [
          {
            msgid: 'msg_advisor_restart',
            action: 'send',
            from: ADV,
            roomid: 'wrGROUP1',
            msgtime: clock.now() - 1_000,
            msgtype: 'text',
            text: { content: body },
          },
        ],
      });
    }
    return JSON.stringify({ nextSeq: savedSeq + 10, messages: [] });
  };

  const store2 = new DomainStore(backend);
  const archive2 = new WeComArchiveAdapter({ ...adapterConfig, run: run2 });
  archive2.setSeq(savedSeq);
  const bot2 = new MockBot(clock);
  const service2 = new C2Service({ store: store2, bot: bot2, archive: archive2, clock });
  const runtime2 = new WecomRuntime({
    store: store2,
    service: service2,
    archive: archive2,
    trigger: new ArchiveTrigger({
      archive: archive2,
      store: store2,
      clock,
      compose: makeTemplateCompose(pluginConfig),
      config: { roomIds: ['wrGROUP1'], excludeSender: ADV, startedAt: 0 },
    }),
    bot: bot2,
    config: pluginConfig,
    clock,
    emit: () => undefined,
  });

  runtime2.start();
  clock.advance(200_000);
  await runtime2.tickOnce();
  await runtime2.stop();

  assert.equal(store2.getDraft(draft.id)?.status, 'VERIFIED');
});

function recordingPatient(observed: Parameters<PatientSink['observeRooms']>[0]): PatientSink {
  return {
    observeRooms: (rooms) => {
      observed.push(...rooms);
    },
    routeInbound: () => ({
      handled: false,
      decision: { action: 'ignore', reason: 'PATIENT_UNAVAILABLE' },
    }),
    handleDraftVerified: async () => undefined,
    handleAdvisorText: async () => false,
  };
}

test('群发现时用客户联系 API 补真实群昵称', async () => {
  const observed: Parameters<PatientSink['observeRooms']>[0] = [];
  const h = harness({
    patient: recordingPatient(observed),
    groupInfo: {
      roomInfo: async (roomId) =>
        roomId === 'wrGROUP1'
          ? {
              name: '客户-张女士',
              names: new Map([
                ['wmCUSTOMER', '张女士'],
                ['wmFAMILY', '张女士的女儿'],
              ]),
            }
          : undefined,
      memberNames: async () =>
        new Map([
          ['wmCUSTOMER', '张女士'],
          ['wmFAMILY', '张女士的女儿'],
        ]),
    },
  });
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
  } finally {
    await h.runtime.stop();
  }

  const member = observed.flatMap((room) => room.members).find((item) => item.id === 'wmCUSTOMER');
  assert.equal(member?.displayName, '张女士');

  // 整群映射一并交给患者域：本轮没发言的成员也能回填
  const room = observed.find((item) => item.roomId === 'wrGROUP1');
  assert.equal(room?.groupName, '客户-张女士');
  assert.equal(room?.memberNames?.wmCUSTOMER, '张女士');
  assert.equal(room?.memberNames?.wmFAMILY, '张女士的女儿');
  assert.ok(!observed.flatMap((item) => item.members).some((item) => item.id === 'wmFAMILY'));
});

test('群昵称查询失败或异常时保持 id 尾号回退，草稿链路不受影响', async () => {
  const observed: Parameters<PatientSink['observeRooms']>[0] = [];
  const h = harness({
    patient: recordingPatient(observed),
    groupInfo: {
      roomInfo: async () => {
        throw new Error('WECOM_DOWN');
      },
      memberNames: async () => {
        throw new Error('WECOM_DOWN');
      },
    },
  });
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
  } finally {
    await h.runtime.stop();
  }

  const member = observed.flatMap((room) => room.members).find((item) => item.id === 'wmCUSTOMER');
  assert.equal(member?.displayName, undefined);
  // 昵称失败不影响草稿生成
  assert.equal(h.store.listDrafts().length, 1);
  assert.ok(!h.logs.join('\n').includes('WECOM_DOWN'));
});

test('群发现时用会话存档接口补同意状态，和群昵称一起交给患者域', async () => {
  const observed: Parameters<PatientSink['observeRooms']>[0] = [];
  const h = harness({
    patient: recordingPatient(observed),
    groupInfo: {
      roomInfo: async () => ({ names: new Map([['wmCUSTOMER', '张女士']]) }),
      memberNames: async () => new Map([['wmCUSTOMER', '张女士']]),
    },
    roomAgree: {
      roomConsent: async (roomId) =>
        roomId === 'wrGROUP1'
          ? { wmCUSTOMER: 'agreed', wmFAMILY: 'disagreed' }
          : undefined,
    },
  });
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
  } finally {
    await h.runtime.stop();
  }

  const room = observed.find((item) => item.roomId === 'wrGROUP1');
  assert.deepEqual(room?.memberConsent, { wmCUSTOMER: 'agreed', wmFAMILY: 'disagreed' });
  // 两个来源互不影响
  assert.equal(room?.memberNames?.wmCUSTOMER, '张女士');
  assert.equal(room?.members.find((item) => item.id === 'wmCUSTOMER')?.displayName, '张女士');
});

test('同意状态查询失败时缺省该字段，草稿链路不受影响', async () => {
  const observed: Parameters<PatientSink['observeRooms']>[0] = [];
  const h = harness({
    patient: recordingPatient(observed),
    roomAgree: {
      roomConsent: async () => {
        throw new Error('MSGAUDIT_DOWN');
      },
    },
  });
  h.runtime.start();
  try {
    await h.runtime.pollOnce();
  } finally {
    await h.runtime.stop();
  }

  const room = observed.find((item) => item.roomId === 'wrGROUP1');
  assert.equal(room?.memberConsent, undefined);
  assert.equal(h.store.listDrafts().length, 1);
  assert.ok(!h.logs.join('\n').includes('MSGAUDIT_DOWN'));
});
