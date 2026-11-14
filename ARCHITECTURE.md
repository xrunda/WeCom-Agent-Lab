# 知伴健康 Agent：架构、模块协作与数据流转

> 本文描述 **P1 阶段**（2026-11）线上实际运行的形态：一个 DSH 进程承载企微通道、患者域、管理后台与四个能力插件，数据落在 DSH 存储域，顾问在企微里完成服务闭环，控制台只做配置、观察与兜底。
>
> 阅读顺序建议：第 1–2 节看「为什么长这样」，第 3–6 节看「由哪些部分组成」，第 7–8 节看「一条消息怎么走完全程」，第 9–11 节看「失败怎么办、红线在哪、怎么部署」。

---

## 1. 一句话概括

知伴是一个**在企微客户群里工作的健康服务 Agent**：它读取客户群的消息（经企业微信「会话内容存档」），在患者域里维护患者、群、绑定与长期记忆，用大模型生成回复**草稿**，把草稿以卡片形式推给**真人顾问**；顾问确认或改稿后，**由顾问本人**发到客户群；系统再回读存档，核验「实际发出去的内容」，形成可追溯的服务记录。

三个关键词决定了整个架构：

| 关键词 | 含义 | 架构后果 |
|---|---|---|
| **人在环里**（human-in-the-loop） | 机器人不能直接往客户群发消息，必须顾问本人确认发送 | 草稿队列、卡片回调、串行推送、发送核验成为核心链路 |
| **只读靠存档** | 机器人能「看见」客户群，靠的是付费的会话内容存档，只能轮询、最多保留 5 天、延迟可达数十秒 | 存档游标、去重、增量拉取、回读核验、5 天窗口约束 |
| **一进程多插件** | 全部能力跑在同一个 DSH Host 进程内，插件之间通过服务名与事件总线协作 | 单实例、单机器人长连接、存储域隔离、懒加载与安全降级 |

---

## 2. 产品与平台约束：为什么必须是这个形态

### 2.1 平台能力边界（M1 结论）

企微对「AI 机器人进外部客户群」有三条硬约束：

1. **机器人 / 群 webhook 不能加入外部客户群**。能自动进内部群，不能进外部客户群。
2. **读**只能走「会话内容存档」：按席位付费、消息最多保留 5 天、只能轮询拉取，不是实时推送。
3. **写**只能走「群发」：需要群成员在企微里确认，且有每月次数上限，无法做到「Agent 说完就出现在群里」。

因此产品不是「自动客服机器人」，而是**顾问的副驾驶**：

```
客户提问 → Agent 起草 → 推给顾问 → 顾问确认/修改 → 顾问发到群里 → 系统回读核验
```

这条链路同时也是合规链路：谁发的、发了什么、依据哪条记忆/知识、是否被风控改写，全部留痕。

### 2.2 P1 范围

P1 交付的是「服务闭环 + 可运维」：患者与群管理、草稿服务流、风控红线、长期记忆、主动关怀、知识库、话术库、控制台与审计、部署与备份。**不做**：自动群发、自动加群、跨租户运营、自动删除数据、20–50 并发容量承诺。

---

## 3. 运行形态总览

### 3.1 部署拓扑

```
                     企业微信（腾讯侧）
        ┌──────────────────┼───────────────────┐
        │                  │                   │
   客户微信群          顾问 1:1 聊天        会话内容存档
        │                  │  ▲                │
        │  顾问手动发送     │  │ 卡片/正文       │ 轮询拉取（archive_dump）
        ▼                  ▼  │                ▼
   ┌─────────────────────────────────────────────────────┐
   │        腾讯云 VM（Ubuntu，2 vCPU / 2 GB）            │
   │                                                     │
   │   nginx :443 ──静态──> /var/www/zhiban/console       │
   │      │                                              │
   │      └──/zhiban/api/──> 127.0.0.1:3080              │
   │                              │                      │
   │                    ┌─────────▼──────────┐           │
   │                    │   DSH Host 进程     │           │
   │                    │  （单实例，196 插件）│           │
   │                    │  profile = zhiban   │           │
   │                    │  ├ zhiban-wecom     │           │
   │                    │  ├ zhiban-patient   │           │
   │                    │  ├ zhiban-console   │           │
   │                    │  ├ zhiban-guard     │           │
   │                    │  ├ zhiban-memory    │           │
   │                    │  ├ zhiban-care      │           │
   │                    │  └ zhiban-knowledge │           │
   │                    └─────────┬──────────┘           │
   │                              │                      │
   │        /var/lib/zhiban/dsh/storages/*.json          │
   │        /var/lib/zhiban/dsh/sessions/                │
   │        /var/lib/zhiban/media/                       │
   └─────────────────────────────────────────────────────┘
                              │
                        模型服务（DeepSeek）
```

要点：

- **DSH Web UI 不暴露公网**。nginx 对 `/dsh/` 直接 404，只反代 `/zhiban/api/`。
- **控制台与 API 同域**（同一个 HTTPS 域名），静态文件由 nginx 直出，API 反代到本机 3080。
- **生产实例只监听 127.0.0.1**，外网访问控制台需 SSH 隧道；服务器上 nginx 还有一层 `allow 127.0.0.1/::1; deny all;`。
- **同一个企微机器人只允许一个长连接**。多开会把另一个实例挤下线，所以必须单实例；demo 与 dev 用不同机器人、不同 `DSH_HOME`、不同端口。

### 3.2 进程与端口

| 组件 | 形态 | 地址 / 路径 |
|---|---|---|
| nginx | systemd | 80（ACME + 301）、443（静态 + 反代） |
| DSH Host | systemd `dsh-zhiban.service` | `127.0.0.1:3080` |
| 控制台静态 | nginx root | `/var/www/zhiban/console` |
| DSH 数据 | 文件系统 | `DSH_HOME=/var/lib/zhiban/dsh`（线上） |
| 存档工具 | 可执行文件 | `/opt/zhiban/bin/archive_dump` |
| 代码副本 | 只读运行 | `/opt/zhiban/app` |
| 备份 | `zhiban-backup.timer` | `/var/backups/zhiban`，每天 03:20，保留 14 天 |
| 看门狗 | `zhiban-watchdog.timer` | 每 5 分钟探针，异常 10 分钟升级 |
| 费用日报 | `zhiban-report.timer` | 每天 09:00 |

> 仓库里的 unit 模板写的是 `profile zhiban-demo`、`DSH_HOME=/var/lib/zhiban/dsh-demo`；线上这台机器按实际安装调成了 `profile zhiban`、`/var/lib/zhiban/dsh`。以现场 unit 为准，不要照抄模板覆盖。

