# 知伴健康患者端 H5 · 数据模型契约

> 版本：**v0.1**（2026-11-25，草案）· 归属：PH5-01（#230）
> 依据：[患者端 H5 PRD v0.1](./PATIENT-H5-PRD.md) §5、§7、§8、§11、§13 · [产品顶层定义](./PRODUCT-FOUNDATION.md)
> 配套：[PATIENT-H5-api.md](./PATIENT-H5-api.md)（接口契约）
> 状态：**草案**。范围闸门（#229）与「已审核内容 H5 发布规则」冻结前可并行评审；冻结后按结论定稿，定稿前实施 issue 只能以虚构数据开发。
>
> 本文是患者端 H5 新增数据模型的**唯一依据**。与 [P1-data-model.md](./P1-data-model.md) 的关系：**只新增、不改旧**——现有实体（patient、care_plan、meal_log、memory、draft 等）字段与语义一律不变；本文实体全部是新表、新前缀。需要删改旧字段的事项按 P1-data-model §10 / DEV-GUIDE §4.3 流程登记，等项目负责人决定。
> 契约示例数据全部虚构；`service-plan`（B 档示例）不得当作真实已发布计划。

---

## 0. 一句话

患者端 H5 的数据围绕：**既有 patient 主键 → H5 绑定与分项授权（h5_binding / patient_consent）→ 版本化健康方案（health_plan）→ 执行与反馈（calendar_item / patient_record）→ 团队跟进（followup_request）→ 文化内容（content_article）→ 提醒投递（reminder_task）**。全部实体带 `tenantId`；患者身份与员工身份完全隔离；每个对外行为都能落到 `h5_audit`。

## 0.1 与现有模型的边界（先读）

| 现有实体 | 含义保持 | 患者端 H5 的对应物 | 关系 |
|---|---|---|---|
| `patient` | 机构服务对象，主键 `pat_` | **直接复用**，不新建档案 | H5 绑定后所有新实体挂同一 `patientId` |
| `patient.consent` | 企微**会话存档**同意（三值枚举） | `patient_consent`（分项授权） | **两件事分别记录**：不同意存档不能推定为不同意 H5，反之亦然 |
| `care_plan` | 顾问配置的**一次性/周期主动提醒** | `health_plan`（完整健康方案） | care_plan 不迁移、不重写；它是「提醒」不是「方案」 |
| `meal_log` | 群消息餐照识别记录 | `patient_record`（kind=meal） | 同日同餐**两来源并存**，不覆盖不合并；疑似重复交团队确认 |
| `memory` | Agent 抽取的长期记忆 | `patient_profile_entry`（结构化建档条目） | 自由文本记忆与结构化档案互补；未确认的 AI 提取不覆盖专业确认字段 |
| `knowledge` | 团队内部知识（注入提示词） | `content_article`（患者可见文化内容） | knowledge 不对患者暴露；文章走独立审核发布 |
| `draft` / `delivery` / `verification` | 顾问审核发送与核验链路 | `reminder_task` 引用之 | H5 提醒触达复用该链路，不新建送达体系 |
| `audit_event` | 控制台审计 | `h5_audit`（同构，患者域独立表） | 两张审计表各自追加，互不改写 |

**示例与真实**：现有 `GET /patients/{id}/service-plan` 返回的 `sample: true` B 档示例继续仅作控制台演示；H5 端一律读 `health_plan`，任何接口不得把示例数据当作已发布方案返回。

## 0.2 新增 ID 前缀

| 前缀 | 实体 | 示例 |
|---|---|---|
| `hbd_` | h5_binding | `hbd_01j...` |
| `pinv_` | patient_invitation | `pinv_01j...` |
| `phs_` | patient_h5_session | `phs_01j...` |
| `pcon_` | patient_consent | `pcon_01j...` |
| `ppe_` | patient_profile_entry | `ppe_01j...` |
| `hpl_` | health_plan（一个版本一条） | `hpl_01j...` |
| `cal_` | calendar_item | `cal_01j...` |
| `rec_` | patient_record | `rec_01j...` |
| `fup_` | followup_request | `fup_01j...` |
| `art_` | content_article | `art_01j...` |
| `rmd_` | reminder_task | `rmd_01j...` |
| `prq_` | privacy_request | `prq_01j...` |
| `idm_` | idempotency_record | `idm_01j...` |

其余约定（`xxxId` 命名、ULID、snake_case 存储列名、lower_snake_case 枚举）**全部沿用 P1-data-model §1**。

---

## 1. 通用约定（继承 + 新增）

### 1.1 继承 P1 的约定

多租户（`tenantId` 由服务端会话推导）、`sandbox` / `demo` 双标记语义、软删除（`deletedAt`）、分页（`page`/`pageSize`/`items`）、数组恒返回 `[]`、可空字段按 null 处理——见 [P1-data-model.md](./P1-data-model.md) §1。患者端 H5 新增实体同样遵守。

### 1.2 时间与本地日期（新增）

- 时间戳字段仍为**毫级 Unix UTC 整数**，字段名以 `At` 结尾。
- **新增日期语义字段**：字段名以 `Date` 结尾，类型 `YYYY-MM-DD` 字符串，表示**本地日期**（Asia/Shanghai）。用于：记录发生日、频控日、日历切日、回顾日。P1-data-model §1.2 预留了该约定，本文开始启用。
- 本地日期一律按 **`Asia/Shanghai`** 计算（PRD §8.2）。是否改随 `tenant.timezone` 是待决项（见 §12），v1 固定 Asia/Shanghai。
- 「发生时间」与「提交时间」是两个事实：`occurredAt`（患者选择的发生时刻，可补记历史）与 `submittedAt`（服务端落库时刻，不可伪造）。**禁止**用 `submittedAt` 推断「行动发生」。

### 1.3 来源记录（新增）

凡记录类实体（profile_entry、patient_record、calendar_item 反馈、followup、reminder）必须携带来源三元组：

| 字段 | 取值 | 说明 |
|---|---|---|
| `source` | `patient` / `advisor` / `agent` / `system` | 谁产生 |
| `sourceRef` | string，可空 | 来源外键：`wm` msgid（群消息）、`rec_`（记录）、`cal_`（事项）等 |
| `submittedBy` | string，可空 | 患者会话 id / 账号 id；system 事件为空 |

**规则**：家属或顾问转述的内容不得自动归入患者本人事实（沿用 P1 #63 原则）；AI 提取结果（`source=agent`）未经确认不覆盖患者自述或专业确认字段。

### 1.4 幂等（新增）

- 患者写接口（记录、反馈、授权决定、建档提交）带 `Idempotency-Key`（请求头），服务端保存 `idm_` 记录：`{ key, patientId, endpoint, requestId, responseSnapshot, at }`，**24 小时**内同 key 重复提交返回首次响应。重放超出窗口按新请求处理（记录层仍有业务去重，见 §3.8）。
- 邀请兑换天然单次：状态机保证（§4.1）。
- 团队端沿用控制台幂等约定（P1-api §1.8）。

### 1.5 隐私红线（新增，验收依据）

- 手机号只存 `h5_binding.phone` 与 `patient_invitation.phone`，**不进日志、不进 h5_audit、不进埋点**；展示一律 `phoneTail`（后 4 位）。
- 业务日志与埋点不含健康正文、照片内容、会话令牌；审计 `detail` 只含操作主体、对象 id、版本与结果。
- 照片元数据：入库前剥离 EXIF GPS；存储路径不对外暴露，读取走鉴权接口（§3.9 / api §8）。
- 页面标题与分享预览不含姓名、病史、健康数值（PRD §13）。

