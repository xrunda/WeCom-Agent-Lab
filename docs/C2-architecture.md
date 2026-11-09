# C2 架构设计：草稿 + 员工人工发送（串行队列）

> 版本 v0.1 ｜ 2026-11-08 ｜ 状态：**设计草案，不属于 M1 验收范围**
> 前置决策：只做 C2；不采用企业群发（C1）；草稿由后台确定性规则引擎生成；
> 员工端使用 API 模式智能机器人 1:1 会话；会话存档预算已批。

---

## 1. 一句话定义

> 系统自动读取外部客户群消息，生成待发回复草稿，通过机器人推给负责员工；
> 员工在企微里复制正文、粘贴到对应客户群；系统再通过会话存档回读，验证"是否发了、发对群没有"。

**AI 负责内容，人负责发送。** 平台不提供自动发群的能力，这是 C2 成立的前提。

---

## 2. 范围

### 做

- 外部客户群消息的自动读取（会话存档）
- 消息与客户群、负责员工的映射
- 识别 + 规则匹配 + 草稿生成
- 机器人 1:1 推送草稿
- **每顾问串行队列**
- 员工确认动作回传
- 存档回读校验与错群告警
- 全链路审计

### 不做

- 企业群发 / 一键发送（C1）
- 机器人自动向外部群发消息（平台不支持）
- 机器人内置模型生成草稿（API 模式没有内置模型）
- 多顾问协同工作流、排班、工单
- 完整 CRM、订单、支付

---

## 3. 平台约束（设计必须服从）

| 约束 | 值 | 设计后果 |
|---|---|---|
| 智能机器人进入外部群 | ❌ 不支持 | 机器人只在员工 1:1 会话里 |
| 会话存档时间窗 | ≤ 5 天 | 服务必须常驻并监控，宕机超 5 天丢消息 |
| 会话存档延迟 | 分钟级 | 草稿不是秒回 |
| 存档需客户同意 | 不同意的客户不入档 | 该客户退化为人工贴消息（C0） |
| 机器人主动推送 | API 模式长连接 | 需常驻 WS、重连、单连接限制 |
| 机器人推送需要 `chatid` | 单聊填员工 `userid`；群聊填回调里的 `chatid` | 员工必须先给机器人发过消息；单聊 `userid` = 推送 `chatid` |
| 机器人频率 | 第三方口径 30 条/分、1000 条/时 | 草稿推送量远低于此 |
| 存档媒体 | 单次 ≤ 512KB，`sdkfileid` 拉取 | 图片需分片拉取 |
| 群聊标识 | 存档 `roomid` / 客户群 `chat_id` | 需建立映射，不同调用方 `chat_id` 不同 |

---

## 4. 三种会话与角色

| 会话 | 成员 | 机器人 | 谁操作 |
|---|---|---|---|
| 外部客户群 | 外部客户 + 员工 | ❌ | 客户发消息；员工发回复 |
| 顾问 ↔ 机器人 1:1 | 一个员工 + 机器人 | ✅ | 员工收草稿、点确认 |
| 内部群 | 只有员工 | ✅ | **C2 不使用** |

**关键**：机器人不在任何外部群；外部客户永远进不了内部群；草稿只出现在员工私聊里。

---

## 5. 端到端流程

```text
外部客户群 A/B/C
      │ 客户发文字 / 图片
      ▼
企微服务器 ──会话存档 SDK──▶ ① 采集器（轮询、解密、去重）
                                   │
                                   ▼
                          ② 映射（roomid → 客户群 → 顾问）
                                   │
                                   ▼
                          ③ 识别（图片→食材/未知项）
                                   │
                                   ▼
                          ④ 规则引擎 → 草稿（绑定规则 ID）
                                   │
                                   ▼
                          ⑤ 草稿库（状态：QUEUED）
                                   │
                          ⑥ 串行调度器（每顾问一条活跃草稿）
                                   │
                          API 模式机器人长连接（ws）
                                   │
                                   ▼
                          顾问 ↔ 机器人 1:1
                    ┌────────────────────────────┐
                    │ 卡片：A群·张女士·规则R-012 │
                    │ [已发送]            [忽略] │
                    ├────────────────────────────┤
                    │ 正文气泡（只含回复内容）    │
                    └────────────────────────────┘
                                   │
                          员工长按复制正文 → 粘贴到 A 群
                                   │
                                   ▼
                          ⑦ 校验器（存档回读）
                     A群匹配到 → VERIFIED
                     B群匹配到 → MISROUTE_ALERT
                     未匹配   → UNVERIFIED
```

**生成可并行，投递必须串行。** 这是本方案的核心不变量。