### 3.3 启动参数与 profile

```bash
dsh --profile zhiban --no-open --host 127.0.0.1 --port 3080
```

profile 目录：`$DSH_HOME/profiles/zhiban/`

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `dsh.profile.bundles = [dsh-base, dsh-web-app]` |
| `cordis.yml` | 空根 `[]`，不在这里写插件 |
| `cordis.patch.yml` | **业务插件的唯一入口**：用 `insert` 按绝对路径插入 7 个 zhiban 插件及配置（含凭据，0600，不进仓库） |

`cordis.patch.yml` 里每个插件大致长这样（示意，凭据以占位符表示）：

```yaml
- insert:
    - id: zhiban-wecom
      name: /opt/zhiban/app/plugins/zhiban-wecom/index.ts
      config:
        environment: demo
        serviceGroupRoomIds: [<种子群 roomid>]
        advisorChatId: <顾问 1:1 chatid>
        bot: { ... }            # 机器人凭据，来自 env
        archive: { ... }        # 存档凭据 / archive_dump 路径
        contactSecret: ...      # 客户联系 API，用于群名/昵称
```

> 任何凭据只放 `/etc/zhiban/*.env`（0600）或 profile（0600），不写入代码、文档、日志、commit。

---

## 4. DSH 底座：这个项目跑在什么上面

### 4.1 DSH 是什么

**DSH = DeepSeek Harness**，本项目的 Agent 底座（固定 `0.2.1-rc.5`，Node ≥ 22.6）。它是**单进程**的插件宿主：一个 Node 进程同时提供存储、会话、模型调用、工具注册、HTTP 服务与事件总线。本仓库以 DSH 插件的形式实现全部业务。

### 4.2 插件模型

每个插件是一个 TS 模块：

```ts
export const name = 'zhiban-wecom'
export const inject = ['storageDomain']          // 声明的宿主能力
export function apply(ctx, config) {
  ctx.effect(async () => {                        // 生命周期：返回 cleanup
    const domain = await ctx.storageDomain.open(spec)
    ctx.provide('zhibanWecom', bridge)            // 发布服务
    ctx.tools.register(...)                       // 注册 Agent 工具
    ctx.on('alert.created', handler)              // 订阅事件
    ctx.emit('draft.created', {...})              // 发布事件
    return async () => { await domain.close() }   // 卸载/重启时清理
  })
}
```

四个关键原语：

| 原语 | 语义 | 在本项目中的用途 |
|---|---|---|
| `inject` | 声明依赖的宿主能力（`storageDomain` / `webServer` / `sessionController` / `tools`） | 缺失时插件不会被激活 |
| `ctx.provide(name, api)` | 向进程内服务表发布能力 | 7 个业务服务名（见 §6） |
| `ctx.get(name)` | 懒取服务，未安装返回 `undefined` | **插件之间只这样调用**，允许任意加载顺序；缺插件时降级 |
| `ctx.effect(fn)` | 注册生命周期与 cleanup | 打开存储域、恢复游标、启动轮询、关闭时落盘 |

另有 `ctx.on/emit`（进程内事件总线）、`ctx.tools.register`（Agent 工具）、`ctx.webServer.register`（HTTP 路由）、`ctx.sessionController`（创建/驱动会话）、`ctx.logger`。

### 4.3 会话模型

- 每个患者一个**长期会话**：`sessionId = zhiban-patient-<patientId>`，工作区 `.../workspaces/zhiban-p1/<patientId>`，使用自定义预设 `zhiban-health`（只含 persona / 时间上下文 / 压缩，不含 bash、文件系统等编码工具）。
- 回合通过 `sessionController.prompt({ requestId, sessionId, mode:'queue', content })` 投递，`content` 可以是「文本 + 图片」的多模态数组。
- 非唤醒式注入用 `agent.inject(makeUserMessage(text))`：例如「草稿已核验」「顾问的改稿要求」，不新开回合。
- `waitIdle(sessionId, timeout)` 与该会话的 `agent.whenIdle()` 竞速；超时即判定回合失败，走模板降级。

> 为什么强调预设：默认预设是编码 Agent（带 bash/fs），患者会话会又慢又不安全。`zhiban-health` 是 P1 的关键部署配置。已存在的会话不会因为改配置而换预设，必要时需要清理 `zhiban_patient.json` 的 `sessions` 表。

### 4.4 存储域

DSH 的 `storageDomain` 提供「域（domain）→ 表（table）」的持久化：

- `defineDomain({ name, version, tables })` 声明 schema；每张表的记录用 `z.object({...}).passthrough()`，只校验定位字段，业务新字段可透传。
- 表 API：`get(key)`、`entries()`、`put(key,value)`、`delete(key)`、`update(key,fn)`。
- **内存是权威**：写入先落盘成功，再改内存并发 `domain/changed`；失败不改内存。
- 后端是 **JSON 文件**（`dsh-storage-json`）：`$DSH_HOME/storages/<domain>.json`，结构 `{ unit, global, tables: { ... } }`。
- 业务侧再包一层 `DomainStore`（同步内存镜像 + 串行写队列 + `flush()` 等待落盘），持久化失败发 `PERSIST_FAILED` 告警。

> 文档里出现过 `storage-sqlite` 的说法，但 DSH 0.2.1-rc.5 实际只带 `dsh-storage-json` + `dsh-storage-domain`。**以 JSON 后端实现为准**；数据模型文档里的 SQL 表名与领域表名不是一一对应。

### 4.5 工具与技能

- **工具**由插件注册，模型在会话中按需调用：`reply_draft`、`reply_skip`、`image_classify`、`meal_log_write`、`memory_*`、`schedule_create`、`escalate_to_human`。
- **技能（skill）**是文件形态的知识注入：知识库把条目渲染成 `<skillDir>/zhiban-knowledge-<hash>.md`，餐食识别写入 `meal-vision.md`，由 DSH 文件系统 skill provider 在下一轮读取。
- 工具调用结果会发 `tools/result` 事件，知识插件借此统计引用次数。

---

## 5. 模块清单与职责

### 5.1 一张表看清 7 个插件