---

## 2. 实体关系

```text
patient（现有，复用主键）
  ├─< h5_binding（0..1）─< patient_h5_session（1..n，可撤销）
  │        └─< patient_invitation（由顾问创建，兑换后绑定）
  ├─< patient_consent（分项，多 scope，带版本与撤回时间）
  ├─< patient_profile_entry（结构化建档，区分来源与确认状态）
  ├─< health_plan（版本链：v1 → v2 → …，同一时刻至多一个 published）
  │        ├─< calendar_item（由该版本行动定义生成）
  │        │        └─< patient_record（关联，可选）＋ reminder_task（0..n）
  │        └─（发布/暂停事件）→ h5_audit
  ├─< patient_record（meal / evening_review / note；独立于日历也存在）
  ├─< followup_request（留言、需要帮助、调整申请、纠错、风险升级）
  ├─< privacy_request（导出 / 纠错 / 删除申请）
  └─< reminder_task（投递状态与证据，引用现有 draft/delivery 链）

content_article（租户级，与患者无外键；经引用关联到计划/日历提示）
```

---

## 3. 实体定义

> 类型标注同 P1-data-model §3。「可空=是」的字段响应中可能为 `null`。

### 3.1 h5_binding —— 患者与 H5 的绑定关系

一位患者至多一条有效绑定。绑定后患者可用手机号验证码重新登录（待决项 §12.1）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `hbd_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | 复用现有 `pat_` 主键 |
| `phone` | string | 否 | 绑定手机号；只用于核验，不出任何接口响应/日志 |
| `phoneTail` | string | 否 | 展示用后 4 位 |
| `status` | enum | 否 | `bound` / `unbound`（解绑后不可手机号登录，保留历史） |
| `boundAt` | number | 否 | 首次兑换成功时间 |
| `boundVia` | string | 否 | 首次兑换所用 `pinv_` id |
| `unboundAt` | number | 是 | 解绑时间（隐私申请处理或团队操作） |
| `unboundBy` | string | 是 | 处理账号 id |

- 解绑不删数据：历史记录与审计保留；新邀请可再次绑定（复用同一 patientId，不新建档案）。
- `patient.consent`（存档同意）与 h5_binding 状态**互不推断**。

### 3.2 patient_invitation —— 短时单次邀请

由负责顾问在控制台创建，经现有服务会话或二维码送达患者。邀请只代表**进入资格**。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `pinv_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | 目标患者（必须已存在且 `status=serving`） |
| `advisorId` | string | 否 | 创建邀请的负责顾问 |
| `phone` | string | 否 | 预绑定手机号（核验用，不回显） |
| `phoneTail` | string | 否 | 展示用 |
| `code` | string | 否 | 一次性邀请码（opaque，≥128bit 随机），仅出现在链接中 |
| `status` | enum | 否 | `pending` / `used` / `expired` / `revoked` |
| `expiresAt` | number | 否 | 短时过期；默认 24h，可配置 `invitation.ttlMs` |
| `usedAt` | number | 是 | 兑换成功时间 |
| `usedSessionId` | string | 是 | 兑换签发的 `phs_` |
| `revokedAt` | number | 是 | |
| `revokedBy` | string | 是 | 账号 id |
| `note` | string | 是 | 团队备注（如「出院后第二次邀请」） |
| `createdAt` | number | 否 | |
| `updatedAt` | number | 否 | |

- **单次**：`pending → used` 后任何重放返回同一终态错误，不二次签发会话。
- 无服务权限（患者 `status != serving`、租户停用）时兑换失败，状态不变，错误码见 api §1.6。

### 3.3 patient_h5_session —— 患者会话（与员工会话隔离）

不复用控制台 Cookie、不复用侧边栏令牌。服务端存令牌哈希。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `phs_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `tokenHash` | string | 否 | Cookie 令牌的 SHA-256；令牌本体不落库 |
| `authMethod` | enum | 否 | `invite_sms`（首次兑换）/ `phone_sms`（再次登录） |
| `status` | enum | 否 | `active` / `revoked` / `expired` |
| `issuedAt` | number | 否 | |
| `expiresAt` | number | 否 | 绝对有效期，默认 7 天（`session.absoluteTtlMs`） |
| `lastSeenAt` | number | 否 | 滑动续期基准；空闲超过 `session.idleTtlMs`（默认 24h）即过期 |
| `revokedAt` | number | 是 | 撤销时间 |
| `revokedBy` | enum | 是 | `patient`（本人退出）/ `account`（团队）/ `system`（授权撤回、解绑、服务停止） |
| `revokedById` | string | 是 | account 时为账号 id |
| `userAgentSummary` | string | 是 | 设备大类（如 `iOS/WeChat`），不含完整 UA 串，用于异常登录提示 |

- 撤销即时生效：进行中的写请求按 401 终止；照片鉴权读取同步失效。
- Cookie 名 `zb_h5_session`，HttpOnly、Secure、SameSite=Lax。

### 3.4 patient_consent —— 分项授权

授权范围拆成独立 scope，每个 scope 单独授予/撤回，保留版本与时间。**与企微存档同意（patient.consent）分开记录。**

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `pcon_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `scope` | enum | 否 | 见下表 |
| `status` | enum | 否 | `granted` / `withdrawn` / `never`（从未授予） |
| `version` | number | 否 | 授权文案版本；文案由租户配置，版本号只增 |
| `grantedAt` | number | 是 | 最近一次授予时间 |
| `withdrawnAt` | number | 是 | 最近一次撤回时间 |
| `decidedVia` | string | 是 | 决定发生的会话 `phs_` |
| `history` | array<object> | 否 | `[{ action, at, version, via }]`，只追加 |
| `updatedAt` | number | 否 | |

scope 枚举：

| scope | 控制什么 | 撤回的即时效果（取消传播表 §5 的行键） |
|---|---|---|
| `health_processing` | 授权 AI 处理本人健康信息（生成计划、整理记录） | 停止生成/识别任务；进行中的中止；已发布内容保持只读 |
| `photo_analysis` | 餐食照片 AI 识别 | 识别不再排队；已保存候选与照片保留 |
| `team_access` | 专业团队在控制台查看本人记录与反馈 | 团队侧正文不再展示（保留计数与审计）；处理中的隐私/跟进请求仍可见摘要 |
| `reminder` | 提醒触达 | 未发出的 reminder_task 全部取消；已发出的不改写历史 |
| `service_basic` | 进入 H5 个人服务（计划/日历/记录页面） | 会话撤销；仅公开内容可读 |

- 拒绝（`never` / `withdrawn`）时：可读公开内容（主张、已发布文章）；个人页面按 §5 规则收窄。
- 授权文案版本与快照存租户配置（`h5.consentTexts`，含每 scope 的说明文本），版本号引用进 `pcon.version`。

### 3.5 patient_profile_entry —— 轻量建档与档案条目

