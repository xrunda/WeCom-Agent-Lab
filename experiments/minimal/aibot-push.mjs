#!/usr/bin/env node
/**
 * C2-0-A2：验证 API 模式智能机器人能否主动推送「模板卡片 + Markdown 文本」
 *
 * 用法：
 *   1. cp config/.env.example .env.local
 *   2. 填入 WECOM_BOT_ID / WECOM_BOT_SECRET（后台「智能机器人 → API 模式 → 长连接」）
 *   3. node experiments/minimal/aibot-push.mjs
 *   4. 在企业微信客户端里找到这个机器人，发一句「测试」
 *
 * 参数：
 *   --no-push   只接收、不自动推送（先确认回调字段时用）
 *
 * 这是平台验证脚本，不是业务后端：
 *   - 不写文件、不连数据库
 *   - 只在收到消息后推送一次卡片 + 一条 markdown，避免刷屏
 *   - Ctrl+C 退出
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ENV_PATH = fileURLToPath(new URL('.env.local', ROOT));

// 环境变量优先级：shell > .env.local
const inherited = {
  id: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_BOT_SECRET,
};
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}
const BOT_ID = (inherited.id || process.env.WECOM_BOT_ID || '').trim();
const BOT_SECRET = (inherited.secret || process.env.WECOM_BOT_SECRET || '').trim();

const WS_URL = 'wss://openws.work.weixin.qq.com';
const AUTO_PUSH = !process.argv.includes('--no-push');
const PING_INTERVAL_MS = 30_000;

if (!BOT_ID || !BOT_SECRET) {
  console.error('缺少 WECOM_BOT_ID / WECOM_BOT_SECRET。');
  console.error('请先执行：cp config/.env.example .env.local');
  console.error('然后填写后台「智能机器人 → API 模式 → 长连接」里的 BotID 和 Secret。');
  process.exit(1);
}

// 注意：Node 内置 WebSocket（undici）与企微长连接握手不兼容，会直接 1006。
// 这里必须使用 ws 包。
let WebSocketImpl;
try {
  ({ default: WebSocketImpl } = await import('ws'));
} catch {
  console.error('缺少 ws 依赖。请先在仓库根目录执行：npm install');
  process.exit(1);
}

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

let ws;
let pingTimer;
let closing = false;
let kicked = false;
let authed = false;
let retryDelay = 1_000;
let reqSeq = 0;
const pending = new Map();
const pushedChats = new Set();

const nextReqId = () => `c2-${Date.now()}-${++reqSeq}`;

function sendFrame(frame) {
  ws.send(JSON.stringify(frame));
}

async function frameText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text();
  return String(data);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    const id = nextReqId();
    pending.set(id, 'ping');
    sendFrame({ cmd: 'ping', headers: { req_id: id } });
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = undefined;
}

function connect() {
  log(`连接 ${WS_URL} ...`);
  ws = new WebSocketImpl(WS_URL);

  // ws 专有事件：HTTP 握手被拒时不会走 error
  ws.on?.('unexpected-response', (_req, res) => {
    log(`握手被拒：HTTP ${res.statusCode}`);
  });

  ws.addEventListener('open', () => {
    log('WebSocket 已连接，发送 aibot_subscribe');
    const id = nextReqId();
    pending.set(id, 'subscribe');
    sendFrame({
      cmd: 'aibot_subscribe',
      headers: { req_id: id },
      body: { bot_id: BOT_ID, secret: BOT_SECRET },
    });
    startPing();
  });

  ws.addEventListener('message', async (event) => {
    const raw = await frameText(event.data);
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      log('收到非 JSON 帧：', raw.slice(0, 200));
      return;
    }
    handleFrame(frame);
  });

  ws.addEventListener('close', (event) => {
    stopPing();
    log(`WebSocket 关闭 code=${event.code} reason=${event.reason || '(none)'}`);
    if (closing || kicked) return;
    if (!authed) {
      log('尚未订阅成功，不自动重连。请检查：');
      log('  1) BotID / Secret 是否为「API 模式 → 长连接」的凭证');
      log('  2) 同一机器人同一时间只允许一个长连接');
      log('  3) 机器人是否已创建并加入可见范围');
      process.exit(1);
    }
    log(`${retryDelay / 1000}s 后重连`);
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  });

  ws.addEventListener('error', (event) => {
    const detail = event?.error?.message || event?.message || '';
    log(`WebSocket error${detail ? `: ${detail}` : '（详情通常在 close 事件里）'}`);
  });
}

function handleFrame(frame) {
  const reqId = frame?.headers?.req_id;

  // 通用响应帧：{ headers, errcode, errmsg }
  if (frame.cmd === undefined && frame.errcode !== undefined) {
    const label = pending.get(reqId) ?? 'unknown';
    pending.delete(reqId);

    if (label === 'ping') {
      if (frame.errcode !== 0) log(`ping 失败 errcode=${frame.errcode}`);
      return;
    }

    if (frame.errcode === 0) {
      log(`✓ ${label} ok`);
      if (label === 'subscribe') {
        authed = true;
        retryDelay = 1_000;
        log('');
        log('订阅成功。现在请在企微客户端里给这个机器人发一句「测试」。');
        log(`收到消息后${AUTO_PUSH ? '会自动推送卡片 + 文本' : '只记录，不推送（--no-push）'}。`);
        log('');
      }
      return;
    }

    log(`✗ ${label} errcode=${frame.errcode} errmsg=${frame.errmsg}`);
    if (label === 'subscribe') {
      log('订阅失败：常见原因是 BotID/Secret 不对，或这个机器人不是 API 模式。');
      closing = true;
      process.exit(1);
    }
    return;
  }

  switch (frame.cmd) {
    case 'aibot_msg_callback':
      onMessage(frame);
      break;
    case 'aibot_event_callback':
      log('收到事件回调（用于验证按钮 key，A3）：');
      log(JSON.stringify(frame.body ?? frame, null, 2));
      break;
    case 'disconnected_event':
      kicked = true;
      log('当前长连接被新连接顶替（同一机器人只允许一个连接），停止重连。');
      process.exit(2);
      break;
    default:
      log('收到帧：', JSON.stringify(frame));
  }
}

function onMessage(frame) {
  const body = frame.body ?? {};
  const from = body.from ?? {};
  const userId = from.userid ?? from.user_id ?? body.userid;
  const chatType = body.chattype === 'group' ? 2 : 1;
  const chatId = chatType === 2 ? body.chatid : userId;

  log('收到 aibot_msg_callback：');
  log(JSON.stringify(body, null, 2));
  log(`解析结果：userid=${userId ?? '(未找到)'} chattype=${body.chattype ?? '(未给出)'} chatid=${chatId ?? '(未找到)'}`);

  if (!userId || !chatId) {
    log('没有解析到 userid/chatid，无法主动推送。上面的原始 JSON 请保留。');
    return;
  }
  if (chatType === 2) {
    log('注意：这是群聊回调。#14 要验证的是员工 1:1 单聊，请私聊机器人再发一次。');
  }
  if (!AUTO_PUSH) {
    log('--no-push：已拿到标识，但没有推送。');
    return;
  }
  if (pushedChats.has(chatId)) {
    log('本次运行已经推送过，跳过（避免刷屏）。重启脚本可再测一次。');
    return;
  }

  pushedChats.add(chatId);
  setTimeout(() => pushTest(chatId, chatType), 500);
}

function pushTest(chatId, chatType) {
  const cardReqId = nextReqId();
  const cardBody = {
    chatid: chatId,
    chat_type: chatType,
    msgtype: 'template_card',
    template_card: {
      card_type: 'button_interaction',
      task_id: `c2-test-${Date.now()}`,
      main_title: {
        title: '待回复 · C2 测试群 · 张女士',
        desc: '这是机器人主动推送的卡片',
      },
      sub_title_text: '客户原文：今天的用餐记录好像没同步',
      horizontal_content_list: [
        { keyname: '命中规则', value: 'diet-log-missing' },
        { keyname: '风险', value: '低' },
      ],
      button_list: [
        { text: '已发送', style: 1, key: 'ack:draft_test:sent' },
        { text: '我会修改', style: 2, key: 'ack:draft_test:edited' },
        { text: '忽略', style: 4, key: 'ack:draft_test:skipped' },
      ],
    },
  };
  pending.set(cardReqId, '推送卡片');
  log('→ aibot_send_msg（卡片）');
  sendFrame({ cmd: 'aibot_send_msg', headers: { req_id: cardReqId }, body: cardBody });

  setTimeout(() => {
    const textReqId = nextReqId();
    const textBody = {
      chatid: chatId,
      chat_type: chatType,
      msgtype: 'markdown',
      markdown: {
        content: '张女士您好，您反馈的用餐记录问题我们已经收到，营养师今天下午会电话联系您。',
      },
    };
    pending.set(textReqId, '推送正文');
    log('→ aibot_send_msg（正文 markdown）');
    sendFrame({ cmd: 'aibot_send_msg', headers: { req_id: textReqId }, body: textBody });
    log('');
    log('已发送两条。请在手机/PC 企微里观察：');
    log('  1) 是否收到卡片，卡片是否在正文之前');
    log('  2) 卡片按钮是否可点（点一下看终端是否收到 aibot_event_callback）');
    log('  3) 正文那条能否长按复制');
    log('  4) 两条的顺序是否稳定');
  }, 1_200);
}

process.on('SIGINT', () => {
  closing = true;
  log('退出');
  stopPing();
  ws?.close();
  process.exit(0);
});

log('C2-0-A2 机器人主动推送验证');
log(`BotID=${BOT_ID}（Secret 不打印）`);
log(AUTO_PUSH ? '模式：收消息后自动推送卡片 + 文本' : '模式：只接收（--no-push）');
log('');
connect();