| 插件 | 角色 | 存储域（表） | 提供 | 依赖 / 调用 |
|---|---|---|---|---|
| **zhiban-wecom** | 企微通道：存档拉取、机器人长连接、群发现、草稿队列与核验、话术查询、管理 API | `zhiban_wecom`：advisors / groups / drafts / active / audit / alerts / meta | `zhibanWecom`（患者桥）、`zhibanWecomAdmin`（控制台运维） | 调 `zhibanPatient`、`zhibanGuard`、`zhibanScripts` |
| **zhiban-patient** | 患者域：患者/群/成员/绑定/长期会话、回合编排、图片、饮食记录、控制台患者 API | `zhiban_patient`：advisors / groups / members / bindings / patients / sessions / meal_logs / stats / audit | `zhibanPatient` | 懒取 `zhibanWecom`、`zhibanGuard`、`zhibanMemory`、`zhibanCare`、`zhibanSandboxSink` |
| **zhiban-console** | 管理后台后端：认证、REST、SSE、审计、告警、沙盒、话术、PDF | `zhiban_console`：tenants / accounts / sessions / audits / alerts / sandbox_* / media / scripts | `zhibanScripts`、`zhibanSandboxSink` | 懒取 `zhibanWecomAdmin`、`zhibanPatient`、`zhibanMemory`、`zhibanCare`、`zhibanGuard`、`zhibanKnowledge` |
| **zhiban-guard** | 风控红线：草稿审核、员工发言质检、升级告警、规则管理 | `zhiban_guard`：rules / alerts / audit | `zhibanGuard` | 被 patient / wecom / console 调用 |
| **zhiban-memory** | 长期记忆：写入/更新/查询、每轮渲染注入 | `zhiban_memory`：memories / audit | `zhibanMemory` + 3 个工具 | 被 patient（读）、console（管）、模型（写）使用 |
| **zhiban-care** | 主动关怀计划：创建、取消、到期触发 | `zhiban_care`：plans / audit | `zhibanCare` + `schedule_create` | 到期时反向调 `zhibanPatient.startProactiveTurn` |
| **zhiban-knowledge** | 知识库：条目 CRUD、skill 文件同步、引用统计 | `zhiban_knowledge`：entries / audit | `zhibanKnowledge` | 被 console 管理；`tools/result` 旁路统计 |

统一设计原则：

- **加载顺序无关**：插件之间不直接 import，只经 `ctx.get('<服务名>')` 懒加载。
- **能力可缺席**：guard 未安装 → 草稿直通；memory 未安装 → 注入为空；care 未安装 → 不触发主动回合；knowledge 未安装 → 无 skill 文件。
- **不跨域读写**：任何插件都不直接打开别人的存储域，只调对方公开的 API。

### 5.2 三个「主角」的分工

用户视角的三块是 **DSH、企微、管理后台**。准确地说：

- **DSH 是底座**，不是业务模块。它提供进程、插件、存储、会话、模型、HTTP，业务能力全在插件里。
- **企微通道（zhiban-wecom）是「感官与手」**：看得见客户群（存档）、说得了话（机器人私聊）、推得动草稿（卡片）、核得了实发（回读）。
- **患者域（zhiban-patient）是「大脑的记忆与判断」**：这个群是谁、谁在说话、患者是谁、以前聊过什么、这一轮该不该回、回什么。
- **管理后台（zhiban-console）是「仪表盘与刹车」**：配置、观察、审计、告警处置、队列释放、沙盒演练。顾问日常不在控制台，而在企微里。

```
                  ┌──────────────────────────────┐
                  │        zhiban-console        │
                  │  认证 / REST / SSE / 审计     │
                  └───────┬──────────────┬───────┘
            只读观察+运维   │              │  配置与处置
                          ▼              ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ zhiban-wecom │◄─►│zhiban-patient│◄─►│ 能力插件      │
   │ 企微通道      │   │ 患者域/会话   │   │ guard/memory │
   │              │   │              │   │ care/knowledge│
   └──────┬───────┘   └──────────────┘   └──────────────┘
          │ 存档读 / 机器人写 / 卡片回调
          ▼
      企业微信
```

### 5.3 服务名与调用方向（谁 provide、谁 get）

| 服务名 | 提供方 | 主要方法 | 消费方 |
|---|---|---|---|
| `zhibanWecom` | wecom | `enqueueDraft` / `reviseDraft` / `requestRevision` / `getActiveDraft` / `getDraft` / `listVerifiedBodies` / `notifyAdvisor` / `bindGroup` | patient（草稿落地、改稿、核验回执、通知） |
| `zhibanWecomAdmin` | wecom | `activateServiceGroup` / `deactivateServiceGroup` / `listServiceGroupRooms` / `releaseQueue` / `restoreAdvisor` / `pauseAdvisor` / `getDraftDetail` / `getDraftEvidence` / `listDraftsByRooms` / `listGroups` / `listAudits` | console |
| `zhibanPatient` | patient | `listPatients` / `getPatientAdmin` / `updatePatient` / `createPatient` / `listGroups` / `updateGroup` / `listGroupMembers` / `bindPatient` / `setPatientIdentity` / `listMealLogs` / `sandbox*` / `applySettings` / `startProactiveTurn` | console、care、guard/memory 的工具上下文 |
| `zhibanGuard` | guard | `review` / `reviewStaffMessage` / `linkDraft` / `listRules` / `createRule` / `escalate` / `alerts` / `audits` | patient、wecom、console |
| `zhibanMemory` | memory | `available` / `render` / `list` / `get` / `count` / `write` / `update` / `remove` | patient（每轮注入）、console、memory 工具 |
| `zhibanCare` | care | `available` / `list` / `create` / `cancel` | console、patient（能力开关） |
| `zhibanKnowledge` | knowledge | `list` / `get` / `create` / `update` / `remove` / `recordCitations` / `sync` | console、knowledge 自身 |
| `zhibanScripts` | console | `listEnabled()` | wecom（员工私聊查话术） |
| `zhibanSandboxSink` | console | 沙盒草稿回交 | patient 沙盒端口 |

> 「provide 方」只发布接口，不反向读对方的表。`console` 是唯一同时消费 6 个服务的插件，但它也只做编排与审计。

---

## 6. 数据模型与存储

### 6.1 两个核心存储域

#### `zhiban_wecom` —— C2 通道域（通道与草稿）

| 表 | key | 内容 |
|---|---|---|
| `advisors` | `advisor.id` | 顾问：企微 userid、1:1 chatId、状态、连续错群次数 |
| `groups` | `roomId` | 客户群：群名、绑定顾问、C2 状态（mapped/unassigned/disabled） |
| `drafts` | `draft.id` | 草稿全生命周期：正文、版本、状态、来源、引用、回执、核验结果 |
| `active` | `advisorId` | 该顾问当前活跃草稿（串行队列的队首指针） |
| `audit` | `audit_<at>_<seq>` | 通道审计 |
| `alerts` | `alert_<at>_<seq>` | 通道告警（停机、断连、死信、错群、核验失败等） |
| `meta` | 元数据名 | `archive_seq`（存档游标）、`last_run_at`（停机判定）、`service_roster`（动态服务群名单快照） |