结构化键值条目，区分来源与确认状态。覆盖 H02 建档与 H09 档案纠错。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `ppe_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `fieldKey` | enum | 否 | 见下表 |
| `value` | object | 否 | 结构化取值（按 fieldKey 的 schema 校验） |
| `valueText` | string | 否 | 展示用一句话（如「每天 22:30 前入睡」） |
| `source` | enum | 否 | `patient`（自述）/ `advisor`（团队录入）/ `agent`（AI 提取，待确认）/ `professional`（专业确认） |
| `status` | enum | 否 | `draft` / `confirmed` / `disputed`（纠错申请中） |
| `confirmedBy` | string | 是 | professional/advisor 确认时的账号 id |
| `confirmedAt` | number | 是 | |
| `sourceRef` | string | 是 | 来源引用（`rec_`、`wm` msgid、`mem_`） |
| `updatedAt` | number | 否 | 值被真正修改的时间（触发修订历史） |
| `revisions` | array<object> | 否 | `[{ value, source, at, via }]`，旧值保留 |
| `sandbox` | boolean | 否 | |
| `deletedAt` | number | 是 | 软删除 |

fieldKey 枚举（v1）：

| fieldKey | value 结构（示例，虚构） | 用途 |
|---|---|---|
| `goal` | `{ "items": ["改善睡眠", "控油控盐"] }` | 希望改善的生活习惯 |
| `meal_times` | `{ "breakfast": "07:00", "lunch": "12:00", "dinner": "18:30" }` | 通常用餐时间 |
| `sleep_time` | `{ "bedtime": "22:30", "waketime": "06:30" }` | 作息 |
| `food_preference` | `{ "likes": ["清淡"], "dislikes": ["辛辣"] }` | 饮食偏好 |
| `allergy` | `{ "items": ["海鲜（自述）"], "unknown": false }` | 过敏禁忌——**安全关键** |
| `existing_guidance` | `{ "items": ["低盐饮食（门诊医嘱）"], "sourceNote": "门诊 2026-10" }` | 既有专业指导 |

**安全规则**（A03 验收依据）：
- `allergy` 与 `existing_guidance` 中 `source=agent` 的条目**不得**自动覆盖 `source=patient/professional` 的既有值，只能并列待确认。
- 关键安全信息缺失（无 allergy 条目且未回答）或冲突（自述与专业确认矛盾）时，计划生成被阻塞（§4.2 `data_pending`），转团队补充询问；**不生成可执行的个性化建议**。
- 「不清楚」是合法取值（`unknown: true`），不等同于「无过敏」。

### 3.6 health_plan —— 版本化健康方案

**一个版本一条记录**；`patientId + version` 唯一。同一患者至多一个 `published`（发布门禁，A04/A05 验收依据）。周期由内容决定，不固定 28 天。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `hpl_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `version` | number | 否 | 从 1 递增 |
| `status` | enum | 否 | 见 §4.2 状态机 |
| `stageGoal` | string | 否 | 阶段目标（患者可读语言，≤200 字） |
| `startDate` / `endDate` | string | 否 | 本地日期 `YYYY-MM-DD`；有效区间 |
| `foodTherapyRationale` | string | 否 | 食养思路（患者可读，随审核一并过） |
| `focusPoints` | array<string> | 否 | 本阶段重点（3–6 条） |
| `actions` | array<object> | 否 | 行动定义，见下 |
| `feedbackRequirements` | array<string> | 否 | 需要患者反馈的内容（如「每晚回顾睡眠」） |
| `inputSnapshot` | object | 否 | 生成时的输入快照：profile 条目 id 集合、记忆 id 集合、慢病档案摘要、授权 scope 版本；**不含自由正文** |
| `ruleRefs` | array<object> | 否 | 引用的已启用规则/知识/内容：`[{ refType, refId, refVersion }]` |
| `generation` | object | 否 | `{ model, promptVersion, startedAt, finishedAt, attempts }`；`source` 恒为 `agent` 或 `manual`（团队手写） |
| `review` | object | 是 | 最近审核记录，见下 |
| `reviewHistory` | array<object> | 否 | 全部审核动作，只追加 |
| `effectiveFrom` / `effectiveTo` | number | 是 | 发布生效/失效时刻（毫秒）；superseded 时 `effectiveTo` = 新版 `effectiveFrom` |
| `acknowledgedAt` | number | 是 | 患者「已了解计划」时间（不替代专业审核） |
| `adjustRequestIds` | array<string> | 否 | 派生：指向本版本的调整申请 `fup_` |
| `createdAt` / `updatedAt` | number | 否 | |
| `sandbox` | boolean | 否 | |

`actions[]`（行动定义，日历由它展开）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `actionId` | string | 版本内稳定 id（`act_<n>`）；换版本可对齐 `carriedFromActionId` |
| `title` | string | 行动名（如「晚餐清淡少油」） |
| `purpose` | string | 简短目的（患者可读） |
| `method` | string | 执行方式说明 |
| `schedule` | object | `{ kind: "daily" \| "weekly" \| "oneoff", time: "18:30", weekdays?: [1..7], dates?: ["YYYY-MM-DD"] }` |
| `feedbackKind` | enum | `none` / `checkin`（打卡型）/ `record_meal`（关联餐食记录）/ `record_review`（关联晚间回顾） |
| `linkedArticleIds` | array<string> | 相关食养内容（已发布版本） |

`review`（审核记录）：

| 字段 | 说明 |
|---|---|
| `status` | `pending` / `approved` / `rejected` / `returned`（退回修改） |
| `reviewerAccountId` | 账号 id——**必须具备 `h5.plan_review` 能力**，见 §6 |
| `reviewerName` | 展示名 |
| `reviewedAt` | |
| `note` | 审核意见（≤500 字，不含患者正文） |
| `editedByReviewer` | boolean，审核人是否直接编辑过草稿 |

**发布门禁**：`publish` 仅在 `review.status=approved` 且该患者无其他 `published` 版本时成功；并发双发布只有一条成功，另一条 `409 PLAN_VERSION_CONFLICT`（A05）。
**AI 失败**：`generate_failed` 保留 `inputSnapshot` 与资料，页面显示「正在为你准备计划」，团队可人工接管（`source=manual` 新草稿）；**不得**把通用模板伪装成个性化计划（A03）。

### 3.7 calendar_item —— 日历事项

