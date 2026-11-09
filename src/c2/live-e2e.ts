#!/usr/bin/env node
/**
 * C2-2-04 端到端联调：真实机器人 + 真实会话存档。
 *
 * 现在走完整的真实链路，不再需要私聊机器人：
 *   客户在群里发消息 → 存档拉取发现 → 生成草稿 → 推送「卡片 + 正文」
 *   → 员工把正文复制到测试群 → 点卡片「已发送」
 *   → 10 秒后 Verifier 调 archive_dump 回读，未匹配则每 15 秒重试 → 匹配 → VERIFIED
 *
 * 与 bot-live.ts 的区别：存档换成真的 WeComArchiveAdapter，群用真实 roomid，
 * 草稿由存档里的客户消息触发（ArchiveTrigger），而不是脚本写死。
 *
 * 依赖（都在跑脚本的机器上）：
 *   - archive_dump（Linux，需能调用 libWeWorkFinanceSdk_C.so）
 *   - private_key.pem / config.txt（corpid + 存档 Secret）
 *   - .env.local 里的 WECOM_BOT_ID / WECOM_BOT_SECRET
 *
 * 用法：
 *   npm run bot:e2e            # 群 id 从存档自动发现（只有一个群时）
 *   ARCHIVE_ROOM_ID=wrXXXX npm run bot:e2e
 *
 * 可选环境变量：
 *   ARCHIVE_ROOM_ID    测试群 roomid；不填时回看存档自动发现（有多个群会报错并列出）
 *   ADVISOR_USERID     员工 userid；缺省时从存档里推断（群内 action=send 的发送者）
 *   GROUP_NAME         卡片上显示的群名；不填时按群成员自动拼（存档没有群标题字段）
 *   WECOM_CONTACT_SECRET 客户联系 Secret；配上就能用 groupchat/get 查到真实群名与成员昵称
 *   WECOM_CORPID       企业 corpid；缺省取存档 config.txt 第一行
 *   ARCHIVE_BIN        默认 ~/wecom-sdk/C_sdk/archive_dump
 *   ARCHIVE_KEY        默认 ~/wecom-sdk/C_sdk/private_key.pem
 *   ARCHIVE_CONFIG     默认 ~/wecom-sdk/C_sdk/config.txt
 *   TRIGGER_INTERVAL_MS 默认 20000（存档触发轮询间隔，受存档延迟约束）
 *   VERIFY_DELAY_MS    默认 10000（首次回读延迟）
 *   VERIFY_RETRY_MS    默认 15000（没匹配到时的重试间隔）
 *   TICK_INTERVAL_MS   默认 5000（队列与校验的轮询间隔）
 *   TRIGGER_LOOKBACK_MS 默认 0（0 = 只处理启动之后的消息，避免重放历史）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { WeComArchiveAdapter } from './adapters/wecom-archive.ts';
import { WeComBotAdapter } from './adapters/wecom-bot.ts';
import type { InboundEvent, InboundMessage } from './adapters/wecom-bot.ts';
import { MemoryStore } from './memory.ts';
import { senderType, tailId } from './redact.ts';
import { C2Service } from './service.ts';
import { ArchiveTrigger } from './trigger.ts';
import type { ComposedDraft, ComposeInput } from './trigger.ts';
import type { Alert, Draft, GroupNameSource, VerificationResult } from './types.ts';

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

const ARCHIVE_ROOM_ID = (process.env.ARCHIVE_ROOM_ID || '').trim();
/** 实际使用的群 id；不填则启动时从存档里自动发现，填错可在运行期按存档校正 */
let ROOM_ID: string = ARCHIVE_ROOM_ID;
const ADVISOR_USERID = (process.env.ADVISOR_USERID || '').trim();
/**
 * 群标题：存档里没有，客户群 API 才给。不填时按成员自动拼一个可读标签，
 * 例如「WangXing、外部客户 9NfOsA」——员工靠它能和企微里的会话对上。
 */