#### `zhiban_patient` —— 患者域

| 表 | key | 内容 |
|---|---|---|
| `advisors` | `advisor.id` | 顾问记录（与控制台/通道对齐的内部 id） |
| `groups` | `group.id` | 受管群：roomId、群名与来源、服务状态、顾问、活跃时间 |
| `members` | `member.id` | 群成员：外部/内部、角色、同意状态、昵称、尾号 |
| `bindings` | `binding.id` | 群 ↔ 患者绑定，`isPrimary` 标记主群 |
| `patients` | `patient.id` | 患者：显示名、主外部 id、身份状态/来源、同意、状态、标签、顾问 |
| `sessions` | `patientId` | 患者长期会话：sessionId、workspacePath、createdAt |
| `meal_logs` | `meal.id` | 饮食记录：餐次、食物、置信度、图片来源 |
| `stats` | `agent` | 回合统计：turns/replies/skips/fallbacks/timeouts/errors |
| `audit` | 事件 | 患者域审计 |

### 6.2 其它存储域

| 域 | 表 | 说明 |
|---|---|---|
| `zhiban_guard` | `rules` / `alerts` / `audit` | 4 条内置规则 + 租户关键词规则；风险告警；规则命中审计 |
| `zhiban_memory` | `memories` / `audit` | 患者长期事实，按 `patientId + category + content` 去重 |
| `zhiban_care` | `plans` / `audit` | 主动计划（不支持 RRULE）、触发与顺延记录 |
| `zhiban_knowledge` | `entries` / `audit` | 知识条目（软删除）、引用次数 |
| `zhiban_console` | `tenants` / `accounts` / `sessions` / `audits` / `alerts` / `sandbox_*` / `media` / `scripts` | 控制台自己的账号、会话、审计、告警视图、沙盒、话术 |

### 6.3 ID 约定

所有实体 id 为 `<前缀>_<opaque>`，前端不得解析 id：

`tn_` 租户、`acc_` 账号、`adv_` 顾问、`grp_` 群、`gm_` 群成员、`gbd_` 绑定、`pat_` 患者、`mem_` 记忆、`pln_` 计划、`meal_` 饮食、`knw_` 知识、`rul_` 规则、`draft_` 草稿、`alt_` 告警、`aud_` 审计、`med_` 媒体。

现实实现中，C2 草稿用 `draft_<n>`、患者域用 `pat_<n>` / `grp_<n>` 等数字序号（存量兼容）；存储 key `audit_<at>_<seq>` / `alert_<at>_<seq>` 是行键，不是对外实体 id。

### 6.4 三张「元数据」最容易被忽略

1. **`archive_seq`**：存档拉取游标。每次轮询推进并持久化；重启后从这里续拉，不会重复处理。它也解释了「为什么重启前的消息不在缓存里」——需要专门回读补拉，而不是改游标。
2. **`last_run_at`**：每 60 秒写一次。启动时若与当前时间差超过 10 分钟，判定为**停机**，发 `DOWNTIME` 告警；停机期间的消息不会补生成草稿。
3. **`service_roster`**：**动态服务群名单**。profile 里的 `serviceGroupRoomIds` 只是种子；真正的「这个群要不要服务」以 roster 为准（candidate / active / inactive，denied 会跨重启保留）。这是 2026-11-11 那次「客户群消息被静默丢弃」事故的根因所在。

---

## 7. 端到端数据流

这一节按场景拆开讲。所有场景都发生在同一个进程里，区别只在「入口」和「触发了哪些服务」。

### 7.1 主链路：客户在群里发一条文字

```
企微存档
   │  ① archive_dump 增量拉取（seq）
   ▼
zhiban-wecom.pollOnce
   │  ② 解析消息；按 service_roster 判断是否服务群
   │  ③ 群名/成员昵称补全（客户联系 API，缓存 10 分钟）
   │  ④ 同意状态刷新（存档同意）
   │  ⑤ 内部员工文本 → guard.reviewStaffMessage（质检，旁路）
   ▼
zhiban-patient.routeInbound
   │  ⑥ 解析发言人：外部 → 患者；内部 → 顾问/同事
   │  ⑦ 未同意存档的成员：提示「需人工服务」
   │  ⑧ 合并窗口（默认 30s 静默，最多等 120s）
   ▼
PatientAgentRuntime.executeTurn（每个患者一个长期会话）
   │  ⑨ 确保会话存在（zhiban-patient-<patId>）
   │  ⑩ 加载图片（如有）、渲染记忆、拼提示词
   │  ⑪ 调模型；模型调用工具：
   │      reply_draft / reply_skip / image_classify / meal_log_write
   ▼
replyDraft
   │  ⑫ guard.review：红线检查 → 可能改写正文/抬风险/建告警
   │  ⑬ bridge.enqueueDraft → zhiban-wecom
   ▼
C2Service.enqueueDraft
   │  ⑭ 落 drafts 表；每顾问串行队列
   │  ⑮ SerialQueue 推卡片 + 正文到顾问 1:1
   ▼
顾问在企微里看到卡片
   │  ⑯ 「已发送」/「忽略」/「按我的要求改」
   ▼
企微存档回读
   │  ⑰ Verifier 在客户群里找实际发出的消息
   │      完全一致 → VERIFIED
   │      相似 ≥ 0.9 → EDIT_SENT
   │      发到别的群 → MISROUTE_ALERT（连续 2 次暂停顾问）
   │      4 次未匹配 → UNVERIFIED
   ▼
控制台服务流：状态、证据、引用、审计
```

关键细节：

- **合并窗口**：客户连发多条会被合并成一批，避免模型对半句话回复。合并定时器必须按「剩余时间」重排（曾经因为只建一次定时器导致消息永久滞留，已修）。
- **串行队列**：每个顾问同一时刻只有一张活跃草稿。前一张停在 `PUSHED`，后面所有草稿都会排队；顾问必须点「已发送」或「忽略」才会前进。管理员可在控制台释放队列（`RELEASED`）。
- **卡片协议**：卡片按钮回传 key `ack:<draftId>[:v<n>]:sent|skipped`。`v<n>` 表示顾问改过稿、确认的是第 n 版。
- **提醒与升级**：15 分钟未处理提醒一次；60 分钟未处理升级给主管；推送连续失败 3 次进入 `DEAD_LETTER`。
- **核验不是自报**：顾问点「已发送」只表示他做了动作，**发没发、发了什么，以存档回读为准**。这也是 `EDIT_SENT` 存在的原因。