由 `health_plan` 的 `actions` 按本地日期展开成具体事项。**日历与计划同版本**：事项记录其 `planId`+`planVersion`，不维护第二份方案（A04）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `cal_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `planId` | string | 否 | 生成它的 `hpl_` |
| `planVersion` | number | 否 | |
| `actionId` | string | 否 | 版本内行动 id |
| `scheduledDate` | string | 否 | 本地日期 `YYYY-MM-DD` |
| `scheduledAt` | number | 否 | 发生时刻（含当日时间） |
| `title` / `purpose` / `method` | string | 否 | 从行动定义复制（换版本后旧事项文字不改写） |
| `feedbackKind` | enum | 否 | 同 actions.feedbackKind |
| `linkedArticleIds` | array<string> | 否 | 相关内容（读时校验发布状态，停用不展示正文） |
| `status` | enum | 否 | 见 §4.3 |
| `statusUpdatedAt` | number | 是 | 最近状态变更 |
| `feedback` | object | 是 | 见下；null = 未反馈 |
| `overdue` | boolean | 否 | **读时派生**：`scheduledDate < 今天` 且 status=pending；不落库、不改状态 |
| `cancelReason` | enum | 是 | `plan_superseded` / `plan_suspended` / `plan_ended` / `team_cancelled` / `service_stopped` |
| `cancelledAt` | number | 是 | |
| `createdAt` | number | 否 | |

`feedback`（患者反馈，或记录满足条件时系统回填）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | enum | `patient_confirmed`（明确确认）/ `record_matched`（关联记录满足要求，系统回填）/ `missed`（今天没做到）/ `needs_help`（需要帮助） |
| `reason` | string | 可空，missed/needs_help 时患者可补充原因（≤200 字） |
| `occurredAt` | number | 可空，补记时的执行时间 |
| `submittedAt` | number | 提交时间；与 occurredAt 分开（A06） |
| `recordIds` | array<string> | 关联的 `rec_` |
| `followupId` | string | needs_help 生成的 `fup_` |
| `revisedAt` / `revisions` | — | 更正保留历史（同 P1 memory 模式） |

**完成判定**（进度口径，A06 验收依据）：
- `done` = 患者明确确认，**或** 关联记录满足 `feedbackKind` 要求（`record_meal`：当日同餐有已保存记录；`record_review`：当日有回顾）→ 系统回填 `record_matched`。
- **禁止提前完成**：`scheduledDate > 今天` 的反馈请求被拒绝（`ITEM_NOT_MODIFIABLE`）。
- 查看、提醒已发出、页面访问**不构成**完成。
- 「到期未反馈」= `overdue` 派生标记（待跟进），**不**自动写成「未执行」。
- 进度只统计当天**已发布计划**的行动；自由记录不进分母。

### 3.8 patient_record —— 患者记录（餐食 / 晚间回顾 / 随手记）

H5 端记录的统一实体。与 `meal_log`（群消息识别）**并存不合并**。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `rec_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `kind` | enum | 否 | `meal` / `evening_review` / `note` |
| `occurredAt` | number | 否 | 发生时刻（患者选择，可补记历史） |
| `occurredDate` | string | 否 | 发生本地日期（冗余，查询键） |
| `submittedAt` | number | 否 | 服务端落库时刻 |
| `source` | enum | 否 | `patient`（H5 提交）/ `group_archive`（群消息整理，`sourceRef`=msgid） |
| `sourceRef` | string | 是 | |
| `idempotencyKey` | string | 是 | 客户端 `Idempotency-Key`；服务端唯一约束（patientId+key） |
| `content` | object | 否 | 按 kind 见下 |
| `recognition` | object | 是 | 照片识别子对象，见下 |
| `mediaIds` | array<string> | 否 | 关联照片（≤1 张，H06） |
| `linkedCalendarItemIds` | array<string> | 否 | 关联事项 |
| `duplication` | object | 否 | `{ suspectedIds: [], status: "none" \| "suspected" \| "distinct_confirmed" }`；与同日同餐 meal_log/record 的疑似重复 |
| `revisions` | array<object> | 否 | 更正历史 `[{ content, at, via, note }]`，只追加 |
| `teamNote` | string | 是 | 团队备注（不含患者正文） |
| `status` | enum | 否 | `active` / `corrected`（有更正历史时的展示态，读时派生亦可） |
| `sandbox` | boolean | 否 | |
| `createdAt` | number | 否 | |

`content`（kind=meal）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `mealType` | enum | `breakfast` / `lunch` / `dinner` / `snack` |
| `aiCandidates` | array<object> | 识别候选：`[{ name, confidence }]`；**未确认候选不当作事实** |
| `confirmedFoods` | array<object> | 患者确认/手填：`[{ name, portion }]`；`portion` 取枚举 `少/适中/多` 或自由文本 |
| `patientNotes` | string | 感受补充（≤200 字） |

`content`（kind=evening_review）——**不预选正常**，每项可跳过（A08）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `overall` | enum | `good` / `fair` / `tired` / `uncomfortable`，可空 |
| `mood` | enum | `calm` / `happy` / `low` / `anxious`，可空 |
| `sleep` | enum | `good` / `light` / `poor` / `insomnia`，可空 |
| `bowel` | enum | `normal` / `loose` / `constipated` / `other`，可空 |
| `discomfort` | string | 不适描述（≤200 字）；命中风险规则时生成 `fup_`（kind=risk） |
| `notes` | string | 自由补充 |

`recognition`（photo_analysis 专用）：

| 字段 | 说明 |
|---|---|
| `status` | `pending` / `succeeded` / `failed` / `timeout` / `skipped`（无图/授权撤回/手工保存） |
| `candidates` | 识别结果（复制进 content.aiCandidates） |
| `startedAt` / `finishedAt` | |
| `errorCode` | `UPSTREAM_UNAVAILABLE` 等 |

**识别失败降级**（A07）：`failed/timeout/skipped` 时记录仍已保存（手工填写的 confirmedFoods 生效）；不阻塞、不假报成功。**不输出**未经确认的精确热量/营养素/诊疗建议。

**同日同餐不合并**（PRD §11）：H5 `rec_` 与群 `meal_` 同日同餐并存；读时服务端按 `patientId + mealType + occurredDate` 标记 `duplication.status=suspected`，由团队在控制台确认 `distinct_confirmed`（两条都真实）或发起合并核对；**不自动覆盖**。

### 3.9 h5_media —— 患者照片（元数据）

文件存磁盘（路径不对外），元数据入库。读取仅限本人会话或团队 `patient.read`（photo_analysis 撤回后仍可读原图，识别停止——见 §5）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `med_` 沿用现有前缀，存于患者 H5 域 |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `recordId` | string | 是 | 所属 `rec_` |
| `mimeType` | string | 否 | 仅 `image/jpeg` / `image/png` / `image/webp` |
| `bytes` | number | 否 | ≤ 10MB；服务端压缩后重算 |
| `sha256` | string | 否 | 完整性校验 |
| `exifStripped` | boolean | 否 | 入库剥离 GPS/拍摄设备元数据后恒 `true` |
| `createdAt` | number | 否 | |
| `deletedAt` | number | 是 | 删除申请处理后软删 |

- 读取走 `GET /zhiban/h5/media/{id}`（本人）与控制台媒体接口（团队），`Cache-Control: private, max-age=300`；**不得**存为公开静态资源。

### 3.10 followup_request —— 跟进请求（团队任务）