const GROUP_NAME_ENV = (process.env.GROUP_NAME || '').trim();
let GROUP_NAME = GROUP_NAME_ENV;
let GROUP_NAME_SOURCE: GroupNameSource = 'config';

/** 客户联系 Secret：有它就能用 groupchat/get 查到企微里真实的群名和成员昵称 */
const CONTACT_SECRET = (process.env.WECOM_CONTACT_SECRET || '').trim();
let API_GROUP_NAME: string | undefined;
let API_MEMBERS: string[] | undefined;
const ARCHIVE_BIN = process.env.ARCHIVE_BIN || `${homedir()}/wecom-sdk/C_sdk/archive_dump`;
const ARCHIVE_KEY = process.env.ARCHIVE_KEY || `${homedir()}/wecom-sdk/C_sdk/private_key.pem`;
const ARCHIVE_CONFIG = process.env.ARCHIVE_CONFIG || `${homedir()}/wecom-sdk/C_sdk/config.txt`;
const SEQ_FILE = process.env.ARCHIVE_SEQ_FILE || fileURLToPath(new URL('.archive-seq', ROOT));
const ADVISOR_FILE = process.env.ADVISOR_USERID_FILE || fileURLToPath(new URL('.advisor-userid', ROOT));
const VERIFY_DELAY_MS = Number(process.env.VERIFY_DELAY_MS || 10_000);
const VERIFY_RETRY_MS = Number(process.env.VERIFY_RETRY_MS || 15_000);
/** 最多回读几次；用完判 UNVERIFIED。回执里承诺的「最迟多久」按它算 */
const VERIFY_MAX_ATTEMPTS = Number(process.env.VERIFY_MAX_ATTEMPTS || 6);
/** 最坏情况下多久出结果：首次延迟 + (次数-1) 次重试 */
const VERIFY_WORST_SECONDS = Math.round(
  (VERIFY_DELAY_MS + (VERIFY_MAX_ATTEMPTS - 1) * VERIFY_RETRY_MS) / 1000,
);
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS || 5_000);
const TRIGGER_INTERVAL_MS = Number(process.env.TRIGGER_INTERVAL_MS || 20_000);
const TRIGGER_LOOKBACK_MS = Number(process.env.TRIGGER_LOOKBACK_MS || 0);

if (!BOT_ID || !BOT_SECRET) {
  console.error('缺少 WECOM_BOT_ID / WECOM_BOT_SECRET（.env.local）');
  process.exit(1);
}

const log = (...args: unknown[]) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
};

const store = new MemoryStore();
const clock = { now: () => Date.now() };

const archive = new WeComArchiveAdapter({
  binaryPath: ARCHIVE_BIN,
  privateKeyPath: ARCHIVE_KEY,
  configPath: ARCHIVE_CONFIG,
  initialSeq: readInitialSeq(),
  // 联调脚本只绑定一个已知测试群，视为服务群；
  // 生产默认为非服务群（正文不落库），真实判定由 #33 注入。
  isServiceGroup: () => true,
  logger: (line) => log(line),
});

const onAlert = (alert: Alert) => log(`⚠️ 告警 ${alert.kind}`, alert.message);

let service: C2Service;

const adapter = new WeComBotAdapter(
  { botId: BOT_ID, secret: BOT_SECRET, logger: (line) => log(line) },
  {
    onMessage: (message) => void handleMessage(message),
    onEvent: (event) => void handleEvent(event),
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
    verifier: {
      verifyDelayMs: VERIFY_DELAY_MS,
      verifyRetryBackoffMs: VERIFY_RETRY_MS,
      maxVerifyAttempts: VERIFY_MAX_ATTEMPTS,
      verifyLookbackMs: 30 * 60_000,
      forgottenAckGraceMs: 3 * 60_000,
    },
  },
  onAlert,
});

