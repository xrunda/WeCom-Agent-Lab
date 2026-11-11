# 知伴健康 Agent · P1 统一数据模型

> 版本：**v1.0**（2026-11-09）· 归属：WP-A（#62）
> 配套：[P1-api.md](./P1-api.md) · 范围：[P1-scope.md](./P1-scope.md) · 平台约束：[HANDOFF-C2-business-product.md](./HANDOFF-C2-business-product.md) §1
> 本文是前后端字段的**唯一依据**。后端实现、前端 mock、fixtures 与本文不一致时，以本文为准；需要改字段时按 §10 的流程走。

---

## 0. 一句话

P1 的业务数据围绕五个东西组织：**租户（tenant）→ 服务群（group）→ 患者（patient）→ 患者的 Agent 产出（draft / memory / care_plan / meal_log）→ 送达证据（delivery / verification）**。所有实体都带 `tenantId`，所有对外行为都能追到 `audit_event`。

---

## 1. 通用约定

### 1.1 标识

- 所有 id 为字符串，格式 `<前缀>_<opaque>`，`opaque` 建议用 26 位 ULID（小写）。**前端不得解析 id 内部结构。**
- C2 核心已用 `draft_<序号>`（如 `draft_1`），符合 `draft_<opaque>`，**迁移时沿用，不重编号**。新产生的草稿也用同一前缀。

| 前缀 | 实体 | 示例 |
|---|---|---|
| `tn_` | tenant | `tn_01j9z3k4m5n6p7q8r9s0t1u2v3` |
| `acc_` | account | `acc_...` |
| `adv_` | advisor | `adv_...` |
| `grp_` | group | `grp_...` |
| `gm_` | group_member | `gm_...` |
| `gbd_` | group_binding | `gbd_...` |
| `pat_` | patient | `pat_...` |
| `mem_` | memory | `mem_...` |
| `pln_` | care_plan | `pln_...` |
| `meal_` | meal_log | `meal_...` |
| `knw_` | knowledge | `knw_...` |
| `rul_` | risk_rule | `rul_...` |
| `draft_` | draft | `draft_1` / `draft_01j9...` |
| `dly_` | delivery | `dly_...` |
| `vrf_` | verification | `vrf_...` |
| `alt_` | alert | `alt_...` |
| `aud_` | audit_event | `aud_...` |
| `act_` | agent_action | `act_...` |
| `obr_` | onboarding_request | `obr_...` |
| `skl_` | skill | `skl_zhiban-wecom` |
| `spk_` | solution_pack | `spk_health-care` |
| `med_` | media | `med_...` |
| `evt_` | SSE event | `evt_...` |

关联字段一律叫 `xxxId`（如 `patientId`），复数数组叫 `xxxIds`。**不出现 `xxx_id` 这种混合命名。**

### 1.2 时间

- 所有时间字段为**毫秒级 Unix 时间戳（整数，UTC）**，字段名以 `At` 结尾：`createdAt`、`pushedAt`、`checkedAt`。
- 只有 `care_plan.when` 是业务时间点，也是毫秒时间戳。
- 仅日期语义的字段（如生日）用 `YYYY-MM-DD` 字符串，字段名以 `Date` 结尾；P1 暂不涉及。
- 前端按 `tenant.timezone`（默认 `Asia/Shanghai`）展示。
- 查询参数 `from` / `to` 接受毫秒时间戳或 ISO 8601；`to` 为**开区间**。

### 1.3 多租户

- 每个业务实体都有 `tenantId`。服务端从登录会话推导租户，**不接受客户端传入 `tenantId`**；请求体里出现会被忽略并记审计。
- 所有查询强制带租户条件；跨租户访问返回 `404 NOT_FOUND`（不暴露实体是否存在）。
- P1 只有一个业务租户；平台超管（`platform`）是唯一可以跨租户的角色，且只能通过运维通道使用。

### 1.4 `sandbox` 与 `demo` 是两个不同的标记

| 标记 | 含义 | 进统计 | 界面表现 |
|---|---|---|---|
| `sandbox: true` | 体验中心模拟渠道产生的数据，渠道是假的，Agent 是真的 | **不进**工作台、报表、告警角标 | 「体验沙盒」标识；可一键重置 |
| `demo: true` | 真实链路跑出来的演示患者数据（虚构人物、真实发送） | **进**统计 | 「演示患者」标签 |
| 都为 false | 真实客户数据 | 进统计 | 无标记 |

- `sandbox` 只出现在 draft、delivery、verification、alert、memory、care_plan、meal_log、agent_action、audit_event 上。
- `demo` 只出现在 patient、group 上；由患者/群继承到其产出的 draft。
- 任何列表接口默认排除 `sandbox: true`，除非显式 `sandbox=true`；`demo` 默认包含。

### 1.5 软删除

- 可删实体（patient、memory、knowledge、script、group_binding、account）用 `deletedAt`（毫秒或 `null`）标记，**不物理删除**。
- 列表默认排除 `deletedAt != null`；`includeDeleted=true` 仅 admin 可用。
- 删除操作必须写 `audit_event`，记录 `deletedBy`（若实体有该字段）。
- 记忆、知识被删除后，Agent 下一轮不再引用；历史草稿中已引用的 id 保留，详情按「已删除」展示。

### 1.6 枚举命名

- API 枚举值用 `lower_snake_case`（`collect_only`、`edit_sent`）。
- **例外**：草稿状态沿用 C2 的大写常量（`VERIFIED`、`EDIT_SENT`…），避免在核心链路上做翻译；前端映射表见 §6。

### 1.7 分页与排序

- 列表接口统一 `page`（默认 1）、`pageSize`（默认 20，最大 100），响应 `{ items, page, pageSize, total }`。
- 排序统一 `sort`，字段前加 `-` 表示倒序：`sort=-createdAt`。未指定时按各接口的默认排序（见 API 文档）。
- 实时变化不走分页轮询，走 SSE。