### 7.2 语音消息

```
存档 msgtype=voice
   │  下载音频到内存（不落盘），校验 md5
   │  按文件头识别格式（企微存档实测是 AMR，不是 SILK）
   ▼
腾讯云「一句话识别」SentenceRecognition（16k_zh，TC3 签名）
   │  成功：record.text = 转写文本，msgtype 仍为 voice
   │  失败/为空：标记 voiceFailed，消息不进入服务流
   ▼
患者域：提示词里显示为「[语音] 正文」→ 正常走回合
```

约束与现状：

- 音频**只在内存**里交给 ASR，日志只记大小和字符数。
- 转写失败**当前不重试**（已记录 issue #137：有界重试 + 插件文件日志 + 可选告警）。
- 排查口诀：存档 seq 是否推进 → 群/患者 `lastActiveAt` 是否更新（更新=已进患者域）→ 是否有会话/草稿写入 → 再看 ASR。若 `lastActiveAt` 不动，先查服务群名单，不要先怀疑 ASR。

### 7.3 图片消息

```
存档 msgtype=image
   │  下载落盘 /var/lib/zhiban/media/...（校验大小/md5，失败标记 mediaFailed）
   ▼
患者域回合
   │  魔数识别 JPEG/PNG/WebP（不信扩展名），单轮最多 4 张、单张 10MB
   │  以 base64 多模态内容注入会话（超限/失败只计 skipped，降级为纯文字）
   ▼
模型先调 image_classify（meal / report / medicine / other）
   │  meal：可调 meal_log_write 写饮食记录（一轮仅一条，置信度 <0.6 要求确认）
   │  report / medicine：只确认收到，不解读指标，风险至少 medium
   ▼
提示词追加图片指令；草稿卡片带 mediaKinds
```

图片回合的实际耗时可能到 12–89 秒，因此超时上限按 ≥180 秒配置；早期 15 秒会频繁触发模板降级。

### 7.4 顾问在 1:1 里改稿

```
顾问在 1:1 发文字（不是点按钮）
   ▼
zhiban-wecom 机器人收到消息
   │  handleAdvisorText
   ▼
患者域：executeTurn(..., revision)
   │  注入「顾问要求：<原文>」与上一版正文
   │  仍走 guard.review
   ▼
bridge.reviseDraft → 版本 +1，重新推卡片
```

改稿指令与版本历史都落在草稿的 `revisions` 里，核验时能判断「实发的是第几版」。

### 7.5 内部员工在客户群发言

```
存档里 from 是内部员工
   ▼
wecom runtime：先 staffQuality（guard.reviewStaffMessage）
   │  只匹配 action=flag 的关键词规则
   │  否定词（不要/请勿/避免…）视为合规提醒
   │  msgid 进程内去重（最多 2000）
   │  命中：建 redline 告警 + 1:1 提醒发言人（只含群名与规则名）
   ▼
消息仍进入患者域 routeInbound（作为上下文，不触发对外草稿）
```

设计意图：员工发言是「顾问已经在服务」的信号，系统不抢答，但要做质检留痕，且**绝不向客户群发任何提醒**。

### 7.6 群发现与「开始服务」

```
客户联系 API externalcontact/groupchat/list
   │  只发现企业自建、可管的客户群（owner_filter）
   ▼
ServiceGroupRegistry 登记 candidate（不动白名单）
   ▼
控制台「群管理」看到候选群
   │  点「开始服务」→ 必须选择服务对象（群成员）
   ▼
POST /groups/:id/bindings { memberId }
   │  createPatient（同 externalUserId 复用）→ bindPatient → setPatientIdentity
   ▼
patient.updateGroup(status=serving)
   │  syncServiceGroup
   ▼
zhibanWecomAdmin.activateServiceGroup(roomId, name, actor)
   │  roster.activate + C2 bindGroup + 审计
   ▼
后续该群消息进入服务流
```

反向操作：`PATCH /groups/:id {status:disabled}` → `deactivateServiceGroup` → roster 记为 denied（跨重启保留），存档不再把该群交给患者域。

> 注意：群发现只登记候选，**不会自动开始服务**。这是产品决策——避免把「公司所有客户群」默认纳入 AI 服务范围。

### 7.7 主动关怀（Agent 主动发起）

```
控制台创建计划 / 模型调 schedule_create
   ▼
zhiban_care.plans（when 必须晚于当前；不支持 RRULE）
   │  落在安静时段（默认 21:00–08:00）→ 顺延到 08:00
   ▼
CareService 单一定时器（重启后按 when 重新 arm）
   ▼
到期：startProactiveTurn
   │  前置检查：患者 serving、同意非 disagreed、有主群且群 serving
   │  让路：有活跃回合 / 有排队消息 / 合并窗口未关 → defer 30s
   │  限流：每顾问每小时最多 6 条主动草稿
   ▼
同一个 executeTurn（source=proactive，messages 为空）
   │  提示词说明「本轮由计划触发，无必要则 reply_skip」
   ▼
草稿 source=proactive → 同一队列 → 推顾问
```

主动回合**不套模板降级**：模型没调工具就记失败，不生成模板草稿（避免「主动关怀」变成机械骚扰）。

### 7.8 记忆：写入与每轮注入

**写入**（模型在回合中调用）：

```
memory_write(category, content≤200, subject, sourceText≤100)
   ▼
MemoryService.upsertFact
   │  patientId 来自会话上下文（不由模型传，防止越权）
   │  同患者 + 同分类 + 同内容 → 只更新，不新增
   │  事件只广播 id/分类/主题，不带正文
```

**注入**（每个回合）：

```
runtime.executeTurn
   ▼
memory.render(patientId)
   │  未删除记录、按分类排序、最多 injectLimit（默认 30）
   │  首行说明「引用时把方括号里的 id 填进 citedMemoryIds」
   ▼
拼进提示词「【患者长期记忆】」段
```

**约束**：家属说的事标 `subject=family`，提示词明确要求不能当患者本人事实；但服务端只做提示层约束，工具仍要求模型显式填 `subject`（代码没有强制兜底，属于已知的软约束）。

### 7.9 知识库与话术：两条完全不同的路