患者留言、需要帮助、调整申请、纠错、风险事件统一进入跟进队列（PRD §6 H10、§10）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `fup_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `kind` | enum | 否 | `question`（留言）/ `need_help`（日历反馈）/ `plan_adjust`（调整申请）/ `risk`（不适风险）/ `profile_correction`（纠错）/ `record_flag`（记录疑议） |
| `message` | string | 否 | 患者留言（≤500 字）；团队端可见 |
| `linkedPlanId` / `linkedCalendarItemId` / `linkedRecordId` | string | 是 | 关联对象（kind 决定必填项） |
| `planVersion` | number | 是 | 调整申请必须带版本 |
| `riskLevel` | enum | 否 | `low` / `medium` / `high`；risk 类按规则命中最高级 |
| `status` | enum | 否 | 见 §4.4 |
| `assigneeAccountId` | string | 是 | 认领账号 |
| `claimedAt` | number | 是 | 认领时间 = 首次人工响应（自动回执**不计**） |
| `resolvedAt` / `resolutionNote` | number / string | 是 | 处理结论（≤500 字） |
| `slaDueAt` | number | 否 | 按租户 `h5.followupSla`（kind 与风险分级决定）；超时未认领自动升级 |
| `escalatedAt` | number | 是 | 升级时间 |
| `escalatedTo` | string | 是 | 主管账号 id |
| `autoAckSentAt` | number | 是 | 系统自动回执时间——**不等于处理**（A11） |
| `closedByPatient` | boolean | 否 | 患者主动撤销时 true |
| `sandbox` | boolean | 否 | |
| `createdAt` / `updatedAt` | number | 否 | |

### 3.11 content_article —— 食养文化内容

患者可见的文化内容（PRD §9）。与 `knowledge` 完全分离：knowledge 注入 Agent 提示词，article 面向患者阅读。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `art_...` |
| `tenantId` | string | 否 | |
| `category` | enum | 否 | `classics_life`（经典与生活）/ `ingredients`（认识食材）/ `seasonal_living`（四时起居） |
| `title` | string | 否 | ≤60 字 |
| `summary` | string | 否 | ≤100 字 |
| `sections` | array<object> | 否 | 见下 |
| `authorType` | enum | 否 | `editor`（编辑主体）/ `professional`（专业人员署名） |
| `authorName` | string | 否 | 展示主体名（虚构示例：编辑部） |
| `citations` | array<object> | 否 | 出处：`[{ text, source, verified }]`——经典引用逐字核对（A09） |
| `scenarioTags` | array<string> | 否 | 适用场景标签（供计划/日历关联检索） |
| `seasonTerm` | string | 是 | 节气线索（如「霜降」）；**阅读线索，不据此自动统一安排** |
| `status` | enum | 否 | `draft` → `reviewing` → `published` → `retired`，见 §4.6 |
| `version` | number | 否 | 版本号；编辑产生新版本，引用方记录引用版本 |
| `reviewedBy` / `reviewedAt` | string / number | 是 | 审核账号与时间（须具备 `h5.content_review`） |
| `publishedAt` / `retiredAt` | number | 是 | |
| `ingredientSafety` | object | 是 | ingredients 类必填：`{ usage, conditions, cautions }`（日常食用方式、适用条件、注意事项） |
| `sandbox` | boolean | 否 | |
| `createdAt` / `updatedAt` | number | 否 | |
| `deletedAt` | number | 是 | |

`sections[]`（正文分节，区分署名口径——A09）：

| 字段 | 说明 |
|---|---|
| `kind` | `classic_quote`（经典原文，逐字）/ `plain_explanation`（白话解释）/ `modern_life`（生活中的理解）/ `practice`（实践建议）/ `brand_copy`（自拟文案） |
| `text` | 正文（classic_quote 必须逐字核对并带 citation 索引） |

**署名规则**：`plain_explanation` 与 `brand_copy` **不得**署名古籍；引用与解释在数据结构上分离，前端据此标注「原文 / 释义」。

**引用与下架**（A09）：计划/日历引用文章时记录 `{ articleId, version }`；`retired` 后列表与详情不再返回正文（前端显示「内容已更新」占位），旧计划引用可追溯版本但不继续展示停用正文。

### 3.12 reminder_task —— 提醒投递

到点提醒的投递记录，状态区分「已生成 / 待顾问处理 / 已发出 / 已核验 / 发送失败 / 已取消」（PRD §8.3）。发送走现有 draft→delivery→verification 链路。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `rmd_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `calendarItemId` | string | 是 | 关联事项（记录类提醒可空） |
| `kind` | enum | 否 | `item_reminder`（事项提醒）/ `gentle_inquiry`（当日未反馈温和询问，每天至多 1 次）/ `plan_notice`（发布/变更通知） |
| `message` | string | 否 | 提醒文案（进入草稿正文，≤500 字） |
| `localDate` | string | 否 | 频控所属本地日期 |
| `freqKey` | string | 否 | 频控键：`patientId + localDate` |
| `scheduledAt` | number | 否 | 计划发送时刻 |
| `status` | enum | 否 | 见 §4.5 |
| `quietHoursShifted` | boolean | 否 | 因安静时段顺延 |
| `draftId` / `deliveryId` / `verificationId` | string | 是 | 接入现有草稿链路的证据链 |
| `sentAt` / `verifiedAt` | number | 是 | |
| `errorCode` | string | 是 | 发送失败原因（`UPSTREAM_UNAVAILABLE` 等） |
| `cancelReason` | enum | 是 | 同 calendar_item.cancelReason + `freq_capped` / `pref_off` / `consent_withdrawn` |
| `cancelledAt` | number | 是 | |
| `sandbox` | boolean | 否 | |
| `createdAt` / `updatedAt` | number | 否 | |

**频控**（A10，默认值待试点验证）：普通提醒合并，每人每天≤2 次（`h5.reminder.dailyLimit`）；温和询问计入上限；`21:00–08:00` 安静（取租户与患者偏好更严者）；调度重启按 `freqKey + kind + localDate` 去重，过期普通提醒合并为当前有效事项、不密集补发。
**状态语义**：系统投递成功、群消息已核验、患者已读、患者完成行动是**四个不同事实**，不得互相替代（A10）；H5 页面访问不推断已读。

### 3.13 privacy_request —— 隐私申请

患者发起的导出 / 纠错 / 删除申请（PRD §13、H09）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | `prq_...` |
| `tenantId` | string | 否 | |
| `patientId` | string | 否 | |
| `kind` | enum | 否 | `export` / `correction` / `deletion` |
| `targetType` / `targetId` | string | 是 | correction 指向 `ppe_`/`rec_`；deletion/export 为空 |
| `detail` | string | 否 | 申请说明（≤300 字，不含健康正文——引用对象 id 即可） |
| `status` | enum | 否 | `submitted` / `handled` / `rejected` |
| `handledBy` / `handledAt` | string / number | 是 | 具备 `h5.privacy.handle` 的账号 |
| `resultNote` | string | 是 | 处理结论（含留存政策口径，**不承诺立即彻底删除**） |
| `createdAt` / `updatedAt` | number | 否 | |

- 删除申请处理：软删除 + 留存政策执行（政策上线前冻结真实删除能力，页面文案如实）。
- H09 档案纠错也走本实体（kind=correction），或 followup kind=profile_correction——**两入口同一队列**，控制台统一处理；v1 统一用 `privacy_request` 承载纠错，followup 专注服务事项。

### 3.14 h5_audit —— 患者域审计

结构与 `audit_event` 同构（P1-data-model §3.17），存患者 H5 域独立表，**只追加**。`actorType` 增加 `patient`。

典型 action（前缀 `h5.`）：`h5.session.issue` / `h5.session.revoke` / `h5.consent.grant` / `h5.consent.withdraw` / `h5.plan.publish` / `h5.plan.suspend` / `h5.plan.supersede` / `h5.item.feedback` / `h5.record.submit` / `h5.record.correct` / `h5.followup.submit` / `h5.followup.claim` / `h5.followup.resolve` / `h5.reminder.cancel` / `h5.privacy.request` / `h5.privacy.handle` / `h5.invitation.create` / `h5.invitation.revoke` / `h5.media.read`。

`detail` 约束：只含 id、版本、枚举、结果；**不含**手机号、健康正文、照片内容、令牌。

### 3.15 h5_event —— 埋点事件（指标）

白名单事件，服务端落库并出指标（PRD §14.2）。**只含业务标识与必要数值，不含健康正文。**

