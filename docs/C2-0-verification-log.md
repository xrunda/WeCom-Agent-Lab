# C2-0 平台假设验证记录

> 日期：2026-11-08
> 环境：测试企业、测试机器人 `c2-test-bot`（API 模式 / 长连接）、创建者本人账号
> 脱敏：不记录 BotID / Secret；员工 `userid` 统一写作 `<creator>`

## 结论

| 假设 | 结果 | 证据 |
|---|---|---|
| A1 首次对话后可拿到 `userid`，单聊直接作为 `chatid` | ✅ PASS | 回调 `chattype=single`，`from.userid=<creator>`，`chatid=<creator>` |
| A2 机器人可主动推送卡片 + 文本 | ✅ PASS | 两次 `aibot_send_msg` 均返回 `errcode=0`；客户端收到卡片与正文 |
| A3 卡片按钮回调携带自定义 key | ✅ PASS | `event.template_card_event.event_key=ack:draft_test:sent`，`task_id` 原样回传 |
| A4 两段式顺序稳定、可长按复制 | ✅ PASS | 卡片在上、正文在下；PC 复制转发成功；iOS 长按正文出现「复制/转发」菜单 |
| A8 手机端长按复制 | ✅ PASS（iOS） | iOS 长按正文弹出复制菜单；Android 未测 |
| A5 存档能读到员工发出的消息 | ✅ PASS | 解密得到 `from=LiGuang`、`action=send`、`msgtype=text`、`tolist=[joe]`，正文与发送内容一致 |
| A6 存档延迟 | ✅ PASS | 发送 20:10:43 → 20:11:18 已可拉取，**上界 35 秒** |
| A7 `chat_id` ↔ `roomid` 映射 | ✅ PASS | 群消息返回 `wr...@chatroom` 形式 `roomid`；单聊为空串；不同群不同 `roomid` |

## 关键回调（脱敏）

```json
{
  "chattype": "single",
  "from": { "userid": "<creator>" },
  "msgtype": "event",
  "create_time": 1794126818,
  "event": {
    "eventtype": "template_card_event",
    "template_card_event": {
      "card_type": "button_interaction",
      "event_key": "ack:draft_test:sent",
      "task_id": "c2-test-<timestamp>"
    }
  }
}
```

实际回调还包含 `response_url` / `response_code`，可用于后续更新卡片状态。

## 对实现的直接影响

1. **单聊推送**：`body.chatid` 直接填 `from.userid`，`chat_type=1`。
2. **按钮解析**：回调字段是 `event.template_card_event.event_key`（不是 `key`）；适配器已按此映射到 `handleButtonCallback`（`src/c2/adapters/wecom-bot.ts`）。
3. **卡片状态**：回调带 `response_url`，后续可把卡片更新为「已记录」；5 秒响应窗口是否强制仍待验证。
4. **正文格式**：主动推送用 `markdown`（平台不支持 `msgtype=text`）；PC 端复制正常。
5. **连接约束**：同一机器人只允许一个长连接；测试时不要同时开多个脚本。
6. **卡片 `task_id` 必填**：字段缺失时推送返回 `42014 taskid has existed or empty or exceed max len`。C2 按 `c2-<draftId>-<createdAt36>` 生成，控制在 32 字符内；重试遇到 42014 视为「已送达」做幂等处理。

## 复现步骤

```bash
npm install
# .env.local 填 WECOM_BOT_ID / WECOM_BOT_SECRET（长连接凭证）
npm run bot:test   # 裸协议：订阅 → 收消息 → 推卡片 + 正文 → 打印按钮回调
npm run bot:live   # C2 编排：真实草稿 → 串行推送 → 按钮 → 状态机（未接存档）
# 在企微里私聊机器人发「测试」
# 观察终端：aibot_msg_callback → 推送卡片 ok → 推送正文 ok
# 点卡片「已发送」→ 观察 aibot_event_callback.event_key
```

## C2-2 机器人侧真实联调（2026-11-08）

`npm run bot:live` 单聊实测（`task_id` 补上后）：