| | 知识库 | 话术库 |
|---|---|---|
| 存储 | `zhiban_knowledge.entries` | `zhiban_console.scripts` |
| 谁用 | 患者域模型（作为 skill 文件） | 顾问本人（企微私聊查询） |
| 形态 | 按分类渲染成 `zhiban-knowledge-*.md`，由 skill provider 在下一轮读取 | `话术` / `话术 关键词` / `话术 分类 编号` |
| 引用统计 | `tools/result` 里读 `citedKnowledgeIds`，命中 +1 | 不统计 |
| 会不会进草稿 | 会（模型引用后写入 `citedKnowledgeIds`） | 不会 |

知识库的 skill 目录需要写进 profile 的 `customSkillDirs`（仓库里没有 profile 文件，属于部署配置项）。话术查询只回复员工本人、绝不进客户群，结果编号在会话内存里保留 30 分钟。

### 7.10 风控红线（guard）如何介入

三个入口：

1. **草稿生成**：`replyDraft` 在入队前同步调用 `guard.review`。
2. **员工发言**：`wecom.pollOnce` 对内部消息调用 `reviewStaffMessage`。
3. **模型主动升级**：`escalate_to_human` 工具 → 建 critical 告警。

规则分两类动作：

- `flag`：只抬风险等级、记录命中，不改正文。匹配**草稿正文**。
- `guide` / `escalate`：匹配**客户原话**（`inboundText`），命中后草稿正文替换为固定转诊话术（「请立即拨打 120 或前往最近医院急诊…」）。

关键设计：**guard 不拦截推送**。它改写、分级、建告警、通知顾问，但草稿仍然推到顾问面前，由人做最终决定。命中高等级风险时创建 `escalate` / `redline` 告警，控制台告警页可见，顾问 1:1 也会收到只含规则名与等级的通知。

### 7.11 控制台：读写与实时刷新

**读**：控制台 SPA（React 18 + Vite + AntD 5）通过 `/zhiban/api/*` 拉数据；后端插件把各域 API 拼成视图（`console-views.ts`），不直接读别人的表。

**写**：全部经领域 API，并写 `zhiban_console.audits`。典型链路：

| 操作 | 链路 |
|---|---|
| 开始服务 | `POST /groups/:id/bindings` → patient.createPatient/bindPatient/setPatientIdentity → group serving → wecomAdmin.activateServiceGroup（失败回滚群状态） |
| 停用服务 | `PATCH /groups/:id` → patient.updateGroup → wecomAdmin.deactivateServiceGroup |
| 确认/改绑患者 | `POST /patients/:id/identity` → patient.setPatientIdentity |
| 释放队列 | `POST /alerts/:id/release-queue` → wecomAdmin.releaseQueue(advisorId,'console') |
| 恢复/暂停顾问 | `POST /advisors/:id/resume|pause` → wecomAdmin + patient.updateAdvisor |
| 改知识/规则/话术 | 分别调 `zhibanKnowledge` / `zhibanGuard` / 控制台自身 scripts 表 |
| 改 Agent 设定 | `PATCH /tenant` → patient.applySettings 即时生效 |

**实时**：控制台提供 SSE `GET /zhiban/api/stream`：

- 支持 `?types=draft.*,alert.*` 前缀过滤；
- 断线用 `Last-Event-ID` 补发（5 分钟环形缓冲，最多 500 条）；
- 15 秒 `: ping` 心跳；
- 事件包括 `draft.created/pushed/acked/revised/verified/failed/released`、`patient.*`、`memory.*`、`care_plan.*`、`meal_log.created`、`group.updated`、`advisor.updated`、`alert.*`、`system.status`。

前端服务流页订阅 `draft.*`，收到后重拉列表；告警页订阅 `alert.*` 刷新角标。沙盒事件虽定义了订阅，但当前页面主要靠动作后手动刷新。

**鉴权**：`POST /auth/login` 发 HttpOnly Cookie `zhiban_session`（SameSite=Lax、默认 7 天）；token 只存 SHA-256，密码 scrypt；写操作校验 Origin，支持 `Idempotency-Key`（10 分钟）；登录与业务分别限流。角色：

| 角色 | 权限 |
|---|---|
| admin | 全部（含 tenant.write、账号管理） |
| supervisor | 患者/草稿/告警/顾问操作/审计/导出/沙盒；不能改租户设定 |
| viewer | 只读 + 沙盒 |

`platform` 角色访问任何租户接口统一 404。

### 7.12 证据链 PDF

```
GET /drafts/:id/evidence.pdf（权限 export）
   ▼
EvidenceService.draftEvidence
   │  wecomAdmin.getDraftEvidence
   │    → C2 草稿 + 会话存档回读（发送记录）
   │    → buildEvidence 组装时间线
   ▼
pdfkit 渲染 A4 → 返回 application/pdf
   │  只记录导出人/字节数，不把正文写日志
```

患者服务记录同理：`GET /patients/:id/records.pdf` 汇总该患者所有群的草稿与核验状态。

### 7.13 沙盒

控制台沙盒是**独立闭环**：会话、消息、草稿、核验都写 `zhiban_console.sandbox_*`，**不碰真实 C2 草稿**，也不推真实顾问。它复用患者域运行时（`sandboxEnsure/Turn/InjectContext`），用于演示、培训、规则回归。沙盒草稿操作（send_original/send_edited/send_wrong_group/ignore）只产生沙盒核验结果。

---

## 8. 草稿状态机与队列

### 8.1 状态

```
                 ┌──────────┐
   入队 ────────►│  QUEUED  │
                 └────┬─────┘
                      │ 推送成功           推送失败 3 次
                      ▼                        │
                 ┌──────────┐                  ▼
                 │  PUSHED  │            ┌──────────┐
                 └────┬─────┘            │DEAD_LETTER│
        ┌─────────────┼──────────────┐    └──────────┘
        │ 已发送       │ 忽略          │ 管理员释放
        ▼             ▼              ▼
 ┌──────────────┐ ┌─────────┐   ┌──────────┐
 │ACKNOWLEDGED  │ │ SKIPPED │   │ RELEASED │
 └──────┬───────┘ └─────────┘   └──────────┘
        │ 回读核验
        ├── 完全一致 → VERIFIED
        ├── 相似≥0.9 → EDIT_SENT
        ├── 发错群   → MISROUTE_ALERT（连续 2 次暂停顾问）
        └── 4 次未匹配 → UNVERIFIED
```

- `FAILED`：推送失败但还可重试。
- 核验默认在确认后 3 分钟开始，失败每 5 分钟重试，最多 4 次，回看窗口 10 分钟。
- 员工忘点确认时，10 分钟后也会主动回读（`forgottenAckGraceMs`）。