### 1.8 字段可空性

- 文档表格中「可空」为「是」的字段，响应中可能为 `null` 或省略；前端必须按可空处理。
- 数组字段一律返回数组，没有数据时为 `[]`，不返回 `null`。

---

## 2. 实体关系

```text
tenant 1─┬─< account
         ├─< advisor 1─< group >─1 patient        （group_binding 多对多）
         │                └─< group_member
         ├─< patient 1─┬─< memory
         │             ├─< care_plan
         │             ├─< meal_log
         │             ├─< agent_action
         │             └─< draft 1─┬─< draft_revision（内嵌数组）
         │                          ├─< delivery 1─< verification
         │                          └─< alert
         ├─< knowledge
         ├─< risk_rule
         ├─< audit_event
         └─< onboarding_request

skill / solution_pack：从 DSH 插件清单与静态配置派生，不落业务库
health_profile / service_plan / script_template：B 档示例实体，只在前端 sample 层
media：文件在磁盘，元数据随消息保存
```

一条链路示例：`patient → group → 客户消息 → draft（v1 → v2）→ delivery → verification → alert`，每一步都写 `audit_event`，`agent_action` 记录 Agent 的工具调用。

---

## 3. 实体定义

> 字段类型：`string` / `number` / `boolean` / `enum` / `object` / `array<T>`。金额单位均为**元**。

### 3.1 tenant

机构（租户）及其配置。P1 只有一个业务租户。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `tn_...` |
| `name` | string | 否 | 机构名称，展示在控制台左上角 |
| `agentName` | string | 否 | Agent 名字，默认「小安」 |
| `agentAvatar` | string | 是 | 头像 URL；空时用默认图 |
| `patientTerm` | string | 否 | 对服务对象的称谓：患者 / 客户 / 会员，默认「患者」 |
| `tone` | string | 否 | 语气说明，注入系统提示词 |
| `timezone` | string | 否 | IANA 时区，默认 `Asia/Shanghai` |
| `settings` | object | 否 | 运营参数，见下表 |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |

`settings`：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `archiveSeatPriceYuan` | number | 900 | 会话存档单价（元/人/年），D16；用于成本卡片与计算器 |
| `writeMinutesPerDraft` | number | 3 | 估算「人工写一条草稿」的分钟数，价值看板口径 |
| `mergeWindowSeconds` | number | 30 | 患者连发合并窗口（#63） |
| `quietHours` | object | `{"start":"21:00","end":"08:00"}` | 主动计划安静时段 |
| `proactivePerHour` | number | 6 | 每位顾问每小时最多主动草稿数 |
| `modelName` | string | `deepseek-v4.1-flash` | 当前模型，只读回显 |
| `retentionNotice` | string | 见下 | 数据与安全页的留存口径，必须与实现一致 |
| `memoryInjectLimit` | number | 30 | 每轮注入记忆条数上限 |

`retentionNotice` 默认值：**「按合同约定；当前演示环境不自动删除」**。P1 没有自动删除任务，任何「保留 N 天」的写法都属于伪造（#59）。

### 3.2 account

控制台登录账号。**永远不返回密码哈希。**

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `acc_...` |
| `tenantId` | string | 否 | |
| `username` | string | 否 | 登录名，租户内唯一 |
| `displayName` | string | 否 | 显示名 |
| `role` | enum | 否 | `admin` / `supervisor` / `viewer` / `platform` |
| `status` | enum | 否 | `active` / `disabled` |
| `lastLoginAt` | number | 是 | |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |
| `deletedAt` | number | 是 | 软删除 |

- `platform` 由部署配置生成，`tenantId` 为 `null`，不出现在租户的账号列表里。
- 角色权限矩阵见 [P1-api.md](./P1-api.md) §2。

### 3.3 advisor

企微侧的顾问（员工）。C2 的 `Advisor` 在此基础上补齐租户与席位字段。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `adv_...`；与 C2 `Advisor.id` 同值 |
| `tenantId` | string | 否 | |
| `wecomUserId` | string | 否 | 企微 userid |
| `name` | string | 否 | |
| `status` | enum | 否 | `active` / `paused` / `left` |
| `seatExpireAt` | number | 是 | 会话存档席位到期时间 |
| `chatBound` | boolean | 否 | 是否已完成与机器人的 1:1 开通（C2 `chatId` 是否存在） |
| `online` | boolean | 否 | 派生：当前长连接内是否活跃 |
| `queueDepth` | number | 否 | 派生：该顾问 QUEUED + PUSHED 的草稿数 |
| `consecutiveMisroutes` | number | 否 | 连续错群次数，达到阈值自动 paused |
| `pausedAt` | number | 是 | |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |

- `online`、`queueDepth` 是**读时派生字段**，不落库。
- C2 的 `noChatIdAlerted` 不对外暴露，转为 `chatBound=false` 与告警。

### 3.4 group

企微外部客户群。产品主键之一：**群 = 会话容器，患者通过绑定关系接入**。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `grp_...` |
| `tenantId` | string | 否 | |
| `roomId` | string | 否 | 会话存档 roomid（`wr` 前缀），全局唯一 |
| `chatId` | string | 是 | 客户群 API 的 chat_id，可能与 roomId 不同 |
| `name` | string | 否 | 群名；来源见 `nameSource` |
| `nameSource` | enum | 否 | `config` / `api` / `members` / `roomid` / `manual`；`api` = 企微群名同步，`manual` = 控制台手工改名（优先，不被企微覆盖） |
| `status` | enum | 否 | `pending` / `serving` / `collect_only` / `disabled` |
| `advisorId` | string | 是 | 负责顾问；`pending` 时可能为空 |
| `patientIds` | array<string> | 否 | 派生：绑定患者，来自 group_binding |
| `memberCount` | number | 否 | 群成员总数（含内部员工） |
| `externalMemberCount` | number | 否 | 外部成员数（`wm` 开头） |
| `consent` | object | 否 | `{ agreed, unknown, disagreed }`，该群外部成员的存档同意统计 |
| `lastActiveAt` | number | 是 | 最近一条存档消息时间 |
| `demo` | boolean | 否 | 演示群 |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |
| `deletedAt` | number | 是 | 默认不展示，保留排障 |