---

## 6. 系统组件

| 组件 | 职责 | 常驻 |
|---|---|---|
| Archive Collector | 调官方 SDK 拉取、解密、去重、落库 | ✅ |
| Mapper | `roomid` → 客户群 → 顾问；缺失时进未分配队列 | — |
| Analyzer | 图片识别、文本提取 | — |
| Rule Engine | 确定性规则匹配，输出草稿与规则 ID | — |
| Draft Store | 草稿与版本 | — |
| Queue Scheduler | 每顾问串行发放 | ✅ |
| Bot Gateway | 长连接、推送、按钮回调 | ✅ |
| Verifier | 存档回读匹配 | ✅ |
| Audit Log | 全动作留痕 | — |

PoC 阶段可用单体进程 + SQLite；生产再拆。

---

## 7. 数据模型

### 7.1 核心表

```sql
advisor(
  userid            TEXT PRIMARY KEY,   -- 企微员工 UserID
  name              TEXT,
  bot_chatid        TEXT,               -- 与机器人的 1:1 会话 ID（待验证获取方式）
  status            TEXT,               -- active / paused / left
  created_at        INTEGER
)

customer_group(
  roomid            TEXT PRIMARY KEY,   -- 会话存档中的群 ID
  chat_id           TEXT,               -- 客户群接口的 chat_id（可能不同）
  group_name        TEXT,
  advisor_userid    TEXT,               -- 负责顾问
  status            TEXT,               -- mapped / unassigned / disabled
  updated_at        INTEGER
)

customer(
  external_userid   TEXT PRIMARY KEY,
  display_name      TEXT,               -- 仅内部可见，不进入草稿
  advisor_userid    TEXT,
  archive_consent   INTEGER             -- 1=已同意存档
)

inbound_message(
  msgid             TEXT PRIMARY KEY,   -- 存档消息 ID，天然去重
  roomid            TEXT,
  sender_type       TEXT,               -- external / internal
  sender_id         TEXT,
  msgtype           TEXT,
  content_text      TEXT,               -- 文本消息正文
  media_sdkfileid   TEXT,               -- 图片/文件
  msgtime           INTEGER,
  seq               INTEGER,            -- 存档序号
  processed_at      INTEGER
)

draft(
  id                TEXT PRIMARY KEY,
  inbound_msgid     TEXT,
  group_roomid      TEXT,
  customer_id       TEXT,
  advisor_userid    TEXT,
  body              TEXT,               -- 草稿正文（员工可改，改后存 version）
  rule_ids          TEXT,               -- JSON 数组，可追溯
  risk_level        TEXT,               -- low / medium / high
  status            TEXT,
  version           INTEGER DEFAULT 1,
  created_at        INTEGER,
  updated_at        INTEGER
)

delivery(
  draft_id          TEXT,
  chatid            TEXT,
  card_msg_id       TEXT,
  body_msg_id       TEXT,
  pushed_at         INTEGER,
  ack_action        TEXT,               -- sent / skipped
  ack_at            INTEGER
)

verification(
  draft_id          TEXT,
  expected_roomid   TEXT,
  matched_msgid     TEXT,
  matched_roomid    TEXT,
  similarity        REAL,
  result            TEXT,               -- verified / edited_sent / misroute / unverified
  checked_at        INTEGER
)

audit_event(
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  actor             TEXT,
  action            TEXT,
  target            TEXT,
  result            TEXT,
  error_code        TEXT,
  at                INTEGER
)
```

### 7.2 队列

```sql
advisor_queue(
  advisor_userid    TEXT PRIMARY KEY,
  active_draft_id   TEXT,               -- NULL 表示空闲
  updated_at        INTEGER
)
```

**不变量**：`active_draft_id` 非空时，不得向该顾问推送任何新草稿。

---

## 8. 草稿消息格式（两段式）

### 8.1 第一条：上下文卡片

```text
┌─────────────────────────────────────┐
│ 待回复 · A群 · 张女士               │
│ 客户原文：今天午饭吃了米饭鸡胸肉…   │
│ 命中规则：R-012、R-018              │
│ 风险：中                            │
│ [已发送]              [忽略]        │
└─────────────────────────────────────┘
```

- 卡片**不含**要复制的内容，避免员工连标题一起复制。
- 只有两个按钮：是否照原文发出由存档回读判定，员工不必自报「我改过」。
- `A群·张女士` 必须显著，这是防串户的第一道标识。
- 按钮回调携带 `draft_id`。

### 8.2 第二条：正文气泡