### 8.2 队列规则

- **按顾问串行**：`active` 表记录每位顾问的队首；一个顾问同时只有一张活跃草稿。
- **提醒**：15 分钟。
- **升级**：60 分钟未处理，通知主管。
- **死信**：推送连续失败 3 次。
- **释放**：管理员在控制台释放队列，当前草稿终结，后续继续。

这条规则对测试很重要：如果上一条草稿停在 `PUSHED`，新草稿不会出现，看起来像「Agent 没回复」，实际是队列堵了。

---

## 9. 失败与降级

| 场景 | 表现 | 系统行为 |
|---|---|---|
| 模型超时 / 报错 / 未调工具（客户回合） | 回合失败 | 生成模板降级草稿（`fallback=true`），仍推给顾问 |
| 模型超时 / 未调工具（主动回合） | 计划失败 | 记 `patient.proactive.failed`，**不**生成模板草稿 |
| 会话不存在 / 预设错误 | 回合极慢或超时 | 检查 `zhiban-health` 预设与 sessions 表；已存在会话不会自动换预设 |
| 存档拉取失败 | 游标不推进 | 下轮重试；持续异常由看门狗告警 |
| 服务群名单缺失（部署回退） | 消息被静默丢弃 | **没有任何报错**；排查 `service_roster` 与 `lastActiveAt` |
| 图片读取失败 | 纯文字回合 | `patient.image.skipped`；草稿仍可用文字生成 |
| 语音转写失败 | 消息不处理 | `voiceFailed`，当前不重试（issue #137） |
| 卡片推送失败 | 草稿 `FAILED` | 重试；3 次后 `DEAD_LETTER` + 告警 |
| 顾问长时间不处理 | 草稿滞留 | 15 分钟提醒、60 分钟升级、可控制台释放 |
| 发错群 | `MISROUTE_ALERT` | 告警；连续 2 次暂停顾问 |
| 核验匹配不上 | `UNVERIFIED` | 告警；顾问可在详情看证据 |
| 存储写入失败 | 内存不变 | `PERSIST_FAILED` 告警 |
| 机器人长连接被顶掉 | 卡片/正文中断 | `BOT_DISCONNECTED` 告警 |
| 进程停机 | 期间消息无草稿 | 启动时 `DOWNTIME` 告警（阈值 10 分钟） |
| guard / memory / care 未安装 | 能力缺失 | 分别直通 / 空注入 / 不触发，不阻塞主链路 |

---

## 10. 关键不变量与红线

1. **不自动向客户群发消息**（F1）。系统写入客户群的唯一路径是「顾问本人在企微里发送」；机器人的所有输出都只发给员工 1:1。
2. **草稿必须真人确认**。卡片按钮只是「已发送 / 忽略」的自报，真实结果以存档回读为准。
3. **同一个机器人只允许一个长连接**。多开会互相挤下线，客户侧直接中断。
4. **昵称只对具有 `patient.read` 的员工可见**。患者名默认是「外部成员 …尾号」脱敏占位；昵称绝不进日志、错误信息、告警正文。
5. **日志与错误不含消息正文**。只记录 id、类型、字节数、字符数、规则名。
6. **凭据只存在 `/etc/zhiban/*.env` 或 0600 profile**，不读取、不打印、不提交。
7. **guard 不拦截推送**。它改写、分级、告警，最终决定权在顾问。
8. **控制台不直接读写别人的存储域**。所有跨模块访问都经服务名 API，并写审计。
9. **群发现不等于开始服务**。候选群必须人工确认服务对象后才进入服务流。
10. **数据保留要如实说**。会话存档最多 5 天；P1 不自动删除，界面文案必须写「当前演示环境不自动删除」。
11. **demo / dev 隔离**。`ZHIBAN_ENV` 与插件配置不一致拒绝启动；dev 用 demo 机器人会拒绝启动。
12. **非服务群不落正文、不下载图片、不生成草稿**，只计数。

---

## 11. 部署与运维

### 11.1 目录与凭据

| 路径 | 用途 |
|---|---|
| `/opt/zhiban/app` | 仓库部署副本（只读运行） |
| `/opt/zhiban/bin/archive_dump` | 存档拉取工具 |
| `/var/lib/zhiban/dsh` | `DSH_HOME`：profiles / sessions / storages / media |
| `/var/www/zhiban/console` | 控制台静态产物 |
| `/var/backups/zhiban` | 备份（0700/0600，保留 14 天） |
| `/etc/zhiban/*.env` | 凭据（0600 root）；ASR、客户联系等通过 drop-in 注入 |

### 11.2 发布流程（后端）

```bash
# 0. 必须先把 origin/main 合进当前分支——部署是按目录覆盖，
#    分支落后 main 会把线上更新的代码覆盖回旧版（2026-11-11 事故）
git fetch origin && git merge origin/main

# 1. 本地测试
npm test && npx tsc --noEmit

# 2. 上传 src/ 与 plugins/（按文件 or rsync），备份旧文件
# 3. 依赖变更时用 root 跑 npm ci --omit=dev（目录属 root）
# 4. 重启并验证
sudo systemctl restart dsh-zhiban
systemctl is-active dsh-zhiban
curl -fsS http://127.0.0.1:3080/ >/dev/null && echo alive
```

### 11.3 发布流程（控制台）

- **不要在生产 VM 上 `npm run build`**：2 GB 内存会被 `vite build` 打满，sshd 与隧道一起失联。在本地构建后 rsync 产物。
- 构建参数：`VITE_API_MODE=real`。
- 发布：`rsync -a --delete dist/ /var/www/zhiban/console/`，旧目录先备份。
- 验证：`/`、`/assets/*`、SPA 回退均 200；`/zhiban/api/auth/session` 未登录 401。

### 11.4 运维定时器

| 单元 | 周期 | 行为 |
|---|---|---|
| `zhiban-backup.timer` | 每天 03:20 | 备份 DSH_HOME（profiles/sessions/storages/media），生成 `.sha256`，保留 14 天 |
| `zhiban-watchdog.timer` | 每 5 分钟 | 检查 DSH HTTP、存档 `lastPolledAt`、机器人 `connected`、模型状态；单项连续异常 10 分钟告警，恢复后通知 |
| `zhiban-report.timer` | 每天 09:00 | 读模型状态，推送调用次数/估算费用/降级次数；读不到就失败退出，不编造 |

### 11.5 备份与恢复