**状态语义**（#33）：

| 值 | 含义 | C2 对应 |
|---|---|---|
| `pending` | 自动发现、待管理员确认 | `unassigned` |
| `serving` | 服务中，消息触发 Agent 回合 | `mapped` |
| `collect_only` | 仅采集，写上下文与存档，不触发回合、不产出草稿 | 无（C2 视为非服务群，但仍保存上下文） |
| `disabled` | 停用，正文不落库、不进日志 | `disabled` |

### 3.5 group_member

群成员及 P1 的角色标注。成交前的关键：家属说的话不能记成患者本人的事实（#63）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `gm_...` |
| `tenantId` | string | 否 | |
| `groupId` | string | 否 | |
| `externalUserId` | string | 是 | 外部成员企微 id（`wm...`）；内部员工为空 |
| `externalUserIdTail` | string | 是 | 后 6 位，用于界面展示 |
| `displayName` | string | 否 | 群昵称或姓名；存档无昵称（F8）时用 id 尾号 |
| `isExternal` | boolean | 否 | |
| `staffUserId` | string | 是 | 内部员工的企微 userid |
| `role` | enum | 否 | `self` / `family` / `advisor` / `colleague` / `unknown` |
| `consent` | enum | 否 | `agreed` / `unknown` / `disagreed`（仅外部成员有效） |
| `lastActiveAt` | number | 是 | |
| `annotatedBy` | string | 是 | 账号 id |
| `annotatedAt` | number | 是 | |

- 未标注一律 `unknown`；`advisor` / `colleague` 内部员工由员工身份自动判定。
- 一个外部成员在同一租户的多个群里可以有不同角色（P1 允许），以群内标注为准。
- 群昵称来自「客户联系」接口 `externalcontact/groupchat/get?need_name=1`（需要可信 IP 与客户联系权限）；查询失败、内部群（90501）或未配置凭据时回退 id 尾号。昵称只用于界面展示，不写日志。

### 3.6 group_binding

群与患者的多对多绑定。**患者群列表的唯一事实来源。**

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `gbd_...` |
| `tenantId` | string | 否 | |
| `groupId` | string | 否 | |
| `patientId` | string | 否 | |
| `isPrimary` | boolean | 否 | 主群；卡片与详情优先展示 |
| `createdAt` | number | 否 | |
| `deletedAt` | number | 是 | 解绑即软删除 |

- 同一 `(tenantId, groupId, patientId)` 同时只能有一条未删除记录。

### 3.7 patient

机构服务的对象。**一位患者 = 一个 DSH 工作区 + 一条长期会话。**

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `pat_...` |
| `tenantId` | string | 否 | |
| `displayName` | string | 否 | 备注名；占位名（`外部成员 …尾号`）会在拿到真实群昵称后自动回填，手工名不覆盖 |
| `avatar` | string | 是 | |
| `externalUserId` | string | 是 | 主外部成员 id（`wm...`），用于路由与同意状态 |
| `identityStatus` | enum | 是 | `pending`（系统按发言猜测）/ `confirmed`（顾问手动确认/改绑） |
| `identitySource` | enum | 是 | `auto` / `manual` |
| `identityConfirmedAt` | number | 是 | 最近一次确认/改绑时间 |
| `tags` | array<string> | 否 | 如 `["控糖","高血压"]`，控制台自由编辑 |
| `advisorId` | string | 是 | 主责顾问 |
| `groupIds` | array<string> | 否 | 派生：绑定群 |
| `consent` | enum | 否 | `agreed` / `unknown` / `disagreed`；未同意不自动服务 |
| `consentCheckedAt` | number | 是 | |
| `status` | enum | 否 | `serving` / `paused` / `archived` |
| `demo` | boolean | 否 | 演示患者 |
| `accompaniedSince` | number | 否 | 开始陪伴时间（首次绑定服务群） |
| `lastActiveAt` | number | 是 | 最近一条双向消息时间 |
| `memoryCount` | number | 否 | 派生：有效记忆条数 |
| `pendingPlanCount` | number | 否 | 派生：待执行计划数 |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |
| `deletedAt` | number | 是 | |

- `consent != agreed` 时，控制台显示「该成员未同意存档，需人工服务」；该患者不进入自动草稿。
- `groupIds`、`memoryCount`、`pendingPlanCount` 为读时派生。

### 3.8 memory