```text
收到消息 userid=<creator> chattype=single
已登记顾问 <creator>，并绑定两个测试群（内存）
草稿已入队 draft_1 → A 群（测试）
推送 draft_1 pushed=true
状态：共 1 条，PUSHED=1，QUEUED=0
收到事件 template_card_event key=ack:draft_1:sent task=c2-draft_1-<ts>
确认成功 draft_1 → ACKNOWLEDGED （sent）
状态：共 1 条，PUSHED=0，QUEUED=0
  draft_1 ACKNOWLEDGED A 群（测试） ack=sent
```

结论：真实机器人侧闭环成立——卡片+正文推送、按钮回调、草稿状态机流转都跑通。存档回读校验未接，仍是 `ACKNOWLEDGED` 而非 `VERIFIED`。

### 4 条草稿串行联调（2026-11-08）

```text
08:55:59 收到事件 template_card_event key=ack:draft_4:sent task=c2-draft_4-<ts>
08:55:59 确认成功 draft_4 → ACKNOWLEDGED （sent）
08:55:59 状态：共 4 条，PUSHED=0，QUEUED=0
  draft_1 ACKNOWLEDGED A 群（测试） ack=sent
  draft_2 ACK_EDITED   B 群（测试） ack=edited
  draft_3 ACKNOWLEDGED A 群（测试） ack=sent
  draft_4 ACKNOWLEDGED B 群（测试） ack=sent
```

4 条依次推送、未确认不推下一条；「我会修改」路径（ACK_EDITED）也已走通。`忽略`（SKIPPED）未单独测。

> 后续调整：卡片已去掉「我会修改」，只保留「已发送 / 忽略」。是否照原文发出改由存档相似度判定（`VERIFIED` / `EDIT_SENT`），不再依赖员工自报。本节保留当时的三按钮形态作为历史记录。

### 移动端观察（A4/A8）

- 卡片与正文是**两条独立消息**，顺序为卡片 → 正文；长按正文弹出「复制 / 转发 / 引用」菜单。
- 正文气泡底部有平台的「内容由 AI 生成」标识和反馈按钮；**复制正文时是否带入该标识尚未确认**。若会带入，需要评估客户群观感或做正文/标识的分离。

## 会话存档 SDK 连通（2026-11-08）

环境：Ubuntu VM x86_64 / OpenSSL 3.0.13 / 官方 `sdk_x86_v3_20250205`，`g++ -O2 -std=c++17 tool_testSdk.cpp -o sdktools -ldl`。

排障过程：

1. 首次调用返回 `GetChatData err ret:10001`，底层 `errcode:40001 invalid credential`，日志带 `"from ip": <服务器公网IP>`。
2. 定位：该 IP 不在会话存档的可信 IP 列表；Secret 仍不可用。
3. 加入可信 IP + 后台轮换「会话内容存档 → Secret」并更新 `config.txt` 后解决。

连通结果（脱敏）：

```text
./sdktools 1 0 10 "" "" 5
GetChatData len:41 data:{"errcode":0,"errmsg":"ok","chatdata":[]}
```

- `errcode=0` 说明 CorpID / Secret / 可信 IP 三者匹配，SDK 初始化与拉取链路正常。
- `chatdata` 为空是数据面问题：席位开通后、授权员工尚未产生可存档消息。存档只覆盖**开通之后**的消息，且平台侧最长保留 5 天。
- 下一步 A5：让**已授权的那名员工**（开启范围 1 人）在测试外部客户群发一条文字，等 1–2 分钟后用同一 `seq` 重拉。

注意：不要把 `encrypt_random_key` / `encrypt_chat_msg` 或 Secret 贴到聊天里；只记录条数、`publickey_ver`、`msgtype`、`roomid` 这类结构性字段。

### 首次拉到数据（A5 采集侧）

```text
GetChatData len:1870
errcode=0, chatdata 条数=2
  seq=19  msgid=11245041092309839241_<ts>           publickey_ver=1
  seq=20  msgid=14100324883272001601_<ts>_external  publickey_ver=1
```