- 备份脚本排除 `*.log`、`tmp/*`、`node_modules/*`；目录 0700、文件 0600。
- 恢复要求目标目录不存在或为空，先校验 sha256，绝不覆盖运行中数据；恢复后 `chown -R zhiban:zhiban` 再启动。
- 本机演练脚本 `deploy/scripts/drill-backup-restore.sh` 已 `PASS`。

### 11.6 排障顺序（最常用）

1. **服务是否活着**：`systemctl is-active dsh-zhiban`、`curl 127.0.0.1:3080`。
2. **存档是否在推进**：`zhiban_wecom.json` 的 `meta.archive_seq`（值是 `{value: ...}` 包装）。
3. **消息有没有进患者域**：对应 `grp_*` / `pat_*` 的 `lastActiveAt`。
4. **是不是服务群**：`meta.service_roster` 里该 roomId 是否 active。
5. **有没有生成回合/草稿**：`sessions` 表、`drafts` 表。
6. **队列是否堵住**：`active` 表里该顾问是否有一张 `PUSHED`。
7. **核验为什么失败**：草稿详情的证据与存档回读窗口。

---

## 12. 代码地图

| 关注点 | 位置 |
|---|---|
| 企微通道入口 | `plugins/zhiban-wecom/index.ts`（装配、触发器、adminApi） |
| 存档轮询与机器人 | `plugins/zhiban-wecom/runtime.ts` |
| 动态服务群名单 | `plugins/zhiban-wecom/service-groups.ts` |
| 群发现 | `plugins/zhiban-wecom/group-discovery.ts` |
| 群名/昵称 | `plugins/zhiban-wecom/group-info.ts` |
| 话术查询 | `plugins/zhiban-wecom/script-query.ts` |
| C2 草稿服务 | `src/c2/service.ts`、`state-machine.ts`、`queue.ts`、`verifier.ts`、`matcher.ts` |
| 存档适配器 | `src/c2/adapters/wecom-archive.ts` |
| 语音识别 | `src/c2/tencent-asr.ts`、`src/c2/media.ts` |
| 患者域装配 | `plugins/zhiban-patient/index.ts` |
| 回合编排 | `src/p1/runtime.ts` |
| 患者服务/群/绑定 | `src/p1/patient-service.ts` |
| 患者存储 | `src/p1/patient-store.ts`、`plugins/zhiban-patient/domain.ts` |
| 提示词与人设 | `src/p1/persona.ts`、`src/p1/session-port.ts` |
| 会话桥 | `plugins/zhiban-patient/sessions.ts` |
| 记忆 | `plugins/zhiban-memory/index.ts`、`src/p1/memory.ts`、`memory-tools.ts` |
| 关怀计划 | `plugins/zhiban-care/index.ts`、`src/p1/care.ts`、`care-tools.ts` |
| 风控 | `plugins/zhiban-guard/index.ts`、`src/p1/guard.ts`、`guard-tools.ts` |
| 知识库 | `plugins/zhiban-knowledge/index.ts`、`src/p1/knowledge.ts` |
| 图片/餐食 | `src/p1/vision.ts`、`meal-tools.ts` |
| 控制台后端 | `plugins/zhiban-console/index.ts`、`domain.ts`、`http.ts`、`sse.ts` |
| 控制台视图 | `src/p1/console-views.ts`、`console-alerts.ts` |
| 控制台前端 | `console/src/`（`layout/`、`pages/`、`mock/`） |
| 证据 PDF | `src/p1/evidence.ts`、`plugins/zhiban-console/pdf.ts` |
| 部署 | `deploy/systemd/`、`deploy/nginx/zhiban.conf`、`deploy/scripts/` |

---

## 13. 已知差异、未完成与待确认

| 项 | 状态 | 说明 |
|---|---|---|
| 语音转写重试 | 未做 | issue #137：有界重试 + 插件文件日志 + 可选告警 |
| 知识库 `customSkillDirs` | 部署配置项 | 仓库无 profile 文件，需现场确认已加入 skill 目录 |
| 记忆 `subject=family` 服务端强制 | 软约束 | 仅提示词约束，工具层未强制兜底 |
| `storage-sqlite` 文档表述 | 与实现不符 | 实际为 JSON 后端，文档表名需映射 |
| 慢病管理（原「健康档案」） | 已接入 | 患者域 `chronic_profiles`；顾问手工录入 + `chronic_record_write` 对话提取，`source` 区分来源；不存报告原文、不做诊断 |
| 服务计划 | 未接入 | 控制台固定返回空 + `sample:true` |
| 报表页 | 未接入 | 真实模式显示「尚未接入真实统计」 |
| 企微状态 / 模型设置 / onboarding 页 | 无后端接口 | `RealModeOnly` 在真实模式显示未接入 |
| 控制台前端子路径 `/zhiban/` | 未做 | 当前挂根路径 `/`；改子路径需 `basename` + `--base` |
| 20–50 并发容量 | 未测 | 2 vCPU / 2 GB，属于 P1 之后 |
| 自动删除 / 保留策略 | 不做 | 文案必须如实写「当前演示环境不自动删除」 |
| 群发现 owner 字段兼容 | 已修（#107） | 线上响应无 `owner`，改用请求体 `owner_filter.userid_list` |

---

## 14. 术语表

| 术语 | 含义 |
|---|---|
| **DSH** | DeepSeek Harness，Agent 底座，单进程插件宿主 |
| **profile** | DSH 的插件组合层，由 `cordis.yml` + `cordis.patch.yml` 定义 |
| **存储域** | DSH 的持久化单元，一张域包含多张表，落盘为 JSON |
| **C2** | 本项目的「客户通道」子系统：存档 → 草稿 → 推送 → 核验 |
| **草稿（draft）** | Agent 生成、等待顾问确认的回复正文 |
| **核验（verify）** | 回读存档，判断实际发出的内容与草稿的关系 |
| **服务群名单（roster）** | 运行时决定「哪些群属于服务范围」的动态名单 |
| **会话存档** | 企微的付费消息读取能力，≤5 天、轮询、非实时 |
| **客户联系 API** | 企微的客户群/成员信息接口，用于群名与昵称 |
| **skill** | DSH 的文件形态能力注入，知识库与餐食识别用它 |
| **沙盒** | 控制台里与真实 C2 完全隔离的演练环境 |
| **模板降级** | 模型失败时用固定模板生成草稿（仅客户回合） |

---

> 维护提示：改架构时同步更新本文件的三处——§5.3 服务表、§7 数据流、§13 已知差异。代码是事实来源；本文若与代码冲突，以代码为准并修文档。