患者的长期记忆。**可查、可改、可删，变更必审计。**

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `mem_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `category` | enum | 否 | `dietary_taboo` / `routine` / `goal` / `body` / `family` / `preference` / `other` |
| `content` | string | 否 | 一句话事实，≤ 200 字 |
| `subject` | enum | 否 | `self` / `family` / `unknown`；家属的事不记成患者本人 |
| `sourceMsgId` | string | 是 | 抽取自哪条存档消息 |
| `sourceText` | string | 是 | 原话摘要，≤ 100 字 |
| `createdBy` | enum | 否 | `agent` / `staff` |
| `createdById` | string | 是 | staff 时为账号 id |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | 任意修改（含只更新来源）的时间 |
| `revisedAt` | number | 是 | 内容 / 分类 / 归属被真正修正的时间；时间线据此生成「修正记忆」事件 |
| `updatedBy` | enum | 是 | `agent` / `staff`，最近一次修正人 |
| `updatedById` | string | 是 | staff 时为账号 id |
| `deletedAt` | number | 是 | 软删除 |
| `deletedBy` | string | 是 | 账号 id |
| `sandbox` | boolean | 否 | |

分类的中文标签由前端映射：

| 值 | 标签 |
|---|---|
| `dietary_taboo` | 饮食禁忌 / 过敏 |
| `routine` | 作息 |
| `goal` | 健康目标 |
| `body` | 身体状况 |
| `family` | 家庭情况 |
| `preference` | 偏好 |
| `other` | 其他 |

### 3.9 care_plan

主动计划（#36）。由 `zhiban-care` 调度器驱动；本版 DSH `ctx.schedule` 没有
插件侧到期回调，实现改为领域存储 + 单定时器，语义与字段不变
（详细偏差见 [P1 长期记忆与主动关怀](./P1-memory-care.md) §3.4）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `pln_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `title` | string | 否 | 如「提醒量血压」 |
| `when` | number | 否 | 计划触发时间 |
| `rrule` | string | 是 | RFC 5545 重复规则；一次性计划为空 |
| `source` | enum | 否 | `agent` / `staff` |
| `status` | enum | 否 | `pending` / `done` / `cancelled` |
| `quietHoursShifted` | boolean | 否 | 是否因安静时段顺延 |
| `lastFiredAt` | number | 是 | |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |
| `sandbox` | boolean | 否 | |

### 3.10 meal_log

餐食记录（#55）。一张餐食图 → 一条饮食记录。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `meal_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `groupId` | string | 否 | |
| `messageId` | string | 是 | 存档 msgid |
| `mediaId` | string | 是 | 图片资源 id；无图时为空 |
| `photoUrl` | string | 是 | 鉴权读取地址 `/zhiban/api/media/{mediaId}` |
| `mealType` | enum | 否 | `breakfast` / `lunch` / `dinner` / `snack` / `unknown` |
| `foods` | array<object> | 否 | `[{ "name": "清蒸鲈鱼", "portion": "约 150g" }]`，`portion` 可空 |
| `notes` | string | 是 | Agent 或人工补充 |
| `agentComment` | string | 是 | 给患者的点评摘要 |
| `confidence` | number | 否 | 0–1；< 0.6 时草稿用询问句 |
| `sandbox` | boolean | 否 | |
| `createdAt` | number | 否 | |

### 3.11 knowledge

机构知识条目（#38）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `knw_...` |
| `tenantId` | string | 否 | |
| `category` | string | 否 | 分类名，自由文本，如「饮食建议」 |
| `title` | string | 否 | ≤ 60 字 |
| `content` | string | 否 | ≤ 2000 字 |
| `enabled` | boolean | 否 | 停用后不再生成为 skill 资源 |
| `hits` | number | 否 | 被草稿引用的累计次数 |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |
| `deletedAt` | number | 是 | |

### 3.12 risk_rule

风险规则（#37、#48）。红线只读，关键词可配。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `rul_...` |
| `tenantId` | string | 否 | 内置红线为 `rul_builtin_*`，所有租户共享只读 |
| `kind` | enum | 否 | `redline` / `keyword` |
| `name` | string | 否 | |
| `keywords` | array<string> | 否 | 命中词；红线类为说明性词表 |
| `riskLevel` | enum | 否 | `low` / `medium` / `high`；命中后取最高 |
| `action` | enum | 否 | `flag`（标高风险）/ `guide`（只引导就医）/ `escalate`（升级人工） |
| `enabled` | boolean | 否 | 红线恒为 true |
| `builtin` | boolean | 否 | 内置规则不可改删 |
| `hitCount` | number | 否 | 累计命中 |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |

内置红线（P1 固定四条）：

| id | name | action |
|---|---|---|
| `rul_builtin_no_diagnosis` | 不诊断 | `flag` |
| `rul_builtin_no_medication` | 不调药 | `flag` |
| `rul_builtin_no_efficacy` | 不承诺疗效 | `flag` |
| `rul_builtin_emergency` | 急症只引导就医 | `escalate` |

### 3.13 draft