/** 群名：显式配置 > 客户群 API > 按群成员拼 > 退回 roomid 尾巴 */
function resolveGroupName(): string {
  if (GROUP_NAME_ENV) return GROUP_NAME_ENV;
  if (API_GROUP_NAME) return API_GROUP_NAME;
  const members = collectMembers(ROOM_ID);
  if (members.length > 0) return members.slice(0, 4).join('、');
  return `客户群 …${ROOM_ID.slice(-6)}`;
}

/** 和 resolveGroupName 一一对应：群名来自成员拼接时，卡片不再重复列一遍成员 */
function resolveGroupNameSource(): GroupNameSource {
  if (GROUP_NAME_ENV) return 'config';
  if (API_GROUP_NAME) return 'api';
  if (collectMembers(ROOM_ID).length > 0) return 'members';
  return 'roomid';
}

/** corpid：环境变量优先，否则取存档 config.txt 的第一行 */
function readCorpId(): string {
  const fromEnv = (process.env.WECOM_CORPID || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return (
      readFileSync(ARCHIVE_CONFIG, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? ''
    );
  } catch {
    return '';
  }
}

/**
 * 用客户群 API 查群名与成员（chat_id 就是存档里的 roomid）。
 * 需要「客户联系」Secret；没配就返回 undefined，由调用方退回到 id 拼接。
 */
async function fetchGroupInfo(roomid: string): Promise<{ name?: string; members: string[] } | undefined> {
  if (!CONTACT_SECRET) return undefined;
  const corpid = readCorpId();
  if (!corpid) {
    log('查群名跳过：缺少 corpid（可用 WECOM_CORPID 指定）');
    return undefined;
  }

  try {
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}` +
        `&corpsecret=${encodeURIComponent(CONTACT_SECRET)}`,
    );
    const token = (await tokenRes.json()) as { access_token?: string; errmsg?: string };
    if (!token.access_token) {
      log(`查群名跳过：access_token 获取失败 ${token.errmsg ?? ''}`.trim());
      return undefined;
    }

    const res = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/get?access_token=${token.access_token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: roomid, need_name: 1 }),
      },
    );
    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
      group_chat?: {
        name?: string;
        member_list?: Array<{ userid: string; type: number; name?: string }>;
      };
    };
    if (data.errcode !== 0) {
      log(`查群名失败：errcode=${data.errcode} ${data.errmsg ?? ''}`.trim());
      return undefined;
    }

    const members = (data.group_chat?.member_list ?? [])
      .filter((member) => member.userid !== advisorId)
      .map((member) =>
        member.name ?? (member.userid.startsWith('wm') ? `外部客户 ${member.userid.slice(-6)}` : member.userid),
      );
    return { name: data.group_chat?.name, members };
  } catch (error) {
    log('查群名异常：', errorMessage(error));
    return undefined;
  }
}

function ensureAdvisor(userid: string): void {
  GROUP_NAME = resolveGroupName();
  GROUP_NAME_SOURCE = resolveGroupNameSource();
  if (store.getAdvisor(userid)) return;
  service.addAdvisor({ id: userid, name: userid, chatId: userid });
  service.bindGroup({
    roomId: ROOM_ID,
    name: GROUP_NAME,
    advisorId: userid,
  });
  log(`已登记顾问 ${tailId(userid)}，绑定群 roomid=${tailId(ROOM_ID)} name=${GROUP_NAME}`);
}

/** 启动时把 seq 游标追到最新，避免从 0 开始时每轮只前进几百条 */
async function catchUpArchive(): Promise<void> {
  let rounds = 0;
  for (;;) {
    const before = archive.getSeq();
    await archive.pull();
    rounds += 1;
    if (archive.getSeq() === before || rounds >= 100) break;
  }
  persistSeq();
  log(`存档已追平：seq=${archive.getSeq()}（${rounds} 轮）`);
}

/**
 * 未配置 ARCHIVE_ROOM_ID 时，从存档里自动发现群：
 * 群 id 是 32 位随机串，人手抄一次就可能混进同形字符（已踩过两次），能不抄就不抄。
 * 启动时缓存通常是空的（seq 已追平），所以往前回看一段再找。
 */
async function discoverRoomId(): Promise<string> {
  if (archive.listCached().length === 0) {
    const from = Math.max(0, archive.getSeq() - 500);
    if (from < archive.getSeq()) {
      log(`未配置 ARCHIVE_ROOM_ID，回看 seq=${from} 找群…`);
      archive.setSeq(from);
      await archive.pull();
      persistSeq();
    }
  }

  // 按最后一条消息时间排序：多群时取最近活跃的（联调场景就是正在聊的那个）
  const latest = new Map<string, number>();
  for (const record of archive.listCached()) {
    const roomid = record.roomid ?? '';
    if (!roomid) continue;
    latest.set(roomid, Math.max(latest.get(roomid) ?? 0, record.msgtime));
  }
  const ranked = [...latest.entries()].sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    throw new Error('未配置 ARCHIVE_ROOM_ID，且存档里没有群消息可用来发现群，请手动指定');
  }
  if (ranked.length === 1) {
    log(`自动发现群 roomid=${tailId(ranked[0][0])}`);
    return ranked[0][0];
  }
  log(`存档里有 ${ranked.length} 个群，取最近活跃的：${tailId(ranked[0][0])}`);
  log(`  其他群（要指定就设 ARCHIVE_ROOM_ID）：${ranked.slice(1).map(([id]) => tailId(id)).join('、')}`);
  return ranked[0][0];
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length];
}

/**
 * 参数里的 roomid 与存档对不上、但只差一个字符时，按存档校正（存档才是事实）。
 * 人工抄 roomid 时 l/I、0/O 这类差异几乎看不出来。
 */
function correctRoomId(): void {
  const rooms = [...new Set(archive.listCached().map((record) => record.roomid ?? '').filter(Boolean))];
  if (rooms.length === 0 || rooms.includes(ROOM_ID)) return;

  const matches = rooms.filter((room) => editDistance(room, ROOM_ID) === 1);
  if (matches.length === 1) {
    log(`roomid 与存档相差 1 个字符，已按存档校正：${tailId(ROOM_ID)} → ${tailId(matches[0])}`);
    ROOM_ID = matches[0];
    return;
  }
  log(`roomid 未在存档中找到，存档里的群：${rooms.map((room) => tailId(room)).join('、')}`);
}

/** 两个 id 的第一个差异位置与码点，用来抓不可见字符/形近字符 */
function describeDiff(cached: string, target: string): string {
  const len = Math.min(cached.length, target.length);
  for (let i = 0; i < len; i += 1) {
    if (cached[i] !== target[i]) {
      return (
        `第 ${i + 1} 位不同：缓存 U+${cached.charCodeAt(i).toString(16).toUpperCase()}` +
        `「${cached[i]}」 vs 参数 U+${target.charCodeAt(i).toString(16).toUpperCase()}「${target[i]}」`
      );
    }
  }
  if (cached.length !== target.length) {
    return `长度不同：缓存 ${cached.length} vs 参数 ${target.length}`;
  }
  return '看起来相同但比较不等（可能含不可见字符）';
}

/** 排查用：把缓存里目标群的消息原样打出来（字段形态决定触发/推断是否成立） */
function logTargetRoom(): void {
  const cached = archive.listCached();
  if (cached.length === 0) {
    log('存档缓存为空（游标已到最新或还没拉到数据），启动后靠增量拉取');
    return;
  }
  const perRoom = new Map<string, number>();
  for (const record of cached) {
    const key = record.roomid || '(单聊)';
    perRoom.set(key, (perRoom.get(key) ?? 0) + 1);
  }
  log(
    `存档缓存 ${cached.length} 条：${[...perRoom].map(([k, v]) => `${tailId(k)}×${v}`).join('，') || '空'}`,
  );

  const inRoom = cached.filter((record) => (record.roomid ?? '') === ROOM_ID);
  if (inRoom.length === 0) {
    log(`目标群 ${tailId(ROOM_ID)} 在缓存里没有消息`);
    for (const room of perRoom.keys()) {
      if (room === '(单聊)') continue;
      log(`  与缓存群 ${tailId(room)} 对比：${describeDiff(room, ROOM_ID)}`);
    }
    log(`  参数长度：${ROOM_ID.length}`);
    return;
  }
  log(`目标群消息 ${inRoom.length} 条，最近 5 条：`);
  for (const record of inRoom.slice(-5)) {
    log(
      `  action=${record.action ?? '-'} sender=${senderType(record.from, record.action)} ` +
        `msgtype=${record.msgtype} msgtime=${record.msgtime} msgid=${tailId(record.msgid)}`,
    );
  }
}

/**
 * 员工 userid：环境变量 → 上次推断结果 → 从存档推断（群内 action=send 的发送者就是本人）。
 * 推断结果写到 .advisor-userid，避免 seq 游标跳过历史后无法再推断。
 */
async function resolveAdvisor(): Promise<string> {
  if (ADVISOR_USERID) return rememberAdvisor(ADVISOR_USERID);

  try {
    if (existsSync(ADVISOR_FILE)) {
      const saved = readFileSync(ADVISOR_FILE, 'utf8').trim();
      if (saved) {
        log(`使用上次记录的顾问 userid=${tailId(saved)}`);
        return saved;
      }
    }
  } catch {
    // 忽略，继续推断
  }

  log('未设置 ADVISOR_USERID，尝试从存档推断…');
  await archive.pull();
  // 员工消息：action=send；外部客户的 from 是 wm 开头的个人微信 id，排除掉
  const senders = new Set<string>();
  for (const record of archive.listCached()) {
    if ((record.roomid ?? '') !== ROOM_ID) continue;
    if (!record.from || record.from.startsWith('wm')) continue;
    if (record.action === 'recv') continue;
    senders.add(record.from);
  }

  if (senders.size === 1) {
    const [userid] = senders;
    log(`从存档推断顾问 userid=${tailId(userid)}`);
    return rememberAdvisor(userid);
  }
  logTargetRoom();
  throw new Error(
    senders.size === 0
      ? '无法从存档推断顾问：该群没有 action=send 的消息，请设置 ADVISOR_USERID'
      : `存档里出现多个发送者（${[...senders].map((id) => tailId(id)).join('、')}），请设置 ADVISOR_USERID`,
  );
}

function rememberAdvisor(userid: string): string {
  try {
    writeFileSync(ADVISOR_FILE, userid);
  } catch {
    // 写不进去不影响本次运行
  }
  return userid;
}

/**
 * 机器人只处理 1:1 私聊。现在草稿由存档里的客户消息触发，
 * 不再需要员工私聊机器人；这里只记录，不生成草稿。
 */
async function handleMessage(message: InboundMessage): Promise<void> {
  log(`收到私聊消息 userid=${tailId(message.userid)} chattype=${message.chattype}（忽略：草稿由存档触发）`);
}

/** 简易规则：把客户原话回显成一条测试回复。真实场景应替换为规则引擎/生成。 */
function composeReply({ message }: ComposeInput): ComposedDraft | undefined {
  const text = message.text.trim();
  if (!text) return undefined;
  const quoted = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return {
    body: `收到您的消息：「${quoted}」。营养师稍后为您详细回复。（C2 自动草稿，测试内容）`,
    inboundSummary: quoted,
    customerName: message.from.startsWith('wm') ? `外部客户 ${message.from.slice(-6)}` : message.from,
    riskLevel: 'low',
  };
}

/**
 * 草稿 id 必须跨进程唯一：卡片按钮里的 event_key 是 `ack:<draftId>:sent`，
 * 如果每次启动都从 draft_1 开始，上一轮没退干净的旧卡片会打中本轮的新草稿。
 */
const RUN_TAG = Date.now().toString(36).slice(-5);
let draftSeq = 0;

function nextDraftId(): string {
  draftSeq += 1;
  return `draft_${RUN_TAG}_${draftSeq}`;
}

/**
 * 启动时缓存是空的（seq 已追平，只有新消息才会进缓存），所以 roomid 校正挪到运行期：
 * 第一次拉到该群的消息时，如果和配置只差一个字符，就按存档纠正并重新绑定群。
 * 人工抄 32 位 id，l/I、0/O、同形异码几乎必然出错，存档才是事实。
 */
async function adoptRoomIdFromArchive(): Promise<void> {
  const rooms = [...new Set(archive.listCached().map((record) => record.roomid ?? '').filter(Boolean))];
  if (rooms.length === 0 || rooms.includes(ROOM_ID)) return;

  const matches = rooms.filter((room) => editDistance(room, ROOM_ID) === 1);
  if (matches.length !== 1) return;

  const next = matches[0];
  log(`roomid 与存档相差 1 个字符，按存档校正：${tailId(ROOM_ID)} → ${tailId(next)}`);
  ROOM_ID = next;
  triggerConfig.roomIds = [ROOM_ID];

  const apiGroup = await fetchGroupInfo(ROOM_ID);
  if (apiGroup) {
    API_GROUP_NAME = apiGroup.name;
    API_MEMBERS = apiGroup.members;
  }
  GROUP_NAME = resolveGroupName();
  GROUP_NAME_SOURCE = resolveGroupNameSource();

  service.bindGroup({ roomId: ROOM_ID, name: GROUP_NAME, advisorId });
  log(`已重新绑定群 roomid=${tailId(ROOM_ID)}（群名「${GROUP_NAME}」）`);
}

/**
 * 群里能看到的成员：从该群的存档记录里收集 from 与 tolist。
 * 员工自己排除掉；外部联系人只显示 id 后 6 位（存档里没有微信昵称）。
 */
function collectMembers(roomid: string): string[] {
  // 客户群 API 给的名字更准，有就用它
  if (API_MEMBERS && API_MEMBERS.length > 0) return API_MEMBERS;

  const ids = new Set<string>();
  for (const record of archive.listCached()) {
    if ((record.roomid ?? '') !== roomid) continue;
    if (record.from) ids.add(record.from);
    for (const id of record.tolist ?? []) ids.add(id);
  }
  ids.delete(advisorId);
  return [...ids].slice(0, 8).map((id) => (id.startsWith('wm') ? `外部客户 ${id.slice(-6)}` : id));
}

/** 拉一次存档，把新出现的客户消息变成草稿并入队 */
async function triggerLoop(): Promise<void> {
  try {
    await adoptRoomIdFromArchive();
    const events = await trigger.poll();
    persistSeq();
    if (events.length === 0) return;

    for (const event of events) {
      try {
        const draft = service.enqueueDraft({
          id: nextDraftId(),
          advisorId,
          groupRoomId: event.group.roomId,
          groupNameSource: GROUP_NAME_SOURCE,
          groupMembers: collectMembers(event.group.roomId),
          customerId: event.message.from,
          customerName: event.draft.customerName ?? event.message.from,
          lastInboundAt: event.message.msgtime,
          inboundMessageId: event.message.msgid,
          inboundSummary: event.draft.inboundSummary ?? event.message.text.slice(0, 40),
          body: event.draft.body,
          ruleIds: ['archive-trigger'],
          riskLevel: event.draft.riskLevel,
        });
        log(`草稿 ${draft.id} 已入队 ← sender=${senderType(event.message.from, event.message.action)}`);
      } catch (error) {
        log('入队失败：', errorMessage(error));
      }
    }
    // 推送交给 TICK 循环，避免两个定时器同时调 service.tick()
  } catch (error) {
    log('存档触发失败：', errorMessage(error));
  }
}

/**
 * 卡片按钮点完不会变化（平台行为），员工看不出处理结果。
 * 所以每个关键节点都补一条文字消息：点了、校验通过、校验失败、错群。
 */
async function notify(text: string): Promise<void> {
  try {
    await adapter.sendText(advisorId, text);
  } catch (error) {
    log('发送回执失败：', errorMessage(error));
  }
}

async function handleEvent(event: InboundEvent): Promise<void> {
  log(`收到事件 key=${event.eventKey ?? '-'}`);
  if (!event.eventKey) return;

  try {
    const draft = service.handleButtonCallback(event.eventKey);
    log(`已确认 ${draft.id} → ${draft.status}，${Math.round(VERIFY_DELAY_MS / 1000)} 秒后回读`);
    if (draft.status === 'SKIPPED') {
      await notify(`已忽略这条草稿（客户原文「${draft.inboundSummary}」），不会再回读校验。`);
    } else {
      await notify(
        `已记录「已发送」（客户原文「${draft.inboundSummary}」）。\n` +
          `正在回读会话存档确认：顺利的话 ${Math.round(VERIFY_DELAY_MS / 1000)} 秒内出结果；` +
          `若一直没找到，最迟约 ${VERIFY_WORST_SECONDS} 秒会告诉你失败。`,
      );
    }
    await service.tick();
    printState();
  } catch (error) {
    const message = errorMessage(error);
    // 卡片按钮不会置灰：重复点、点旧卡片都会回到这里，属于正常操作，不是错误
    if (message.startsWith('ALREADY_ACKNOWLEDGED')) {
      log(`重复点击，忽略（${message}）`);
      await notify(`这条草稿已经处理过了（${message.split('status=')[1] ?? '已处理'}），无需重复点击。`);
      return;
    }
    if (message.startsWith('DRAFT_NOT_FOUND')) {
      log(`卡片已过期，忽略（${message}）`);
      await notify('这张卡片来自上一次运行，服务重启后已经失效，请用最新推送的那张。');
      return;
    }
    log('确认失败：', message);
  }
}

/** 定时跑队列与校验，让重试有机会发生 */
async function loop(): Promise<void> {
  try {
    const result = await service.tick();
    persistSeq();
    for (const push of result.pushed) {
      if (push.pushed) log(`推送 ${push.draftId} 成功`);
    }
    for (const res of result.verified) {
      log(`校验结果 ${res.outcome}${res.matchedMsgId ? ` msgid=${tailId(res.matchedMsgId)}` : ''}`);
      const draft = res.draftId ? store.getDraft(res.draftId) : undefined;
      if (draft) await notify(verifyMessage(draft, res));
    }
    if (result.pushed.some((p) => p.pushed)) {
      log('请把上面推送的正文复制到测试群，然后点卡片「已发送」。');
    }
    printState();
  } catch (error) {
    log('tick 失败：', errorMessage(error));
  }
}

/** 校验结果翻成员工看得懂的一句话 */
function verifyMessage(draft: Draft, res: VerificationResult): string {
  const quote = `客户原文「${draft.inboundSummary}」`;
  switch (res.outcome) {
    case 'VERIFIED':
      return `✅ 校验通过：${quote} 的回复已在「${draft.groupName}」里找到，这条任务完成。`;
    case 'EDIT_SENT':
      return `✅ 已发送（内容有改动）：在「${draft.groupName}」里找到了相近的正文，这条任务完成。`;
    case 'MISROUTE_ALERT':
      return `⚠️ 错群：${quote} 的回复出现在别的群（${res.matchedRoomId ?? '-'}），不在「${draft.groupName}」。请检查后手动处理。`;
    case 'UNVERIFIED':
      return `❌ 没有在「${draft.groupName}」里找到这条正文（重试 ${draft.verifyAttempts} 次）。请确认是否真的粘贴发出去了。`;
    default:
      return `校验结果：${res.outcome}（${quote}）`;
  }
}

/** 持久化 store 的 seq 游标，重启后不从头重拉（存档最多保留 5 天，重拉既慢又浪费） */
function persistSeq(): void {
  try {
    writeFileSync(SEQ_FILE, String(archive.getSeq()));
  } catch (error) {
    log('seq 游标写入失败：', errorMessage(error));
  }
}

function readInitialSeq(): number {
  const fromEnv = process.env.ARCHIVE_START_SEQ;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  try {
    if (existsSync(SEQ_FILE)) {
      const value = Number(readFileSync(SEQ_FILE, 'utf8').trim());
      if (Number.isFinite(value)) return value;
    }
  } catch {
    // 读不到就从头拉
  }
  return 0;
}

function printState(): void {
  const drafts = store.listDrafts();
  if (drafts.length === 0) return;
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    counts.set(draft.status, (counts.get(draft.status) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
  log(`状态：共 ${drafts.length} 条 ${summary}`);
  for (const draft of drafts) log(`  ${draft.id} ${draft.status} ${describe(draft)}`);
}

function describe(draft: Draft): string {
  const parts = [draft.groupName];
  if (draft.ackAction) parts.push(`ack=${draft.ackAction}`);
  if (draft.verification) parts.push(`verify=${draft.verification.outcome}`);
  return parts.join(' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  await catchUpArchive();
} catch (error) {
  log('存档追平失败：', errorMessage(error));
  process.exit(1);
}
if (!ROOM_ID) {
  try {
    ROOM_ID = await discoverRoomId();
  } catch (error) {
    log(errorMessage(error));
    process.exit(1);
  }
}
correctRoomId();
logTargetRoom();

let advisorId: string;
try {
  advisorId = await resolveAdvisor();
} catch (error) {
  log(errorMessage(error));
  process.exit(1);
}
const apiGroup = await fetchGroupInfo(ROOM_ID);
if (apiGroup) {
  API_GROUP_NAME = apiGroup.name;
  API_MEMBERS = apiGroup.members;
  log(`客户群 API：群名「${apiGroup.name ?? '未命名'}」，成员 ${apiGroup.members.length} 人`);
}

ensureAdvisor(advisorId);

const triggerConfig = {
  roomIds: [ROOM_ID],
  excludeSender: advisorId,
  startedAt: Date.now() - TRIGGER_LOOKBACK_MS,
};

const trigger = new ArchiveTrigger({
  archive,
  store,
  clock,
  compose: composeReply,
  config: triggerConfig,
  logger: (line) => log(line),
});

await adapter.connect();
persistSeq();

log('C2 端到端联调已启动');
log(`顾问 userid：${tailId(advisorId)}`);
log(`存档：${ARCHIVE_BIN}（seq=${archive.getSeq()}）`);
log(`群 roomid：${tailId(ROOM_ID)}`);
log(`触发：每 ${Math.round(TRIGGER_INTERVAL_MS / 1000)} 秒拉一次存档，只处理启动之后的客户消息`);
log(
  `校验节奏：首次 ${Math.round(VERIFY_DELAY_MS / 1000)} 秒，重试每 ${Math.round(
    VERIFY_RETRY_MS / 1000,
  )} 秒，轮询 ${Math.round(TICK_INTERVAL_MS / 1000)} 秒`,
);
log('请在测试群里用客户身份发一条消息，不需要私聊机器人。');

const tickTimer = setInterval(() => void loop(), TICK_INTERVAL_MS);
const triggerTimer = setInterval(() => void triggerLoop(), TRIGGER_INTERVAL_MS);
tickTimer.unref?.();
triggerTimer.unref?.();

process.on('SIGINT', () => {
  log('正在退出…');
  adapter.close();
  process.exit(0);
});