- 有数据说明：CorpID / Secret / 可信 IP / 席位 / 订单 全部生效，采集链路正常。
- 第二条 msgid 带 `_external` 后缀，说明外部会话单独入库（与官方口径一致）。
- 剩余：用私钥 RSA 解 `encrypt_random_key` → `DecryptData`，取 `msgtype`/`msgtime`/`roomid`/`from` 才能判定 A5（内容）、A6（延迟）、A7（映射）。
- 工具：[experiments/minimal/session-archive/archive_dump.cpp](../../experiments/minimal/session-archive/archive_dump.cpp)。

### 解密结果（A5 PASS）

自建 RSA 密钥对 → 后台「消息加密公钥」设置后版本升到 2，新消息用 ver 2 加密。

```text
=== seq=21 msgid=5654043956659631931_<ts> ===
{"msgid":"5654043956659631931_<ts>","action":"send","from":"LiGuang","tolist":["joe"],
 "roomid":"","msgtime":1794139161587,"msgtype":"text","text":{"content":"存档测试 ver2 ..."}}

下次拉取用 seq=21（增量）
```

结论：

| 项 | 结果 |
|---|---|
| 员工发出的消息可读 | ✅ `action=send`、`from`、`tolist`、`text.content` 齐全 |
| `msgtime` 单位 | **毫秒**（与 `msgid` 尾部时间戳一致） |
| `roomid` | 内部单聊为空字符串，群消息才会带值 |
| 旧版本公钥 | `publickey_ver=1` 的 seq 19/20 换公钥后无法解密（预期行为） |
| 增量拉取 | 用返回的最大 `seq` 作为下次起点 |

实现要点：`NewSdk()` 返回 `void*`，其余接口要 `WeWorkFinanceSdk_t*`；直接调用需 `-L. -lWeWorkFinanceSdk_C -Wl,-rpath,'$ORIGIN'`（官方 demo 走 `dlopen` 所以只加了 `-ldl`）。

### 群消息与外部会话（A7 PASS）

```text
seq=22  msgid=<id>_<ts>_external    action=send  from=LiGuang
        tolist=["wmCn3iEQ...","wmCn3iEQ..."]        ← 外部联系人
        roomid="wrCn3iEQAxFkXh0EqGlSBLHbApFoX0Q"

seq=23  msgid=<id>_<ts>             action=send  from=LiGuang
        tolist=["joe","aibqwio..."]                 ← 内部成员
        roomid="wrCn3iEQAAD4ubp9CV78MJVxIGcKZVJA"
```

结论：

| 项 | 结果 |
|---|---|
| 群聊 `roomid` | 有值，`wr` 前缀，**每个群独立**；单聊为空串 |
| 外部群是否可读 | ✅ 读到了，说明「外部客户未同意」不等于整段不入库（本次客户侧已收到服务须知） |
| 群内 `tolist` | 列出群成员：外部会话为 `wm...`，内部会话为 `userid` |
| 映射需求 | 只需**每个群发一条消息**记录一次 `roomid`，即可建立「业务群 ID ↔ roomid」 |
| `seq` 增量 | 每次拉取返回最大 `seq` 作为下次起点，避免重复解密 |

### 存档延迟（A6 PASS）

```text
20:10:32  date +%T            （发消息前）
20:10:43  msgtime             （"A6 计时"实际发出时刻，由 msgtime 换算）
20:11:18  date +%T            （该条已可拉取）
```

- 延迟上界 **35 秒**，实际可能更短（只记录了首次观察时刻）。
- `msgtime` 为毫秒时间戳，换算后与客户端时间一致，可直接用于延迟计算。
- 对 C2 的含义：员工点「已发送」后，**半分钟内即可回读校验**，不需要把校验排到几小时后；错群能很快发现。

## C2-2-04 端到端联调（2026-11-08）

运行环境：腾讯云 Ubuntu VM（x86_64），Node v22.23.4，`archive_dump` + 官方 C SDK，真实机器人长连接。

```text
12:31:30 已订阅智能机器人长连接
12:31:51 收到消息 userid=LiGuang chattype=single
12:31:51 草稿 draft_1 已入队 → 存档测试群
12:31:52 推送 draft_1 pushed=true
12:32:51 收到事件 key=ack:draft_1:sent
12:32:51 已确认 draft_1 → ACKNOWLEDGED，45 秒后回读
12:33:51 存档拉入 7 条，seq=27
12:33:51 校验结果 VERIFIED msgid=4054793989717257811_<ts>
12:33:51 状态：共 1 条 VERIFIED=1
```