**核心实体。** 一份待顾问发出的回复，及其全部版本、风险与核验结果。字段主体来自 C2 `Draft`，补齐租户、患者、来源、版本与引用。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `draft_<opaque>`；C2 迁移数据沿用 `draft_<n>` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `externalUserId` | string | 是 | 触发本次草稿的客户 `wm` id |
| `groupId` | string | 否 | 内部群 id |
| `groupRoomId` | string | 否 | 存档 roomid，排障与核验用 |
| `groupName` | string | 否 | 冗余，卡片与列表直接展示 |
| `groupNameSource` | enum | 是 | 同 group.nameSource |
| `advisorId` | string | 否 | |
| `source` | enum | 否 | `inbound`（患者提问）/ `proactive`（Agent 主动） |
| `inboundMessageIds` | array<string> | 否 | 合并窗口内的消息（#63）；`inbound` 时至少一条，`proactive` 时为空数组 |
| `inboundSummary` | string | 否 | 卡片上的摘要，只进卡片不进正文；`proactive` 时填触发原因（如「按计划提醒测血糖」） |
| `mediaIds` | array<string> | 否 | 本条输入附带的图片（服务端路径，不出接口） |
| `mediaKinds` | array<string> | 否 | 图片类型：`image` / `meal` / `report` / `medicine`；无图时为空数组 |
| `mediaForwardedAt` | number | 是 | 原图转发到服务群的时间；仅 C2 队列使用，重试时不再重复发送 |
| `body` | string | 否 | **当前版本**正文，≤ 1000 字 |
| `version` | number | 否 | 当前版本号，从 1 开始 |
| `revisions` | array<object> | 否 | 版本历史，见下 |
| `sentVersion` | number | 是 | 核验匹配到的实发版本；未核验为空 |
| `riskLevel` | enum | 否 | `low` / `medium` / `high` |
| `status` | enum | 否 | 见 §6，**大写 C2 常量** |
| `ruleIds` | array<string> | 否 | 命中的风险规则 id |
| `ruleNames` | array<string> | 是 | 命中的风险规则名称，与 `ruleIds` 一一对应；卡片优先显示名称，旧数据为空时回退到 id |
| `citedMemoryIds` | array<string> | 否 | Agent 声明引用的记忆 |
| `citedKnowledgeIds` | array<string> | 否 | Agent 声明引用的知识 |
| `fallback` | boolean | 否 | 是否为模板草稿（模型超时/报错/未调工具） |
| `sandbox` | boolean | 否 | |
| `demo` | boolean | 否 | 继承患者 |
| `cardTaskId` | string | 是 | 企微模板卡片 task_id（F12：必须唯一） |
| `pushAttempts` | number | 否 | |
| `verifyAttempts` | number | 否 | |
| `lastInboundAt` | number | 是 | 客户最后一条消息时间 |
| `createdAt` | number | 否 | |
| `queuedAt` | number | 否 | |
| `pushedAt` | number | 是 | |
| `ackedAt` | number | 是 | 顾问点卡片的时间 |
| `verifiedAt` | number | 是 | 核验完成时间 |
| `releasedAt` | number | 是 | 管理员释放队列的时间 |
| `remindedAt` | number | 是 | 15 分钟提醒时间 |
| `escalatedAt` | number | 是 | 60 分钟升级时间 |
| `ackAction` | enum | 是 | `sent` / `skipped` |
| `verificationId` | string | 是 | 最近一次核验结果 |
| `errorCode` | string | 是 | 最后失败原因 |

`revisions[]`：

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `version` | number | 否 | 1, 2, 3… |
| `body` | string | 否 | 该版本正文 |
| `instruction` | string | 是 | 顾问改稿指令；v1 为空 |
| `createdBy` | enum | 否 | `agent` / `staff` |
| `createdAt` | number | 否 | |

- `body` 永远等于 `revisions` 中 `version` 最大的一条的正文，避免两处不一致。
- 改稿次数 = `version - 1`，价值看板用（#58）。
- `fallback=true` 的草稿仍进入核验链路，只是卡片标「模板草稿」。

### 3.14 delivery

一次实际送达的尝试（匹配到的存档消息）。与 draft 分离，因为一次草稿可能被多次回读、也可能发错群。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `dly_...` |
| `tenantId` | string | 否 | |
| `draftId` | string | 否 | |
| `version` | number | 否 | 实发正文对应的草稿版本 |
| `advisorId` | string | 否 | |
| `groupId` | string | 否 | 期望发送的群 |
| `roomId` | string | 否 | 实际匹配到的存档 roomid |
| `msgid` | string | 否 | 存档消息 id |
| `text` | string | 否 | 实发正文 |
| `sentAt` | number | 否 | 存档 msgtime |
| `source` | enum | 否 | `archive` / `sandbox` |
| `sandbox` | boolean | 否 | |
| `createdAt` | number | 否 | |

### 3.15 verification

核验结果。C2 `VerificationResult` 的持久化形态。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `vrf_...` |
| `tenantId` | string | 否 | |
| `draftId` | string | 否 | |
| `deliveryId` | string | 是 | `unverified` 时为空 |
| `outcome` | enum | 否 | `verified` / `edit_sent` / `misroute` / `unverified` |
| `matchedMsgId` | string | 是 | |
| `matchedRoomId` | string | 是 | 实际群 |
| `matchedGroupName` | string | 是 | 实际群名，发错群场景展示 |
| `similarity` | number | 是 | 0–1，模糊匹配相似度 |
| `attempts` | number | 否 | 回读次数 |
| `checkedAt` | number | 否 | |
| `sandbox` | boolean | 否 | |

四种结果与产品语言：

| outcome | 界面 | 说明 |
|---|---|---|
| `verified` | ✅ 已核验 | 实发正文与草稿一致，且发对了群 |
| `edit_sent` | ✏️ 改后发送 | 顾问手动改过正文后发出 |
| `misroute` | ⚠️ 发错群 | 发到了别的群 |
| `unverified` | ❌ 未核验 | 点了已发送，但存档里找不到 |

### 3.16 alert

可处理的告警（#39）。C2 `Alert` 从日志升级为实体。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `alt_...` |
| `tenantId` | string | 否 | |
| `kind` | enum | 否 | `misroute` / `unverified` / `remind` / `escalate` / `dead_letter` / `advisor_paused` / `redline` / `push_failed` / `no_chat_id` |
| `severity` | enum | 否 | `info` / `warning` / `critical` |
| `status` | enum | 否 | `open` / `acknowledged` / `resolved` |
| `title` | string | 否 | 一句话，如「王顾问连续两次发错群」 |
| `message` | string | 否 | 详情，**不含消息正文** |
| `draftId` | string | 是 | |
| `patientId` | string | 是 | |
| `advisorId` | string | 是 | |
| `groupId` | string | 是 | |
| `note` | string | 是 | 处理备注 |
| `resolvedBy` | string | 是 | 账号 id |
| `resolvedAt` | number | 是 | |
| `escalatedTo` | string | 是 | 升级推送到的账号 id |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |
| `sandbox` | boolean | 否 | |

`kind` 与 C2 `AlertKind` 映射：`MISROUTE→misroute`、`UNVERIFIED→unverified`、`DEAD_LETTER→dead_letter`、`ADVISOR_PAUSED→advisor_paused`、`ESCALATED→escalate`、`PUSH_FAILED→push_failed`、`NO_CHATID→no_chat_id`；新增 `remind`、`redline`。