```text
张女士，这张午餐照片里能确认的是米饭、鸡胸肉、西兰花；
按您当前生效的规则，晚餐建议补一份绿叶菜，酱汁少放。
以上仅基于照片可见内容。
```

- **纯文本，只含要发出去的内容。**
- 员工长按 → 复制 → 到目标群粘贴。
- 建议 ≤ 500 字；过长时压缩，不拆条（拆条会破坏复制体验）。
- 平台差异：`aibot_send_msg` 主动推送支持 `template_card` / `markdown` / 文件 / 图片等，**不支持 `msgtype=text`**。实现时用 `markdown` 承载这段纯文本，客户端显示仍是一条文本气泡；长按复制体验列入 C2-0-A4 实测。

### 8.3 为什么分两条

| 合并成一条 | 分两条 |
|---|---|
| 长按复制会把"发往 A 群"一起复制进去 | 正文干净 |
| 员工要手动删标题，容易删错 | 零编辑 |
| 出错概率高 | 出错概率低 |

---

## 9. 串行队列

### 9.1 规则

| 规则 | 说明 |
|---|---|
| 队列键 | `advisor_userid`，每个顾问一条独立队列 |
| 并发度 | **1**：同一顾问同时只有一条 `PUSHED` 未处理的草稿 |
| 排序 | 按 `msgtime` FIFO；同一群的多条消息按时间聚合 |
| 合并窗口 | 同一群 90 秒内的多条消息合并为一条草稿 |
| 空闲判定 | 当前草稿变为 `VERIFIED` / `EDIT_SENT` / `SKIPPED` 后，才发下一条 |
| 阻塞 | 顾问不处理，后续草稿一直等待，**不自动跳过**（跳过会破坏安全性） |
| 提醒 | 推送后 15 分钟未处理，机器人发一次提醒 |
| 升级 | 60 分钟未处理，通知主管/管理员 |
| 改派 | 主管可把草稿改派给其他顾问的队列 |
| 离线 | 顾问不在线不推送，草稿保持 `QUEUED`；上线后继续 |

> 设计取舍：串行会降低吞吐，但消灭了"多条草稿混在一起、记错目标群"的认知负担。
> 客户群的消息通常不是秒级高频，这个交换值得。

### 9.2 调度伪代码

```python
def tick():
    for advisor in active_advisors():
        if queue.active_draft_id is not None:
            handle_timeouts(advisor)
            continue
        next_draft = pick_next(advisor)          # FIFO, status=QUEUED
        if next_draft is None:
            continue
        try:
            push_card_and_body(advisor, next_draft)
            queue.active_draft_id = next_draft.id
            next_draft.status = "PUSHED"
        except PushError as e:
            next_draft.status = "FAILED"
            audit("push_failed", advisor, next_draft.id, e.code)
            # 不跳队，下一轮重试；连续失败 3 次告警
```

### 9.3 状态机

```text
RECEIVED ─▶ ANALYZED ─▶ DRAFTED ─▶ QUEUED
                                     │
                                     ▼
                                  PUSHED ──(推送失败)──▶ FAILED
                                     │
              ┌──────────────────────┴──────────────────────┐
              ▼                                             ▼
        ACKNOWLEDGED(已发送)                          SKIPPED(忽略)
              │
              ▼
        ┌─────┴─────┬──────────────┬──────────────┐
        ▼           ▼              ▼              ▼
    VERIFIED    EDIT_SENT   MISROUTE_ALERT   UNVERIFIED
   (原文一致)  (有改动)      (在错误群匹配)    (超时未匹配)
```

> 卡片只有「已发送 / 忽略」两个按钮。是否照原文发出，**不由员工自报**：点「已发送」后回读存档，
> 精确匹配 → `VERIFIED`，相似度 ≥ 阈值 → `EDIT_SENT`。

| 状态 | 含义 | 是否释放队列 |
|---|---|---|
| `QUEUED` | 等待推送 | 否 |
| `PUSHED` | 已推送，等待员工动作 | **否**（关键） |
| `ACKNOWLEDGED` | 员工点了已发送 | 是 |
| `SKIPPED` | 员工点忽略 | 是 |
| `VERIFIED` | 存档在目标群匹配到 | 是 |
| `EDIT_SENT` | 存档匹配到修改版 | 是 |
| `MISROUTE_ALERT` | 存档在别的群匹配到 | 是（并告警） |
| `UNVERIFIED` | 超时未匹配 | 是（并提醒） |
| `FAILED` | 推送失败 | 是（重试） |

> 注意：`ACKNOWLEDGED` 就释放队列，但校验仍在后台继续。否则存档延迟（分钟级）会把队列卡住。

---

## 10. 存档回读校验

