#!/usr/bin/env node
/**
 * 向企业微信「消息推送」/ 群机器人 Webhook 发送一条文本消息。
 *
 * 用途：外部群边界对照实验。
 *   - 内部群：可添加消息推送，本脚本应发送成功。
 *   - 外部群：官方不支持添加，拿不到 Webhook，本脚本无从运行。
 *
 * 用法：
 *   node webhook-send.mjs <webhook_url> "文本"
 *   WECOM_GROUP_WEBHOOK_URL=... node webhook-send.mjs "文本"
 *
 * 只使用 Node 内置模块，无第三方依赖（Node >= 18）。
 */

const args = process.argv.slice(2);

function usage() {
  console.error('用法: node webhook-send.mjs <webhook_url> "文本"');
  console.error('  或: WECOM_GROUP_WEBHOOK_URL=... node webhook-send.mjs "文本"');
  process.exit(1);
}

let url;
let text;

if (args.length >= 2) {
  url = args[0];
  text = args[1];
} else if (args.length === 1) {
  url = process.env.WECOM_GROUP_WEBHOOK_URL;
  text = args[0];
} else {
  usage();
}

if (!url || !text) usage();

// 只允许官方域名，避免误把密钥发到别处
const allowed = ['qyapi.weixin.qq.com'];
let host;
try {
  host = new URL(url).host;
} catch {
  console.error('Webhook URL 不合法');
  process.exit(1);
}
if (!allowed.includes(host)) {
  console.error(`拒绝发送：host=${host}，只允许 ${allowed.join(', ')}`);
  process.exit(1);
}

const startedAt = Date.now();
let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  });
} catch (err) {
  console.error('请求失败:', err.message);
  process.exit(1);
}

const raw = await res.text();
let json;
try {
  json = JSON.parse(raw);
} catch {
  json = null;
}

console.log('HTTP', res.status, `(${Date.now() - startedAt}ms)`);
console.log('响应:', raw);

if (!res.ok) process.exit(1);
if (json && json.errcode !== 0) {
  console.error(`企微返回错误 errcode=${json.errcode} errmsg=${json.errmsg}`);
  process.exit(2);
}
console.log('✅ 已发送。请到群里确认是否收到。');