### 3.17 audit_event

所有操作与状态变化。只追加，不改不删。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `aud_...` |
| `tenantId` | string | 否 | |
| `actorType` | enum | 否 | `account` / `system` / `agent` / `platform` |
| `actorId` | string | 是 | 账号 id 或 Agent 名 |
| `actorName` | string | 否 | 展示名；系统事件为 `system` |
| `action` | string | 否 | `draft.enqueue`、`memory.delete`、`alert.resolve`、`evidence.export`… |
| `targetType` | string | 否 | `draft` / `memory` / `patient` / `account`… |
| `targetId` | string | 是 | |
| `result` | enum | 否 | `success` / `failure` |
| `detail` | object | 是 | 结构化摘要；**不得包含消息正文或凭据** |
| `errorCode` | string | 是 | |
| `ip` | string | 是 | 脱敏到网段，如 `203.0.113.*` |
| `at` | number | 否 | |
| `sandbox` | boolean | 否 | |

C2 `AuditEvent` 的 `{ at, actor, action, target, result, errorCode }` 映射为：`actor → actorName`，`target → targetId`，其余同名。

### 3.18 agent_action

Agent 的「办事记录」（患者主页 Tab）。每次工具调用一条。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `act_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `draftId` | string | 是 | 由该动作产出的草稿 |
| `tool` | enum | 否 | `reply_draft` / `reply_skip` / `memory_write` / `memory_update` / `schedule_create` / `escalate_to_human` / `image_classify` / `meal_log_write` |
| `summary` | string | 否 | 一句话结果，如「新增饮食禁忌：海鲜过敏」 |
| `result` | enum | 否 | `success` / `failed` / `skipped` |
| `errorCode` | string | 是 | |
| `createdAt` | number | 否 | |
| `sandbox` | boolean | 否 | |

### 3.19 onboarding_request

「申请开通」提交的记录（#61）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `obr_...` |
| `tenantId` | string | 否 | |
| `contactName` | string | 否 | |
| `contactPhone` | string | 否 | 手机号或企微号 |
| `contactTitle` | string | 是 | 职务 |
| `expectedAdvisors` | number | 否 | 预计顾问人数 |
| `expectedPatients` | number | 否 | 预计服务患者数 |
| `note` | string | 是 | |
| `consentToContact` | boolean | 否 | 同意我方联系 |
| `status` | enum | 否 | `submitted` / `contacted` / `closed` |
| `createdBy` | string | 否 | 账号 id |
| `createdAt` | number | 否 | |
| `handledBy` | string | 是 | 平台超管 id |
| `handledAt` | number | 是 | |

### 3.20 skill（派生，不落业务库）

技能市场（#50）从 DSH 插件清单读取。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `skl_zhiban-wecom` |
| `name` | string | 否 | |
| `description` | string | 否 | |
| `version` | string | 否 | 插件版本 |
| `status` | enum | 否 | `enabled` / `coming_soon` |
| `pluginId` | string | 是 | DSH 插件包名；`coming_soon` 为空 |
| `capabilities` | array<string> | 否 | 如 `["draft","verify"]` |
| `tier` | enum | 否 | `A` / `C` |

### 3.21 solution_pack（静态配置）

行业方案包（#50）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `spk_health-care` |
| `name` | string | 否 | |
| `description` | string | 否 | |
| `status` | enum | 否 | `enabled` / `coming_soon` |
| `skillIds` | array<string> | 否 | |
| `knowledgeCount` | number | 否 | |
| `ruleCount` | number | 否 | |
| `updatedAt` | number | 否 | |

### 3.22 B 档示例实体（只在前端 sample 层，不落后端库）

以下实体的数据只存在于 `console/src/sample/` 与 mock fixtures，接口返回时必须带 `sample: true`。

**health_profile**（患者主页「健康档案」Tab）

| 字段 | 类型 | 说明 |
|---|---|---|
| `patientId` | string | |
| `heightCm` | number | |
| `weightKg` | number | |
| `bmi` | number | |
| `bloodPressure` | string | 如 `128/82` |
| `conditions` | array<string> | |
| `medications` | array<string> | |
| `updatedAt` | number | |
| `sample` | boolean | 恒为 `true` |

**service_plan**（患者主页「服务计划」Tab）

| 字段 | 类型 | 说明 |
|---|---|---|
| `patientId` | string | |
| `planName` | string | |
| `startedAt` | number | |
| `endsAt` | number | |
| `goals` | array<string> | |
| `sessions` | array<object> | `[{ "at": 0, "title": "" }]` |
| `sample` | boolean | 恒为 `true` |

**script_template**（话术库）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | |
| `category` | string | |
| `title` | string | |
| `content` | string | |
| `tags` | array<string> | |
| `enabled` | boolean | |
| `sample` | boolean | 恒为 `true` |

---

## 4. 状态机

### 4.1 draft.status（沿用 C2）

```text
QUEUED ──推送成功──> PUSHED ──顾问点「已发送」──> ACKNOWLEDGED ──回读匹配──> VERIFIED
  │                    │                              │
  │                    ├──顾问点「忽略」──────────────> SKIPPED
  │                    ├──回读匹配到别的群────────────> MISROUTE_ALERT
  │                    └──超过回读次数───────────────> UNVERIFIED
  ├──推送失败（重试耗尽）──> FAILED ──> DEAD_LETTER
  └──管理员释放队列──> RELEASED（当前草稿终结，推下一条）
