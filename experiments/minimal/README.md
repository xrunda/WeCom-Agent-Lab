# 最小实验脚本

这里的代码只用于验证企微平台能力边界，**不是业务后端**，也不包含 MCP、工作流、数据库。

| 文件 | 用途 | 前提 |
|---|---|---|
| `webhook-send.mjs` | 向「消息推送」/群机器人发一条文本 | 内部群（外部群无 Webhook） |
| `callback-echo.mjs` | 抓取回调原始请求，先看清格式 | 有公网可达地址 |
| `wecom-crypt.mjs` | 企微标准 AES 解密/签名 | 有 EncodingAESKey |
| `aibot-push.mjs` | 智能机器人长连接：收消息 → 主动推送卡片 + 文本 | API 模式机器人（BotID/Secret） |
| `session-archive/` | 会话存档接入说明与前置条件 | 已开通存档 |

## 快速检查

```bash
node --check webhook-send.mjs
node --check callback-echo.mjs
node --check wecom-crypt.mjs
```

## 发送一条测试消息

```bash
WECOM_GROUP_WEBHOOK_URL='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' \
  node webhook-send.mjs 'M1 内部群对照测试'
```

成功应返回 `{"errcode":0,"errmsg":"ok"}`，群里收到消息。

## 抓回调

```bash
PORT=8787 node callback-echo.mjs
# 另开终端暴露公网，例如：
# cloudflared tunnel --url http://localhost:8787
```

把拿到的公网 URL 填到企微后台的回调配置，触发一次，观察 `experiments/minimal/out/callbacks.log`。

## 验证机器人主动推送（C2-0-A2，生死项）

前置：后台已创建 **API 模式** 智能机器人，可见范围包含你自己的测试账号。

```bash
npm install                                      # 安装 ws（Node 内置 WebSocket 与企微握手不兼容）
cp config/.env.example .env.local
# 填 WECOM_BOT_ID / WECOM_BOT_SECRET（机器人详情里的「长连接」凭证）

npm run bot:test                                 # 收到消息后自动推卡片 + 文本
node experiments/minimal/aibot-push.mjs --no-push # 只收消息，先看回调字段
```

脚本启动后，在企微客户端里私聊这个机器人发一句「测试」。观察：

1. 终端是否打印 `aibot_msg_callback`，里面有 `from.userid`
2. 是否收到 `推送卡片 ok` / `推送正文 ok`
3. 手机上是否先收到卡片、再收到正文
4. 点卡片按钮，终端是否出现 `aibot_event_callback`

`WECOM_BOT_SECRET` 只放在本地 `.env.local`，不要提交、不要截图。

常见错误：

| 现象 | 原因 | 处理 |
|---|---|---|
| `close code=1006`，没有订阅响应 | 用了 Node 内置 WebSocket，与企微握手不兼容 | `npm install`，脚本已改用 `ws` |
| `errcode=853000 invalid bot_id or secret` | BotID / Secret 与后台不一致 | 在机器人详情页用 **复制按钮** 重新复制 Secret；不要手抄，不要点重置 |
| 客户端搜不到机器人 | 智能机器人不在通讯录里 | 工作台 → 智能机器人 → 去使用；或详情页 `…` → 扫码/链接 |
| 只有创建者能聊 | 可使用方式为「仅个人使用」 | 编辑为「多人使用」并添加成员 |

## 解密

```bash
node wecom-crypt.mjs decrypt '<EncodingAESKey>' '<Base64密文>'
node wecom-crypt.mjs sign '<token>' '<timestamp>' '<nonce>' '<encrypt>'
```

## 离线自测

`wecom-crypt.mjs` 的加解密可用下面的方式自测（不依赖企微）：

```bash
node -e "
import('./wecom-crypt.mjs').then(m => {
  const key = 'a'.repeat(43);
  console.log('key ok:', m.decodeAesKey(key).length === 32);
});
"
```

> 注意：AES 工具未在真实企微回调上验证过。第一次接入务必先用 `callback-echo.mjs` 抓包比对格式，
> 不同产品（应用消息 / 智能机器人 / 会话存档）的回调信封可能不同。