### 10.1 匹配流程

```text
员工点"已发送" → 记录 ack_at
      │
      ▼
等待 T1（默认 3 分钟，可配）
      │
      ▼
拉取该顾问在 [ack_at-10min, now] 的所有发送消息
      │
      ▼
归一化文本（去空白、全半角、标点）
      │
      ├─ 在 expected_roomid 精确匹配 → VERIFIED
      ├─ 在 expected_roomid 模糊匹配（相似度≥0.9）→ EDIT_SENT，保存实际文本
      ├─ 在其他 roomid 匹配 → MISROUTE_ALERT（最高优先级告警）
      └─ 均未匹配 → UNVERIFIED
```

### 10.2 错群处理

| 结果 | 动作 |
|---|---|
| `MISROUTE_ALERT` | 立即通知员工本人 + 主管；工单记录；建议员工在正确群补发并撤回 |
| 连续 2 次错群 | 暂停该顾问的自动推送，人工复核后恢复 |
| `UNVERIFIED` 超 30 分钟 | 提醒员工"是否已发送" |

错群是**事后发现**，客户已经看到了。所以校验是兜底，不能替代第 8 节的标注和串行队列。

### 10.3 匹配不上的合理原因

- 员工大幅改写
- 员工分多条发送
- 存档延迟超过等待窗口
- 客户未同意存档（该消息不在存档里）

这些都要记录原因，不要一律判为"未发送"。

---

## 11. 接口清单

### 11.1 企微侧

| 用途 | 接口 / 方式 |
|---|---|
| 读消息 | 会话存档 SDK：`GetChatData` → `DecryptData`；媒体 `GetMediaData` |
| 拉媒体 | `GetMediaData`，`indexbuf` 续传，单次 ≤ 512KB |
| 客户群信息 | `externalcontact/groupchat/list`、`groupchat/get` |
| 机器人推送 | API 模式 `aibot_send_msg`（长连接） |
| 机器人事件 | `aibot_event_callback` |
| 机器人消息 | `aibot_msg_callback`（含 `chatid`、发送者、内容） |

### 11.2 内部侧（建议）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/internal/drafts` | 草稿入库 |
| POST | `/internal/approvals` | 员工动作回传 |
| POST | `/internal/reassign` | 主管改派 |
| GET | `/internal/queues` | 队列状态 |
| GET | `/health` | 采集/连接/队列健康 |

---

## 12. 员工开通流程

```text
1. 管理员创建 API 模式机器人，可见范围 = 顾问组
2. 每个顾问打开机器人，发送任意一句（如"启动"）
3. 后台收到 aibot_msg_callback → 记录 userid + chatid
4. 管理员在映射表里把客户群 A/B/C 分配给该顾问
5. 发一条测试草稿 → 顾问确认收到
```

> **待验证**：机器人能否主动向从未对话过的员工发起 1:1 会话。
> 如果不能，第 2 步就是强制前置。见第 15 节。

---

## 13. 失败处理

| 场景 | 处理 |
|---|---|
| 长连接断开 | 指数退避重连；重连后不重发已 `PUSHED` 的草稿（按 `draft_id` 幂等） |
| 新连接踢掉旧连接 | 单实例部署；多实例需 leader 选举，PoC 不做 |
| 推送 API 超时 | 重试 3 次；仍失败标 `FAILED` 并告警 |
| 存档拉取失败 | 重试；记录 `seq` 断点；监控 5 天窗口余量 |
| 重复回调 | `msgid` 去重 |
| 图片下载失败 | 草稿降级为"图片无法读取，请人工确认"，不阻塞队列 |
| 群映射缺失 | 进"未分配"队列，通知管理员，不推送 |
| 客户未同意存档 | 该客户标记 `consent=0`，不生成草稿，提示顾问手动处理 |
| 顾问离职 | 队列转给主管，映射表重分配 |

---

## 14. 安全与合规

- 草稿与原始消息加密存储；日志不输出正文与图片原文。
- 顾问只能看到自己队列里的草稿（按 `advisor_userid` 隔离）。
- 所有动作写 `audit_event`：生成、推送、确认、忽略、改派、校验、错群。
- 客户昵称只用于员工识别，不进入草稿正文。
- 健康类内容按 PRD：不诊断、不调药、不承诺疗效；高风险转人工。
- 存档遵守员工告知 + 客户同意；不同意的客户不处理。
- 数据留存期限需单独定义，默认 PoC 90 天。

---

## 15. 待验证假设（先做最小实验，再开发）