| 事件 | 载荷（除公共字段外） | 指标用途 |
|---|---|---|
| `h5.session_start` | loginMode | 进入服务人数 |
| `h5.profile_step_complete` | stepKey, durationMs | 建档流失 |
| `h5.consent_decide` | scope, action | 授权漏斗 |
| `h5.plan_view` | planVersion | 计划理解（配合访谈） |
| `h5.plan_acknowledge` | planVersion | 已了解留痕 |
| `h5.calendar_feedback` | kind, backfill(bool) | 执行反馈率（分项） |
| `h5.record_submit` | recordKind, durationMs, failed(bool), fallback(识别降级) | 记录轻松度 |
| `h5.article_view` | articleId, from(plan/calendar/standalone) | 文化内容触达 |
| `h5.followup_submit` | kind | 反馈量 |
| `h5.reminder_pref_change` | field | 偏好调整 |

公共字段：`{ id: evt_..., patientId, tenantId, at, sessionId }`。口径（激活、D7 等）在 api §12 与验收文档定义，行为数据**不作医学疗效证明**。

---

## 4. 状态机

### 4.1 patient_invitation.status

```text
pending ──兑换成功──> used（终态）
   ├──超过 expiresAt──> expired（终态）
   └──团队撤销──> revoked（终态）
```

- 兑换失败（手机号不匹配、验证码错、无服务权限、SMS 未配置）**不改状态**，返回相应错误码；同一 `pending` 邀请验证码错误次数超过 5 次锁定（`RATE_LIMITED`），团队可撤销重发。
- `used/expired/revoked` 均不可逆；患者需重新办理时新建邀请（新 `pinv_`）。

### 4.2 health_plan.status

```text
data_pending ──资料补齐/触发生成──> generating ──成功──> reviewing
      ^                             │                        
      │                             └─失败──> generate_failed（团队可接管→manual 草稿）
      │                                       
reviewing ──审核通过+发布──> published ──新版本发布──> superseded（终态）
   │            │                ├──团队暂停──> suspended ──恢复──> published
   │            │                └──到期/结束──> ended（终态）
   │            └─退回修改──> rejected（终态，记录退回原因）──> 新版本 data_pending/generating
   └─资料仍缺──（停留）
```

| 值 | 含义 | 患者端表现 |
|---|---|---|
| `data_pending` | 资料待补充 | 「完善资料后开始准备计划」+ 补充入口（A03） |
| `generating` | AI 生成中 | 「正在为你准备计划」（H03 无计划态） |
| `generate_failed` | 生成失败，资料保留 | 同上 + 团队待办（不伪装成功，A03） |
| `reviewing` | 待专业审核 | 同上；**未审核对患者不可见**（A04） |
| `rejected` | 审核退回（历史保留） | 不可见 |
| `published` | 已发布/执行中 | 计划页 + 日历（同版本，A04） |
| `suspended` | 团队暂停 | 计划页显示暂停说明；未来提醒取消；历史只读 |
| `superseded` | 已被新版本替代 | 历史版本可查（患者端默认展示当前版） |
| `ended` | 已结束（到期/服务结束） | 历史可查，进度停止 |

**不变式**：`published` 至多一条/患者；`publish` 与 `supersede` 在同一事务内完成（旧版 `effectiveTo` = 新版 `effectiveFrom`）；历史执行与记录**不改写**（A05）。

### 4.3 calendar_item.status

```text
pending ──患者确认──> done（可更正回 pending，见 revisions）
   ├──患者选择──> missed（可更正）
   ├──患者选择──> needs_help（生成 fup；仍可事后完成）
   └──计划/服务事件──> cancelled（终态，保留 cancelReason）
done/missed/needs_help ──计划事件──> cancelled？否：已反馈事项保留反馈，不被取消改写
```

| 值 | 含义 | 操作 |
|---|---|---|
| `pending` | 待进行（含未来与今天未反馈） | 可查看说明；今天可反馈 |
| `done` | 已完成（确认或记录满足） | 可更正（revision） |
| `missed` | 今天没做到（患者主动） | 可补充原因；不作批评性提示 |
| `needs_help` | 需要帮助 | 生成团队跟进；仍可补完成 |
| `cancelled` | 因计划调整等原因取消 | 保留历史依据；**不再可完成**（A05） |

- `overdue` 为读时派生：过去日期 + pending。仅触发「温和询问」提醒与团队待跟进标记，不改状态。
- 未来日期的 done/missed/needs_help 请求被拒绝（`ITEM_NOT_MODIFIABLE`）。

### 4.4 followup_request.status

```text
pending（待接收）──认领──> claimed（跟进中）──处理完成──> resolved（终态）
   │                        │
   │超时未认领──> 仍 pending + escalated（升级主管，不改状态）     
   └──患者撤销──> resolved（closedByPatient=true，note 记录）
```

- 首次人工响应时间 = `claimedAt`；`autoAckSentAt` 存在**不代表**处理（A11）。
- 升级不改状态、只加 `escalatedAt/escalatedTo`，保证无永久孤立留言（A11）。

### 4.5 reminder_task.status

```text
generated ──到点──> advisor_pending ──顾问发出（经草稿链）──> sent ──回读核验──> verified
   │                    │                                   └─核验失败──> send_failed（可重试→advisor_pending）
   │                    └─发送失败──> send_failed
   └─任何状态（sent 前）──取消──> cancelled（终态，记 cancelReason）
```

- `sent` 前每次状态迁移都**重新校验**：授权（reminder scope）、服务状态、计划版本、事项状态（§5）。
- `verified` 证据挂在现有 delivery/verification；**已核验 ≠ 患者已读 ≠ 行动完成**。

### 4.6 content_article.status

```text
draft ──提交审核──> reviewing ──通过──> published ──下架──> retired（终态）
                        └─退回──> draft（修订升 version）
```

未审核不发布；AI 只能引用 `published` 且未 `retired` 的内容；停用后不再推荐（A09）。

### 4.7 privacy_request.status

`submitted → handled / rejected`；终态不可重开，新申请新建。

---

## 5. 取消传播（服务暂停 / 授权撤回 / 新版生效 / 内容下架）

**总原则**：取消只向「未来」传播；历史（已完成事项、已提交记录、已发出提醒及其证据）一律保留不改写（A02/A05）。每次取消写 `h5_audit`（`h5.reminder.cancel` / `h5.plan.supersede` 等）。

| 触发事件 | calendar_item | reminder_task | 患者会话/页面 | 照片访问 | AI 处理 | 团队侧 |
|---|---|---|---|---|---|---|
| 新版计划 `publish` | 旧版未来 pending 事项 → `cancelled(plan_superseded)`；已反馈事项保留 | 关联旧版的 advisor_pending 以下任务 → `cancelled` | 新版立即生效；旧版转历史 | 不变 | 生成新的日历事项 | 发布记录 + 审计 |
| 计划 `suspended` | 保留 pending；展示暂停说明 | 未来任务 → `cancelled(plan_suspended)` | 计划页暂停态；日历置灰但可看历史 | 不变 | 保持（不生成新事项） | 待办出现「恢复/结束」 |
| 计划 `ended` | 未来事项 → `cancelled(plan_ended)` | 同上取消 | 历史可查 | 不变 | 停止 | 归档视图 |
| 撤回 `health_processing` | 不取消（只读展示） | 不直接取消 | 个人页面进入受限态（仅已发布内容可读） | 不变 | **停止并中止进行中生成/识别** | 控制台标注「AI 处理已停」 |
| 撤回 `photo_analysis` | 不变 | 不变 | 照片识别入口关闭；已保存候选保留 | **保留**（原图可读，识别停止） | 识别不再排队 | 候选不再更新 |
| 撤回 `reminder` | 不变 | **全部未发出任务 → `cancelled(consent_withdrawn)`**（含温和询问） | 提醒偏好页显示已关闭 | 不变 | 不变 | 待办消失；发送前再校验兜底 |
| 撤回 `team_access` | 不变 | 不变 | 反馈历史可见摘要 | 团队端读正文受限（计数与审计保留） | 不变 | 处理中请求仅见摘要 |
| 撤回 `service_basic` | 不变 | 同撤回 reminder（服务停止连带） | **会话全部撤销**；仅公开内容 | 患者会话读取 401 | 停止 | 绑定状态变 unbound 视配置而定（待决 §12.4） |
| `patient.status` → `paused`（服务暂停） | 未来事项保留 pending | 全部未发出任务 → `cancelled(service_stopped)` | 会话保留但 `/me` 返回 `service_paused`；个人数据只读 | 保留 | 停止 | 患者卡片暂停标识 |
| 会话撤销（退出/团队吊销） | 不变 | 不变 | 该会话 401；重新认证可回 | 该会话读取 401 | 不变 | 审计 `h5.session.revoke` |
| 内容 `retired` | 关联事项保留 `linkedArticleIds`，读时校验 → 前端显示「内容已更新」 | 不变 | 文章列表/详情不再返回正文 | 不变 | 不再引用 | 版本可追溯 |
| 团队手动取消事项 | → `cancelled(team_cancelled)` | 关联任务取消 | 事项显示已取消 | 不变 | 不变 | 记录操作人 |

