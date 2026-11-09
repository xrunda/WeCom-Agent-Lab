# WeCom-Agent-Lab

企业微信**平台能力与权限边界**验证（技术 PoC）。当前只执行 **M1**，不涉及七通业务、健康数据、自建模型或业务后端。

- 需求文档：[PRD.md](./PRD.md)（v0.5）
- 能力矩阵：[docs/M1-capability-matrix.md](./docs/M1-capability-matrix.md)
- 测试计划：[docs/M1-test-plan.md](./docs/M1-test-plan.md)
- 测试报告：[docs/M1-test-report.md](./docs/M1-test-report.md)
- 采购评估：[docs/M1-purchase-decision.md](./docs/M1-purchase-decision.md)
- 需要你配合的事项：[docs/M1-user-actions.md](./docs/M1-user-actions.md)
- 任务清单：[ISSUES.md](./ISSUES.md)
- **C2 架构设计（后续方向，不属 M1）**：[docs/C2-architecture.md](./docs/C2-architecture.md)
- **C2 平台验证记录**：[docs/C2-0-verification-log.md](./docs/C2-0-verification-log.md)

## M1 要回答的唯一问题

> 在一个真实的**外部客户群**里，能否同时存在外部联系人、内部员工和**可交互的 AI 机器人**，并由系统以官方方式读取消息、在**同一个群**发送消息？

## 阶段 A 结论（2026-11-08，官方文档）

**目标形态在官方能力上不成立。** 三类机器人能力都被官方排除在外部群之外：

| 能力 | 外部客户群 | 官方原文 |
|---|---|---|
| 智能机器人（普通/API 模式） | ❌ 不支持 | “仅支持添加至企业内部群”“互联群、上下游群、外部群暂不支持添加” |
| 群机器人 / 消息推送（Webhook） | ❌ 不支持 | “外部群暂不支持”“外部群聊暂不支持添加『消息推送』” |
| 客户群自动回复（小助理） | ⚠️ 唯一可用，但只是关键词规则 | 需 @小助理 触发，无 AI、无 API 配置、群主逐群开启 |

读与写分别只有一条官方路径，且都不满足“实时 + 程序直发”：

- **读**：会话内容存档（付费、盖章确认函、员工告知 + 客户同意），SDK 轮询，仅 5 天内记录，非实时推送。
- **写**：企业群发接口，**成员确认后才发送**，每个客户群每月上限 = 当月天数，不是程序直发。

> 按 PRD 第 5 节，这属于 `BLOCKED/FAIL` 的方向，**不得用内部群或人工转发宣布通过**。阶段 B 的实测仍应完成，用于排除灰度/内测差异并留下证据。

## 目录

```text
WeCom-Agent-Lab/
├── PRD.md
├── README.md
├── ISSUES.md
├── docs/                        # M1 文档 + C2 架构设计
├── config/.env.example          # 密钥占位，不提交真实值
├── evidence/                    # 证据索引（raw/ 已忽略）
├── experiments/minimal/         # 最小测试代码，非业务后端
├── src/c2/                      # C2 离线可测核心 + 真实机器人适配器
│   ├── types.ts                 # 领域模型
│   ├── state-machine.ts         # 草稿状态机
│   ├── message.ts               # 两段式消息（卡片 + 正文）
│   ├── matcher.ts               # 存档消息匹配
│   ├── ports.ts                 # Bot / Archive / Clock / Store 接口
│   ├── memory.ts                # 内存与 mock 实现
│   ├── queue.ts                 # 每顾问串行队列
│   ├── verifier.ts              # 存档回读校验
│   ├── trigger.ts               # 存档触发：客户群消息 → 草稿
│   ├── service.ts               # 编排层
│   ├── cli.ts                   # 离线演示
│   ├── bot-live.ts              # 真实机器人单聊联调
│   ├── live-e2e.ts              # 端到端：机器人 + 存档回读
│   └── adapters/
│       ├── wecom-bot.ts         # API 模式机器人长连接适配器
│       └── wecom-archive.ts     # 会话存档适配器（调用 archive_dump）
└── tests/                       # node --test，73 个用例
```

## C2 核心（离线可测，已实现）

C2 = 人工在环草稿投递：客户在群里发消息 → 存档触发草稿（`ArchiveTrigger`）→ 机器人 1:1 推给员工 → 员工复制到客户群 → 会话存档回读校验。
平台接入细节见 [docs/C2-architecture.md](./docs/C2-architecture.md)。