```

| 值 | 中文 | 备注 |
|---|---|---|
| `QUEUED` | 排队中 | |
| `PUSHED` | 已推送，待顾问处理 | |
| `FAILED` | 推送失败，等待重试 | |
| `ACKNOWLEDGED` | 顾问已点发送，等待回读核验 | |
| `SKIPPED` | 顾问已忽略 | |
| `VERIFIED` | ✅ 已核验 | 与 `sentVersion` 共同判断原样/改稿后采纳 |
| `EDIT_SENT` | ✏️ 改后发送 | |
| `MISROUTE_ALERT` | ⚠️ 发错群 | |
| `UNVERIFIED` | ❌ 未核验 | |
| `DEAD_LETTER` | 死信 | 需人工处理 |
| `RELEASED` | 已释放队列 | P1 新增，仅由管理员操作产生 |

### 4.2 group.status

`pending → serving ⇄ collect_only / disabled`；任何状态可回到 `pending`（重新确认）。

`group.status` 同时决定该群是否进入存档拉取白名单（#106）：`serving` / `collect_only` 拉取，
`pending` / `disabled` 不拉取。白名单由 `zhiban-wecom` 的 `ServiceGroupRegistry` 维护并持久化在
`zhiban_wecom` 域元数据 `service_roster`（不是业务库表）：

```json
{
  "version": 1,
  "allowed": ["wr..."],
  "denied": ["wr..."],
  "known": { "wr...": { "state": "candidate|active|inactive", "updatedAt": 1762645800000 } },
  "updatedAt": 1762645800000
}
```

- 白名单 = profile `serviceGroupRoomIds`（种子）∪ `allowed` − `denied`；`denied` 优先于种子，
  保证管理员移出的群重启后不会被重新加入。
- `known` 记录已发现群的来源状态；`candidate` 只出现在控制台，不拉取消息。
- 客户群发现每轮用 `externalcontact/groupchat/list` 得到企微侧群列表，与 `known` 比对后
  只登记未知群。快照损坏或版本不符时按种子重建，不阻塞启动。

### 4.3 care_plan.status

`pending → done`（到点触发后）或 `pending → cancelled`（顾问取消）；`done` 不可回退。

### 4.4 alert.status

`open → acknowledged → resolved`。`resolved` 后不可重开，同一事件再次发生会产生新告警。

### 4.5 account.status

`active ⇄ disabled`；`disabled` 保留审计与历史归属。

---

## 5. 派生字段与统计口径

以下字段不落库，由查询时计算：

| 字段 | 计算 |
|---|---|
| `advisor.online` | 机器人长连接中该顾问最近 15 分钟有活动 |
| `advisor.queueDepth` | 该顾问 `QUEUED` + `PUSHED` 草稿数 |
| `patient.memoryCount` | 该患者 `deletedAt=null` 且 `sandbox=false` 的记忆数 |
| `patient.pendingPlanCount` | 该患者 `status=pending` 的计划数 |
| `patient.groupIds` | `group_binding` 中未删除记录 |
| `group.patientIds` | 同上 |
| `draft.sentVersion` | 对应 `delivery.version` |
| `duration.*` | 各节点时间差（见 API 服务流详情） |

统计口径（#58）：

- **已发出** = `VERIFIED` + `EDIT_SENT`（不含 `MISROUTE_ALERT` / `UNVERIFIED`）。
- **原样采纳** = `VERIFIED` 且 `sentVersion = 1`。
- **改稿后采纳** = `VERIFIED` 且 `sentVersion > 1`。
- **人工改写** = `EDIT_SENT`。
- **AI 采纳率** =（原样采纳 + 改稿后采纳）/ 已发出。
- **估算节省时长** =（原样采纳 + 改稿后采纳）× `writeMinutesPerDraft`。
- 所有统计排除 `sandbox=true`；`demo=true` **计入**。

---

## 6. C2 → P1 字段映射

| C2 | P1 | 处理 |
|---|---|---|
| `Advisor.id` | `advisor.id` | 同值 |
| `Advisor.name` | `advisor.name` | 同值 |
| `Advisor.chatId` | 不对外 | 转为 `advisor.chatBound` |
| `Advisor.status` | `advisor.status` | 同值（active/paused/left） |
| `Advisor.consecutiveMisroutes` | `advisor.consecutiveMisroutes` | 同值 |
| `Advisor.noChatIdAlerted` | 不对外 | 转为 `alert.kind=no_chat_id` |
| `CustomerGroup.roomId` | `group.roomId` | 同值 |
| `CustomerGroup.chatId` | `group.chatId` | 同值 |
| `CustomerGroup.name` | `group.name` | 同值 |
| `CustomerGroup.advisorId` | `group.advisorId` | 同值 |
| `CustomerGroup.status` | `group.status` | `mapped→serving`、`unassigned→pending`、`disabled→disabled` |
| `Draft.id` | `draft.id` | 同值 |
| `Draft.advisorId` | `draft.advisorId` | 同值 |
| `Draft.groupRoomId` | `draft.groupRoomId` | 同值；另存 `groupId` |
| `Draft.groupName` / `groupNameSource` / `groupMembers` | `draft.groupName` / `groupNameSource` | `groupMembers` 不再随草稿保存，从 `group_member` 读 |
| `Draft.customerId` | `draft.externalUserId` | 客户 `wm` id |
| `Draft.customerName` | `draft` 不存 | 从 `patient.displayName` 读 |
| `Draft.inboundMessageId` | `draft.inboundMessageIds[0]` | 合并窗口后为数组 |
| `Draft.body` | `draft.body` + `revisions[last]` | |
| `Draft.status` | `draft.status` | 同值；新增 `RELEASED` |
| `Draft.verification` | `verification` 实体 | `outcome` 由 `VERIFIED/EDIT_SENT/MISROUTE_ALERT/UNVERIFIED` 转为 `verified/edit_sent/misroute/unverified` |
| `Alert.kind` | `alert.kind` | 见 §3.16 |
| `Alert.at` | `alert.createdAt` | 改名 |
| `AuditEvent.at` | `audit_event.at` | 同值 |
| `AuditEvent.actor` | `audit_event.actorName` | 改名 |
| `AuditEvent.target` | `audit_event.targetId` | 改名 |

**不改的东西**：`C2Service`、`SerialQueue`、`Verifier`、`ArchiveTrigger` 的逻辑与状态枚举不变；映射发生在插件边界，不污染核心。

---

## 7. 存储约定

- 使用 DSH `storage-sqlite`；表名 snake_case 复数：`tenants`、`accounts`、`advisors`、`groups`、`group_members`、`group_bindings`、`patients`、`memories`、`care_plans`、`meal_logs`、`knowledge`、`risk_rules`、`drafts`、`draft_revisions`、`deliveries`、`verifications`、`alerts`、`audit_events`、`agent_actions`、`onboarding_requests`。
- 列名 snake_case；JSON 数组/对象存 `TEXT`（JSON 字符串），读时解析。
- 所有业务表带 `tenant_id`，且为联合索引首列。
- 建议索引：

```sql
CREATE INDEX idx_patients_tenant_deleted ON patients(tenant_id, deleted_at);
CREATE INDEX idx_memories_patient_cat ON memories(tenant_id, patient_id, category, deleted_at);
CREATE INDEX idx_drafts_tenant_created ON drafts(tenant_id, created_at DESC);
CREATE INDEX idx_drafts_tenant_status ON drafts(tenant_id, status);
CREATE INDEX idx_drafts_advisor_status ON drafts(tenant_id, advisor_id, status);
CREATE INDEX idx_drafts_group ON drafts(tenant_id, group_id, created_at DESC);
CREATE INDEX idx_deliveries_draft ON deliveries(draft_id);
CREATE INDEX idx_verifications_draft ON verifications(draft_id);
CREATE INDEX idx_alerts_tenant_status ON alerts(tenant_id, status, created_at DESC);
CREATE INDEX idx_audit_tenant_at ON audit_events(tenant_id, at DESC);
CREATE UNIQUE INDEX uq_group_binding
  ON group_bindings(tenant_id, group_id, patient_id)
  WHERE deleted_at IS NULL;