**发送前校验**（A02）：reminder 从 `advisor_pending → sent` 前重新检查上表全部条件；不满足则原地转 `cancelled`，不触达。

---

## 6. 权限模型

### 6.1 两套身份，互不复用

| 身份 | 凭证 | 数据范围 |
|---|---|---|
| 患者会话 | `zb_h5_session` Cookie（invite/phone + 短信验证码签发） | **仅本人**（tenantId + patientId 由会话推导；不接受请求参数指定他人 id；URL 改参数一律 `404`） |
| 员工会话 | 现有 `zhiban_session` / 侧边栏令牌 | 按现有 P1 权限矩阵 + §6.3 新增能力 |

患者接口**不提供** Bearer Token、不跨域；`Origin`/`Referer` 校验同源（变更类请求）。

### 6.2 患者端权限（scope 门控）

| 资源 | 需要的授权 |
|---|---|
| `GET /manifesto`、已发布文章 | 无需登录（公开） |
| `/me`、计划、日历、记录、团队、偏好 | `service_basic` granted |
| 计划生成、记录整理 | `health_processing` |
| 餐食照片识别 | `health_processing` + `photo_analysis` |
| 提醒触达 | `reminder` |
| 团队读本人记录正文 | `team_access`（影响的是团队端可见性） |

未满足时返回 `403 CONSENT_REQUIRED`（个人数据）或降级只读公开内容；**不**因此泄露其他患者或租户数据。

### 6.3 团队端新增能力（additive，挂在现有 account 上）

控制台账号新增可空字段 `h5Permissions: string[]`（默认 `[]`），由 admin 分配：

| 能力 | 控制 | 默认 |
|---|---|---|
| `h5.invite.manage` | 创建/撤销邀请、处理绑定错误 | admin / supervisor 可默认授予；scope=self 顾问可对**名下**患者操作 |
| `h5.plan.review` | 计划审核（编辑/退回/发布/暂停/结束） | **默认无人**（含 admin）——专业审核是业务职责，必须显式授予（PRD §2.2） |
| `h5.followup.handle` | 跟进认领与处理 | admin/supervisor 默认；顾问限名下患者 |
| `h5.content.edit` | 内容编辑 | 默认无人，显式授予 |
| `h5.content.review` | 内容审核发布 | 默认无人（可与 edit 分离） |
| `h5.privacy.handle` | 隐私申请处理 | admin 默认 |
| `h5.reminder.send` | 提醒经草稿链发出 | 顾问职责，随 advisor 身份 |

- `viewer` 只读；`scope=self` 叠加名下范围（越权一律 `404`，同 P1 约定）。
- 无 `h5.plan.review` 授予时**不开启**真实个性化发布；无跟进值守时不开启真实试点（PRD §10）。

---

## 7. 存储约定

- 新 DSH 领域存储：**`zhiban_patient_h5` v1**（独立于 `zhiban_patient` / `zhiban_console` / `zhiban_sidebar`；表 schema 只校验定位字段，其余透传，沿用现有插件域模式）。
- 表（snake_case 复数）：`h5_bindings`、`patient_invitations`、`patient_h5_sessions`、`patient_consents`、`patient_profile_entries`、`health_plans`、`calendar_items`、`patient_records`、`h5_media`、`followup_requests`、`content_articles`、`reminder_tasks`、`privacy_requests`、`h5_audits`、`h5_events`、`idempotency_records`。
- 关键索引/唯一约束：

```sql
CREATE UNIQUE INDEX uq_h5_binding ON h5_bindings(tenant_id, patient_id) WHERE deleted_at IS NULL AND status='bound';
CREATE UNIQUE INDEX uq_pinv_code ON patient_invitations(tenant_id, code);
CREATE UNIQUE INDEX uq_h5_session_token ON patient_h5_sessions(token_hash);
CREATE UNIQUE INDEX uq_hpl_patient_version ON health_plans(tenant_id, patient_id, version);
CREATE UNIQUE INDEX uq_rec_idem ON patient_records(tenant_id, patient_id, idempotency_key);
CREATE INDEX idx_cal_patient_date ON calendar_items(tenant_id, patient_id, scheduled_date);
CREATE INDEX idx_rec_patient_date ON patient_records(tenant_id, patient_id, occurred_date);
CREATE INDEX idx_fup_status ON followup_requests(tenant_id, status, sla_due_at);
CREATE INDEX idx_rmd_freq ON reminder_tasks(tenant_id, freq_key, local_date, kind);
CREATE INDEX idx_h5_audit_at ON h5_audits(tenant_id, at DESC);
```

- 照片文件不进库：`DSH_HOME/zhiban/h5media/<patientId>/<mediaId>.<ext>`；库中只存元数据（§3.9）。
- 留存：v1 **不做自动删除**；删除申请按 §3.13 人工处理。页面文案不得承诺「立即彻底删除」。

---

## 7.1 路径归属（患者端新增代码，多包并行依据）

「患者端新增路径与跨包文件归属先在契约中确定，不能直接越界修改其他工作包」（各 PH5 issue）。归属如下：