结论：**C2 全链路在真实环境闭环成立**——机器人推送 → 人工复制转发 → 会话存档回读 → 匹配校验。

### 第一次失败（有价值的负面样本）

第一轮员工在**正文尚未发到群里**时就点了「已发送」：

```text
12:27:04 已确认 draft_1 → ACKNOWLEDGED
12:28:08 存档拉入 5 条，seq=25        ← 存档正常，但群里没有正文
12:29:08 / 12:30:08 / ...            ← 每次重试仍未匹配
```

即：草稿停在 `ACKNOWLEDGED` 并按退避重试，不会误判为已发送。这正是 C2 设计要抓的「口头确认但实际没发」。按配置第 5 次失败后判 `UNVERIFIED` 并告警。

### 操作顺序（联调必须遵守）

1. 机器人推送卡片 + 正文；
2. **先把正文复制并发送到目标群，肉眼确认群里出现**；
3. 再点卡片「已发送」；
4. 约 10–15 秒后自动回读校验（默认首次延迟 10 秒，未匹配每 15 秒重试，最多 6 次）。

跳过第 2 步的确认，就会出现上面那次失败。

### 校验节奏调整（2026-11-08）

首次联调用的是「45 秒首查 + 60 秒退避 × 5」，确认后要等近 1 分钟才出结果，太慢。按 A6 实测「存档延迟上界 35 秒」重新排：

| 参数 | 旧值 | 新值 | 说明 |
|---|---|---|---|
| `VERIFY_DELAY_MS` | 45000 | 10000 | 点「已发送」后首次回读 |
| `VERIFY_RETRY_MS` | 60000 | 15000 | 未匹配时的重试间隔 |
| `TICK_INTERVAL_MS` | 20000 | 5000 | 队列与校验的轮询间隔 |
| `maxVerifyAttempts` | 5 | 6 | 6 次 × 15 秒 ≈ 90 秒内必有结论 |

- 10 秒首查可能偶尔早于存档落库（上界 35 秒），但 15 秒一次的快速重试会补上，整体比原来快 3–4 分钟。
- 没有到期的草稿时，5 秒轮询只是内存判断，不会调用 `archive_dump`，开销可忽略。
- 以上都可用环境变量临时覆盖，例如 `VERIFY_DELAY_MS=5000 VERIFY_RETRY_MS=10000 npm run bot:e2e`。

## C2-2-05 存档触发联调（2026-11-08）

目标：**员工不用私聊机器人**，客户在外部群里发一句就能起一条草稿。

真实外部群 `wrCn3iEQAAxFkXh0EqGlSBLHbApFoX0Q`（5 人，2 位外部联系人已同意存档）；
客户侧发送者用李光的**个人微信**（`wm...`，在存档里被当作外部客户）。

```text
13:22:30 存档拉入 1 条，seq=37
13:22:30 命中客户消息 851852329420797755_<ts>_external ← wmCn3iEQAAbk0VSVZLx60mm4PS9NF0sA（群 存档测试群）
13:22:30 草稿 draft_1 已入队 ← 客户 wmCn3iEQAAbk0VSVZLx60mm4PS9NF0sA
13:22:35 推送 draft_1 成功
13:2x:xx 员工把正文发到外部群 → 存档回读匹配
13:26:10 状态：共 1 条 VERIFIED=1
          draft_1 VERIFIED 存档测试群 ack=send verify=VERIFIED
```

结论：**客户群消息 → 存档触发 → 草稿推送 → 人工转发 → 存档回读 VERIFIED** 全链路在真实外部群成立，全程没有私聊机器人。

### 卡片按钮不会变（不是故障）

员工在草稿已 `VERIFIED` 后又点了卡片「已发送」，终端出现：

```text
13:26:37 收到事件 key=ack:draft_1:sent
13:26:37 确认失败： DRAFT_NOT_PUSHED draft_1 status=VERIFIED
```

回调本身正常到达（`aibot_event_callback` → `event_key` 解析成功），只是草稿已进入终态，`acknowledge` 拒绝重复确认。两点平台事实与两点实现修正：