```

- 数据保留：P1 **不做自动删除**；`tenant.settings.retentionNotice` 必须如实描述这一点。
- 媒体文件不进数据库：`DSH_HOME/zhiban/media/<roomId>/<msgId>.<ext>`（#54）；库中只存 `mediaId` 与元数据。

---

## 8. 隐私与安全

- 任何实体都**不存**企微 Secret、机器人 Token、模型 API Key；只有 `advisor.wecomUserId`、`group.roomId` 这类业务标识。
- 日志与 `audit_event.detail` 不出现消息正文（#31）；正文只存在 `draft`、`delivery`、`memory.sourceText`、`meal_log` 等业务实体中，通过鉴权接口读取。
- `patient.externalUserId`、`group.roomId` 属于个人/会话标识，只在登录后的接口返回，不出现在任何公开页面或静态资源。
- 导出 PDF 必须写 `audit_event(action=evidence.export)`。

---

## 9. 与各 issue 的对齐

| 实体 | 主责 issue | 本文补充 |
|---|---|---|
| tenant / account / audit | #41、#51 | `settings` 字段、`platform` 角色、`detail` 结构 |
| advisor | #33、#39、#46 | `chatBound`、`online`、`queueDepth`、`seatExpireAt` |
| group / group_member / group_binding | #33、#46、#63 | `collect_only`、`consent`、角色标注、多对多绑定 |
| patient | #33、#45 | `demo`、`externalUserId`、派生计数 |
| memory | #35 | `subject`、`deletedBy`、`sandbox` |
| care_plan | #36 | `quietHoursShifted`、`lastFiredAt` |
| meal_log | #55 | `mediaId` / `photoUrl` / `confidence` |
| knowledge / risk_rule | #37、#38、#48 | `builtin`、`action`、`hitCount` |
| draft / delivery / verification | #32、#34、#56 | `revisions`、`sentVersion`、`mediaIds`、`source` |
| alert | #39、#47 | `severity`、`status`、`note`、`escalatedTo` |
| agent_action | #34、#45 | 办事记录实体 |
| onboarding_request | #61 | 全字段 |
| skill / solution_pack | #50 | 派生/静态 |

**已发现并统一的差异**（各 issue 实现时按本文）：

1. #33 的 group 状态 `pending/serving/collect_only/disabled` 与 C2 `mapped/unassigned/disabled` 不一致 → 采用本文四值，映射见 §6。
2. #39 的告警类型用小写短名，C2 用大写常量 → 采用本文 `kind` 枚举，映射见 §3.16。
3. #34 的 `reply_draft({ body, inboundSummary, riskLevel, citedMemoryIds, citedKnowledgeIds })` 没有版本号 → 版本由 `zhiban-wecom` 在入队时维护，Agent 不传。
4. #35 的记忆分类是中文名 → 存储用枚举，界面用中文标签（§3.8）。
5. #58 的「已发出」口径 → 明确定义为 `VERIFIED + EDIT_SENT`（§5）。

---

## 10. 变更流程

1. **只做新增**：加字段、加枚举值、加接口，不删改已有字段和语义。新增字段必须可空或有默认值。
2. 删改字段、改枚举语义、改统计口径：先在 #62 下评论说明原因与影响面，项目负责人确认后同时更新本文件与 [P1-api.md](./P1-api.md)。
3. 任何契约变更的 PR 必须在描述里单列「契约变更」一节，并更新 fixtures。
4. 文档版本号递增；breaking change 需要新开版本路径（`/zhiban/api/v2`），P1 不预期发生。