已实现的不变量：

1. **串行**：每个顾问同一时间只有一条 `PUSHED` 草稿，未确认不推下一条。
2. **两段式**：上下文卡片（群名/客户/摘要/按钮）与正文气泡分开；卡片不含正文，正文不带头部，复制不会串上下文。
3. **可追溯**：入队、推送、确认、校验、告警全部写审计。
4. **错群可发现**：确认后回读会话存档；正文出现在别的群 → `MISROUTE_ALERT`，连续 2 次暂停该顾问。
5. **失败可收敛**：推送失败退避重试（不重发卡片），3 次进死信；15 分钟提醒、60 分钟升级；校验失败重试后判 `UNVERIFIED`。

所有平台交互都在 `BotPort` / `ArchivePort` 后面。离线流程由 `MockBot` / `MockArchive` 驱动；真实机器人已接到 `WeComBotAdapter`（C2-2-01/03），存档已接到 `WeComArchiveAdapter`（C2-2-02，调用 `archive_dump` 子进程，C2-0 A5–A7 已实测通过）。`ArchiveTrigger`（C2-2-05）按群、发送者、时间窗从存档里筛出客户消息，按 `msgid` 去重后交给 `compose` 生成草稿。

```bash
npm test        # 状态机 / 消息 / 匹配 / 队列 / 触发 / 全流程 / 机器人与存档适配器，共 73 个用例
npm run demo    # 3 个群排队 → 串行推送 → 确认 → 校验 → 错群告警
npm run bot:live  # 真实机器人单聊：发消息 → 卡片+正文 → 点按钮确认（需 .env.local）
npm run bot:e2e   # 端到端：客户群消息 → 存档触发 → 推送 → 人工转发 → 回读 → VERIFIED（需存档 SDK，仅 Linux；不填 ARCHIVE_ROOM_ID 时自动发现群）
```

`bot:e2e` 不需要私聊机器人：客户在测试群里发一条消息即可触发草稿。卡片标题只放群名（存档只有 `roomid`，没有群名，所以 `GROUP_NAME` 建议填成员工在企微里看到的群标题）；配置 `WECOM_CONTACT_SECRET` 后可自动查群名与成员昵称（见 ISSUES C2-2-06）。相关参数：`TRIGGER_INTERVAL_MS`（默认 20000，存档触发轮询）、`VERIFY_DELAY_MS`（默认 10000，首次回读延迟）、`VERIFY_RETRY_MS`（默认 15000，未匹配时的重试间隔）、`VERIFY_MAX_ATTEMPTS`（默认 6，用完判 `UNVERIFIED`）、`TICK_INTERVAL_MS`（默认 5000，队列与校验轮询）。

## 运行环境

- Node.js ≥ 22.6（`src/` 使用原生类型剥离；C2 核心零运行时依赖，真实机器人适配器依赖 `ws`）
- 实验脚本（`experiments/minimal/*.mjs`）Node.js ≥ 18 即可
- 企微管理后台：超级管理员或被授权管理员

```bash
cp config/.env.example .env.local   # 填自己的值，不要提交
node --check experiments/minimal/webhook-send.mjs
```

开发依赖（类型检查、机器人验证脚本）需要先安装；C2 核心运行时仍然零依赖：

```bash
npm install
npx tsc --noEmit
npm run bot:test   # 需要先在 .env.local 填机器人凭证
```

## 当前状态

| 里程碑 | 状态 |
|---|---|
| M1-A 文档与骨架 | ✅ 完成 |
| M1-B 阶段A 官方预核实 | ✅ 完成（12 项） |
| M1-C 最小实验资产 | ✅ 完成 |
| M1-D 阶段B 实测 | 🗄 归档（5 项已过；其余为取证项，不影响结论） |
| M1-E 报告与 Go/No-Go | 🗄 归档（结论已由 C2 实践证明） |
| C2-0 平台假设验证 | ✅ 完成（A1–A8 全部通过；存档延迟上界 35 秒） |
| C2-1 离线核心 | ✅ 完成 |
| C2-2 接入联调 | ✅ 完成（真实机器人 + 真实存档，端到端 VERIFIED） |

**企微侧已收尾**，剩余 3 项（都不阻塞业务侧）见 [ISSUES.md](./ISSUES.md#未关清单3-项)。C2 的接缝只有三处（`compose` / 顾问名单 / 通知），业务侧可以直接接。

基线已提交：`9190508`（48 文件）。未推送到远端。