| 路径 | 归属 | 约定 |
|---|---|---|
| `docs/PATIENT-H5-data-model.md`、`docs/PATIENT-H5-api.md` | PH5-01 | 变更走 §13；其他包需要改契约时在自己的 PR 里评论登记 |
| `src/p1/patient-h5.ts` | PH5-02 | 身份/邀请/会话/授权/隐私领域逻辑 |
| `src/p1/patient-h5-<域>.ts` | 各包自有文件：profile（PH5-03/10）、plan（PH5-04）、calendar（PH5-05）、record（PH5-06）、followup（PH5-07）、content（PH5-08）、reminder（PH5-09） | 新建文件，不改他人文件 |
| `plugins/zhiban-patient-h5/`（config.ts、domain.ts、http.ts、index.ts） | PH5-02 建骨架 | 后续包新增自己的 `plugins/zhiban-patient-h5/routes/<域>.ts`，不改骨架文件 |
| `plugins/zhiban-console/routes/ph5-*.ts` | 各包自有文件 | 团队端接口；`plugins/zhiban-console/index.ts` 仅允许追加一小段装配调用（同 h-knowledge 先例），不改框架 |
| `patient-h5/`（Vite 前端） | PH5-03 建骨架 | 页面目录 `patient-h5/src/pages/<页面>/` 各包自有；`patient-h5/src/api/`、`src/mock/`、根配置由建骨架包维护，其他包新增不改 |
| `tests/ph5-*.test.ts` | 各包自有测试文件 | `tests/helpers.ts`、`tests/p1-helpers.ts` 不改（需要公共工具时放 `src/p1/patient-h5-<域>.ts` 内导出） |
| `docs/design/patient-h5/**` | PH5-03 | 素材与清单 |
| `docs/PATIENT-H5-VALIDATION.md` | PH5-11 | 验收报告 |
| nginx / `deploy/` | PH5-11 | `/zhiban/h5` 与 `/h5/` 路由在部署包落地；PH5-02–10 本地开发经 DSH webServer 直连 |

现有 P1 目录（`src/c2/**`、`plugins/zhiban-{wecom,patient,memory,care,guard,knowledge,console,advisor}/**`、`console/**`）对 PH5 各包**只读**（console 的 `routes/ph5-*.ts`、`index.ts` 装配追加、患者详情页的邀请区块组件目录除外）。



| 现状 | 兼容方式 |
|---|---|
| `patient` 主键 | 全部新实体挂既有 `pat_`；不因打开 H5 新建档案；`patient` 字段零改动 |
| `patient.consent`（存档同意） | 原语义不变；H5 分项授权独立成 `patient_consent`；两者互不推断 |
| `care_plan`（一次性提醒） | 原链路原样运行（zhiban-care 调度不动）；不迁移到 health_plan；提醒频控互不合并，文档口径注明两者区别 |
| `meal_log`（群餐照） | 原样保留；H5 记录为 `patient_record`；同日同餐双来源 + 疑似重复确认（§3.8） |
| `service-plan`（B 档示例） | 继续仅控制台演示 `sample:true`；H5 一律读 health_plan，不把示例当真实方案 |
| draft/delivery/verification | 提醒发送复用：`reminder_task.draftId` 挂入现有链路；C2 核心零改动 |
| 控制台会话/角色 | 新增 `account.h5Permissions`（可空数组，additive）；现有角色权限矩阵不变 |
| 控制台 SSE | 新增事件类型 `h5.plan.*`、`h5.followup.*`、`h5.record.*`（见 api §13），向后兼容 |
| nginx 路由 | 新增 `/zhiban/h5` 前缀转发到 DSH webServer（与 `/zhiban/sidebar` 同模式），不动现有 location |

---

## 9. 埋点与指标口径（数据层）

- 激活定义：首次打开已发布计划（`h5.plan_view` 首次）且完成至少一条行动反馈或记录（PRD §14.2）。
- D7 回访：激活后第 7 日（本地日期）有 `h5.session_start`。
- 执行反馈率分项报告：`done` / `missed` / `needs_help` / 未反馈分别统计，**不混称完成率**；分母 = 到期有效事项（排除 cancelled）。
- 记录耗时中位数：`h5.record_submit.durationMs`，起于进入编辑页（前端计时上报）。
- 首次人工响应：`followup.claimedAt - createdAt`；自动回执不计。
- AI 采纳：计划原样/修改后发布比例（reviewHistory 中编辑标记）；识别更正率 = confirmedFoods 与 aiCandidates 的差异比例。
- 所有指标排除 `sandbox=true`；埋点载荷白名单校验，超字段丢弃。

---

## 10. 与各工作包的对齐

| 实体/能力 | 主责工作包 | 本文补充 |
|---|---|---|
| invitation / session / binding / consent | PH5-02（#231） | 状态机、隐私红线、错误码 |
| profile_entry | PH5-03（#232 建档）+ PH5-10（#239 纠错） | 来源/确认状态、安全规则 |
| health_plan 生成与审核 | PH5-04（#233） | 输入快照、发布门禁、版本传播 |
| calendar_item / today 聚合 | PH5-05（#234） | 完成判定、overdue 口径 |
| patient_record / h5_media | PH5-06（#235） | 幂等、识别降级、双来源 |
| followup_request | PH5-07（#236） | 认领/升级、响应口径 |
| content_article | PH5-08（#237） | 署名/引用/下架规则 |
| reminder_task | PH5-09（#238） | 频控、状态语义、取消传播 |
| privacy_request / 偏好 | PH5-10（#239） | 申请类型与处理状态 |
| 埋点/验收 | PH5-11（#240） | 事件白名单与指标口径 |

---

## 11. 契约示例（虚构）

```json
{
  "id": "hpl_01j9z3k4m5n6p7q8r9s0t1u2v3",
  "tenantId": "tn_01j9z3k4m5n6p7q8r9s0t1u2v3",
  "patientId": "pat_01j9zb2c3d4e5f6g7h8j9k0m1n",
  "version": 2,
  "status": "published",
  "stageGoal": "本阶段先让晚餐清淡、睡眠规律起来",
  "startDate": "2026-12-01",
  "endDate": "2026-12-28",
  "actions": [
    {
      "actionId": "act_1",
      "title": "晚餐清淡少油",
      "purpose": "减少晚间油腻，让脾胃轻一点",
      "method": "以蒸煮为主，少油炸；吃到七分饱",
      "schedule": { "kind": "daily", "time": "18:30" },
      "feedbackKind": "record_meal",
      "linkedArticleIds": ["art_01j9..."]
    }
  ],
  "review": {
    "status": "approved",
    "reviewerAccountId": "acc_01j9...",
    "reviewerName": "陈营养师（虚构）",
    "reviewedAt": 1762646400000,
    "note": "依据已确认；晚餐份量表述已改",
    "editedByReviewer": true
  }
}
```

> 示例中的人名、机构、日期均为虚构，不作为验收证据。

---

## 12. 待决项（不阻塞草拟，阻塞定稿与真实试点）

1. **再次登录方式**：首次绑定后是否允许「手机号+验证码」免邀请登录（本文默认允许并已定义机制）；安全评审结论未出，需项目负责人确认。
2. **短信资源**：供应商、模板、频控与成本；未落实前真实登录阻塞（`SMS_UNAVAILABLE`），演示只能用虚构数据 + mock 渠道（#229 闸门）。
3. **本地日期时区**：v1 固定 Asia/Shanghai；是否随 `tenant.timezone` 待定。
4. **撤回 service_basic 是否自动解绑**（h5_binding → unbound）：本文默认**不**自动解绑（保留重新授权通道），待隐私政策确认。
5. **留存与删除政策**：真实删除流程上线前，privacy_request(deletion) 只能记录与软删；文案如实。
6. **`h5.plan.review` 授予名单**：专业审核人员资质与值守时间（#229）；未落实不发布真实计划。
7. **care_plan 与 reminder_task 并存期的统一看板口径**（是否合并统计）——待产品决定，本文不改 care_plan 语义。
8. **食养内容首批试点篇目与审核人**（#237 前置）。

---

## 13. 变更流程

沿用 P1-data-model §10：**只做新增**；删改字段先在 #230 评论登记，项目负责人确认后同步更新本文与 [PATIENT-H5-api.md](./PATIENT-H5-api.md)；版本号递增（当前 v0.1）；实施 PR 的「契约变更」节必须列出本文条目。
