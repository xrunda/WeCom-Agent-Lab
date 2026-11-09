#!/usr/bin/env node
/**
 * C2 真实机器人联调（单聊）。
 *
 * 与 aibot-push.mjs 的区别：这个脚本接的是 C2 的编排层，不是裸推送。
 *   员工给机器人发消息 → 创建草稿 → 串行队列推送「卡片 + 正文」→
 *   员工点卡片按钮 → 回调解出 event_key → 草稿状态机流转。
 *
 * 未接会话存档，因此确认后的「回读校验」不会发生（verifier 延迟设成 7 天）。
 * 存档接入后把 archive 换成真实 ArchivePort 即可。
 *
 * 用法：
 *   npm run bot:live
 *   然后在企业微信里给机器人发一条消息（单聊）。
 *
 * 注意：同一机器人同一时间只能有一个长连接；先关掉 aibot-push.mjs。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WeComBotAdapter } from './adapters/wecom-bot.ts';
import type { InboundEvent, InboundMessage } from './adapters/wecom-bot.ts';
import { MemoryStore, MockArchive } from './memory.ts';
import { C2Service } from './service.ts';
import type { Alert, Draft } from './types.ts';

const ROOT = new URL('../../', import.meta.url);
const ENV_PATH = fileURLToPath(new URL('.env.local', ROOT));

const inherited = {
  id: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_BOT_SECRET,
};
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}
const BOT_ID = (inherited.id || process.env.WECOM_BOT_ID || '').trim();
const BOT_SECRET = (inherited.secret || process.env.WECOM_BOT_SECRET || '').trim();

if (!BOT_ID || !BOT_SECRET) {
  console.error('缺少 WECOM_BOT_ID / WECOM_BOT_SECRET。');
  console.error('请先执行：cp config/.env.example .env.local 并填写机器人凭证。');
  process.exit(1);
}

const log = (...args: unknown[]) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
};

const store = new MemoryStore();
const archive = new MockArchive();
const clock = { now: () => Date.now() };

let service: C2Service;
let round = 0;

function onAlert(alert: Alert): void {
  log(`⚠️ 告警 ${alert.kind}`, alert.message);
}

const adapter = new WeComBotAdapter(
  {
    botId: BOT_ID,
    secret: BOT_SECRET,
    logger: (line) => log(line),
  },
  {
    onMessage: (message) => {
      void handleMessage(message);
    },
    onEvent: (event) => {
      void handleEvent(event);
    },
    onClose: (code) => {
      log(`长连接已关闭（code=${code}），退出`);
      process.exit(1);
    },
  },
);

service = new C2Service({
  store,
  bot: adapter,
  archive,
  clock,
  config: {
    // 未接存档：把校验推迟到 7 天后，避免联调期间刷 UNVERIFIED
    verifier: { verifyDelayMs: 7 * 24 * 60 * 60 * 1000 },
  },
  onAlert,
});

function ensureAdvisor(userid: string): void {
  if (store.getAdvisor(userid)) return;
  service.addAdvisor({ id: userid, name: userid, chatId: userid });
  service.bindGroup({
    roomId: `room_${userid}_A`,
    name: 'A 群（测试）',
    advisorId: userid,
  });
  service.bindGroup({
    roomId: `room_${userid}_B`,
    name: 'B 群（测试）',
    advisorId: userid,
  });
  log(`已登记顾问 ${userid}，并绑定两个测试群（内存）`);
}

async function handleMessage(message: InboundMessage): Promise<void> {
  log(`收到消息 userid=${message.userid} chattype=${message.chattype} text=${message.text ?? '-'}`);
  if (message.chattype !== 'single') {
    log('联调脚本只处理单聊；群聊消息已忽略');
    return;
  }

  ensureAdvisor(message.userid);
  const groupIndex = round++ % 2;
  const groupRoomId = `room_${message.userid}_${groupIndex === 0 ? 'A' : 'B'}`;

  try {
    const draft = service.enqueueDraft({
      advisorId: message.userid,
      groupRoomId,
      customerId: 'cust_test_1',
      customerName: '张女士',
      inboundMessageId: `in_${Date.now()}`,
      inboundSummary: '客户询问今天的饮食安排（联调测试）',
      body: buildBody(),
      riskLevel: 'low',
    });
    log(`草稿已入队 ${draft.id} → ${draft.groupName}`);

    const result = await service.tick();
    for (const push of result.pushed) {
      log(`推送 ${push.draftId} pushed=${push.pushed}${push.reason ? ` reason=${push.reason}` : ''}`);
    }
    printState();
  } catch (error) {
    log('处理消息失败：', error instanceof Error ? error.message : String(error));
  }
}

async function handleEvent(event: InboundEvent): Promise<void> {
  log(`收到事件 ${event.eventtype} key=${event.eventKey ?? '-'} task=${event.taskId ?? '-'}`);
  if (!event.eventKey) return;

  try {
    const draft = service.handleButtonCallback(event.eventKey);
    log(`确认成功 ${draft.id} → ${draft.status} （${draft.ackAction}）`);
    const result = await service.tick();
    for (const push of result.pushed) {
      log(`推送下一条 ${push.draftId} pushed=${push.pushed}${push.reason ? ` reason=${push.reason}` : ''}`);
    }
    printState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('ALREADY_ACKNOWLEDGED')) {
      log(`重复点击，忽略（${message}）`);
      return;
    }
    log('确认失败：', message);
  }
}

function buildBody(): string {
  const time = new Date().toISOString().slice(11, 19);
  return `【C2 联调测试】这是一条模拟回复，请复制到测试群。生成时间 ${time}（假数据，勿发真实客户群）`;
}

function printState(): void {
  const drafts = store.listDrafts();
  const active = drafts.filter((draft) => draft.status === 'PUSHED').length;
  const queued = drafts.filter((draft) => draft.status === 'QUEUED').length;
  log(`状态：共 ${drafts.length} 条，PUSHED=${active}，QUEUED=${queued}`);
  for (const draft of drafts) {
    log(`  ${draft.id} ${draft.status} ${draft.groupName}${draft.ackAction ? ` ack=${draft.ackAction}` : ''}`);
  }
}

await adapter.connect();
log('C2 联调已启动。请在企业微信里给机器人发一条单聊消息。');
log(`BotID ${BOT_ID.slice(0, 6)}…（secret 不打印）`);

process.on('SIGINT', () => {
  log('正在退出…');
  adapter.close();
  process.exit(0);
});