| # | 假设 | 验证方式 | 影响 | 状态 |
|---|---|---|---|---|
| A1 | 员工首次与机器人对话后，可拿到 `userid`（单聊直接作为 `chatid`） | 抓 `aibot_msg_callback` | 开通流程 | ✅ 2026-11-08 |
| A2 | 机器人可主动向该 `userid` 推送卡片 + markdown 文本 | 调 `aibot_send_msg` | 核心可行性 | ✅ 2026-11-08 |
| A3 | 模板卡片按钮点击可回调，且带自定义 `draft_id` | 点按钮看事件 | 状态回传 | ✅ 2026-11-08 |
| A4 | 卡片与正文两条消息顺序稳定、可长按复制 | 客户端实测 | 复制体验 | 🔄 PC 已复制，手机待测 |
| A5 | 存档能读到员工发出的消息，含 `roomid` 与 `from` | 拉存档比对 | 校验可行性 | ☐ 待存档开通 |
| A6 | 存档延迟在可接受范围（≤ 5 分钟） | 时间戳对比 | 队列释放与校验 | ☐ 待存档开通 |
| A7 | 客户群 `chat_id` 能稳定映射到存档 `roomid` | 两群比对 | 路由正确性 | ☐ 待存档开通 |
| A8 | 手机端也能长按复制机器人正文 | iOS/Android 实测 | 顾问是否都能用 | ☐ 待测 |

> A2 已通过，不再是生死项。实测记录见 [C2-0-verification-log.md](./C2-0-verification-log.md)。

**实测补充的字段细节**：

- 单聊回调 `chattype=single`，`chatid` 就是 `from.userid`。
- 按钮回调走 `aibot_event_callback`，key 在 `event.template_card_event.event_key`，`task_id` 原样回传。
- 回调带 `response_url` / `response_code`，可考虑用于更新卡片状态。

---

## 16. 里程碑

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **C2-0 验证** | A1–A8 最小实验 | 机器人 + 存档 |
| **C2-1 只读链路** | 存档采集 + 映射 + 存储 | C2-0 |
| **C2-2 草稿链路** | 识别 + 规则 + 草稿生成 | C2-1 |
| **C2-3 投递链路** | 机器人推送 + 按钮 + 串行队列 | C2-0 |
| **C2-4 校验闭环** | 存档回读 + 错群告警 | C2-1/C2-3 |
| **C2-5 试运行** | 1–2 名顾问、2–3 个测试群 | 全部 |

### 实现现状（2026-11-08）

| 环节 | 代码 | 状态 |
|---|---|---|
| ① 采集器 | `src/c2/adapters/wecom-archive.ts` | ✅ 真实存档实测通过 |
| ② 映射 | `Store.getGroup(roomid)` + `live-e2e` 绑定 | ✅ 单群可用 |
| ③ 识别 | — | ✗ 未做（只处理文字） |
| ④ 规则引擎 → 草稿 | `src/c2/trigger.ts` 的 `compose` | 🧪 当前为「回显客户原话」的占位实现 |
| ⑤ 草稿库 | `src/c2/memory.ts`（内存） | ✅ 可替换为持久化 Store |
| ⑥ 串行调度 | `src/c2/queue.ts` | ✅ |
| ⑦ 校验器 | `src/c2/verifier.ts` | ✅ 真实存档实测通过 |

`ArchiveTrigger` 的取舍：

- 只处理**文字**消息，图片/文件暂不触发；
- 只处理**启动之后**的客户消息（`msgtime >= startedAt`），重启不重放历史；需要补看时用 `TRIGGER_LOOKBACK_MS`；
- 进程内按 `msgid` 去重；跨重启靠 `seq` 游标（`.archive-seq`）保证不重复拉取，但**重启窗口内**（进程不在时）到达的客户消息不会被补触发；
- 存档本身有 20–35 秒延迟，所以草稿不会是秒级响应，轮询间隔默认 20 秒。

---

## 17. 开放问题

1. 一个客户群多个顾问共管时，草稿归属如何定？（建议：群主优先 + 配置覆盖）
2. 员工大面积改写草稿时，校验匹配阈值怎么调？
3. 高风险消息（症状、用药）是否要绕过串行队列直接升级给主管？
4. 客户不同意存档时，是否允许顾问手动把消息贴给机器人换取草稿？（这是 C0 回退）
5. 数据留存期限与删除策略。

---

## 18. 与 M1 的关系

本设计**不属于 M1 验收**。M1 只回答平台能力边界。
C2 依赖 M1 的两个前置结论：

- 外部群读消息只能走会话存档（已验证）
- 机器人不能进外部群（已验证）

C2 的 8 个待验证假设，可在 M1 阶段 B 顺带采集证据，但不改变 M1 结论。