- **平台事实 1**：模板卡片按钮点完不会自动置灰/变文案，卡片是静态的，除非机器人用回调里的 `response_url` 主动更新。
- **平台事实 2**：`task_id` 复用不会让平台拒绝新的按钮回调，旧卡片仍可点。
- **修正 1**：非 `PUSHED` 且已确认/终态时改报 `ALREADY_ACKNOWLEDGED`，`DRAFT_NOT_PUSHED` 只留给我们自己还没推出去的情况；联调脚本把它当「重复点击，忽略」而不是失败。
- **修正 2**：联调脚本的草稿 id 加进程级前缀（`draft_<runTag>_<n>`）。原先每次启动都从 `draft_1` 开始，上一轮残留的旧卡片 `ack:draft_1:sent` 会打到本轮的新草稿上。

未做（下一步）：用 `response_url` 把卡片更新成「已记录」，让按钮点完有可见反馈。

### C2-2-06 误点「已发送」：失败静默（已修）

员工点了「已发送」但**没有真的往群里发**。按配置（首次 10 秒、每 15 秒重试、最多 6 次），约 85 秒后草稿转 `UNVERIFIED`，服务端日志有 `校验结果 UNVERIFIED`，但机器人**一句话都没发**。

原因在 `Verifier`：`res.draftId` 只在「匹配成功」那条返回路径上回填，`UNVERIFIED` 分支提前 `return res`，`draftId` 还是 `undefined`；上层 `res.draftId ? store.getDraft(...) : undefined` 拿不到草稿，就跳过了通知。

- 修正：`draftId` 在 `matchSentMessage` 之后立刻回填，所有分支都带。
- 回归：`tests/scenario.test.ts` 的 UNVERIFIED 用例断言 `round.verified` 里那条结果带 `draftId`。
- 顺带调整：回执原来写死「约 10 秒后告诉你结果」，只有成功时成立；改成「顺利的话 10 秒内出结果；若一直没找到，最迟约 85 秒告诉你失败」，秒数由 `VERIFY_DELAY_MS` / `VERIFY_RETRY_MS` / `VERIFY_MAX_ATTEMPTS` 算出。

仍未解决：判了 `UNVERIFIED` 之后员工再补发，程序不会再发现（终态）。需要「迟到窗口」的话得改状态机语义。

修复后真机复测通过（22:36，群「客户-汪女士-20261108」）：

```text
待回复 · 客户-汪女士-20261108        ← 群名独占标题，不再被客户名挤掉
客户    外部客户 9NfOsA · 22:36      ← 客户行带东八区最后发言时间
群成员  外部客户 9NfOsA、外部客户 D75oBw、WangXing   ← 群名来自 config，成员行是补充不是重复

已记录「已发送」（客户原文「测试午餐红薯高蛋白肉类」）。
正在回读会话存档确认：顺利的话 10 秒内出结果；若一直没找到，最迟约 85 秒会告诉你失败。

❌ 没有在「客户-汪女士-20261108」里找到这条正文（重试 6 次）。请确认是否真的粘贴发出去了。
这条草稿已经处理过了（UNVERIFIED），无需重复点击。   ← 再点一次的表现
```

即：误点「已发送」而不真发，系统能在 ~85 秒内明确报失败，且重复点击有解释。

## 已知限制与后续（2026-11-09 收尾）

企微侧已清零。以下是明知不做、或交给业务侧的：

- **卡片按钮不会置灰**：用 `response_url` 更新卡片属于纯外观收益，已由文字回执承担反馈，归档。
- **错群真机复测**：逻辑已被 `tests/scenario.test.ts` 覆盖，`roomid` 准确性在排查「群不符」那几天已被实测证明，归档。
- **`UNVERIFIED` 之后的迟到补校验**：判失败后员工再补发，程序不会再发现。只影响系统内状态准确性，不影响客户是否收到回复，归档。
- **群名/成员自动获取**：代码在，卡在后台建自建应用；现用 `GROUP_NAME` 兜底。重新打开条件见 ISSUES C2-2-06。
- **多群全量采集 + 业务判定**：下一步方向，见 ISSUES 的 C2-3。注意 C2-3-04（日志脱敏）必须先于放开采集。
