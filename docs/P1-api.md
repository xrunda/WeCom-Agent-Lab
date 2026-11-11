# 知伴健康 Agent · P1 控制台 API 契约

> 版本：**v1.0**（2026-11-09）· 归属：WP-A（#62）
> 配套：[P1-data-model.md](./P1-data-model.md)（字段与枚举的唯一依据）· 范围：[P1-scope.md](./P1-scope.md) §4
> 前端按本文写 mock，后端按本文实现。**字段以数据模型文档为准，接口以本文为准**；两者冲突时先提 #62。

---

## 1. 通用约定

### 1.1 地址

- 统一前缀：`/zhiban/api`。例：`GET /zhiban/api/patients`。
- 控制台静态资源由 Nginx 提供，API 反代到 DSH 插件注册的路由（#30 / #41 / #52）。
- 本文所有路径省略前缀。除特别说明外均为 `Content-Type: application/json; charset=utf-8`。
- 契约版本为 v1；变更规则见 §18。

### 1.2 认证与会话

- 账号密码登录。成功返回 `Set-Cookie`：

```http
Set-Cookie: zhiban_session=<opaque>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800
```

- 会话有效期 7 天，服务端可撤销。所有接口（`/auth/login` 除外）都要求有效 Cookie。
- 变更类请求（POST / PATCH / DELETE）校验 `Origin` 与控制台域名一致；不一致返回 `403 FORBIDDEN`。
- 不提供 Bearer Token、不提供跨域 API。P1 不需要开放 API。
- 密码要求：≥ 10 位，含字母与数字；服务端只存强哈希，任何接口都不返回密码或哈希。

### 1.3 请求与响应头

| 头 | 方向 | 说明 |
|---|---|---|
| `X-Request-Id` | 请求/响应 | 可选。响应必带；服务端未收到时自行生成 |
| `Idempotency-Key` | 请求 | 可选。用于告警处理、沙盒动作等 POST，10 分钟内重复提交返回首次结果 |
| `Retry-After` | 响应 | 429 时给出等待秒数 |
| `Cache-Control: no-store` | 响应 | 所有业务接口（`/media/*` 为 `private, max-age=300`） |

### 1.4 错误格式

所有非 2xx 响应：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "body 超长",
    "details": [{ "field": "body", "issue": "max 1000 chars" }],
    "requestId": "req_01j9z..."
  }
}
```

| code | HTTP | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录或会话过期 |
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误 |
| `FORBIDDEN` | 403 | 角色不足、跨租户、Origin 不合法 |
| `ACCOUNT_DISABLED` | 403 | 账号已停用 |
| `NOT_FOUND` | 404 | 实体不存在或不属于当前租户 |
| `VALIDATION_FAILED` | 422 | 字段缺失、类型错误、超长、枚举非法 |
| `CONFLICT` | 409 | 状态冲突（如重复绑定、重复用户名） |
| `BUILTIN_RULE` | 409 | 试图修改内置红线 |
| `IMMUTABLE_RESOURCE` | 409 | 试图修改不允许改的状态（如已完成的计划） |
| `RATE_LIMITED` | 429 | 登录失败过多或请求过频 |
| `LIMIT_EXCEEDED` | 429 | 沙盒每日轮次用尽 |
| `UPSTREAM_UNAVAILABLE` | 502 | 企微/模型侧不可用 |
| `INTERNAL` | 500 | 未预期错误 |

### 1.5 分页、筛选与排序

- 请求：`page`（默认 1）、`pageSize`（默认 20，最大 100）。
- 响应：

```json
{ "items": [], "page": 1, "pageSize": 20, "total": 0 }
```

- 时间筛选：`from` / `to` 接受毫秒时间戳或 ISO 8601，`to` 为开区间。
- 多值筛选用逗号：`status=VERIFIED,EDIT_SENT`。
- 排序：`sort=-createdAt`；未指定时用各接口的默认值。
- 列表默认排除 `sandbox=true`；`sandbox=true` 时只看沙盒数据。
- 默认排除软删除；`includeDeleted=true` 仅 admin 可用。

### 1.6 角色与权限矩阵

| 资源 | admin | supervisor | viewer |
|---|---|---|---|
| 登录 / 会话 / 改密 | ✅ | ✅ | ✅ |
| 租户与运营参数 读 | ✅ | ✅ | ✅ |
| 租户与运营参数 写 | ✅ | ❌ | ❌ |
| 工作台 / 价值看板 / 报表 | ✅ | ✅ | ✅ |
| 患者、记忆、计划 读 | ✅ | ✅ | ✅ |
| 患者、记忆、计划 写 | ✅ | ✅ | ❌ |
| 患者 删除 | ✅ | ❌ | ❌ |
| 服务流 读 | ✅ | ✅ | ✅ |
| 证据链 / 记录导出 | ✅ | ✅ | ❌（403） |
| 服务群 读写 | ✅ | ✅ | 只读 |
| 顾问 读 | ✅ | ✅ | ✅ |
| 顾问 新增 / 修改 / 删除 | ✅ | ❌ | ❌ |
| 顾问 暂停 / 恢复 / 释放队列 | ✅ | ✅ | ❌ |
| 告警 读与处理 | ✅ | ✅ | 只读 |
| 知识库 / 风险规则 写 | ✅ | ❌ | ❌ |
| 话术库（B 档）读 | ✅ | ✅ | ✅ |
| 技能市场 / 方案包 读 | ✅ | ✅ | ✅ |
| 账号与角色 | ✅ | ❌ | ❌ |
| 审计 读 | ✅ | ✅ | ✅ |
| 审计 导出 | ✅ | ✅ | ❌ |
| 数据与安全页 读 | ✅ | ✅ | ✅ |
| 开通页 读 | ✅ | ✅ | ✅ |
| 申请开通 提交 | ✅ | ✅ | ❌ |
| 开通申请 列表 | ✅ | ❌ | ❌ |
| 开通申请 处理 | `platform` | ❌ | ❌ |
| 体验沙盒 | ✅ | ✅ | ✅ |
| 媒体读取 | ✅ | ✅ | ✅ |
| SSE | ✅ | ✅ | ✅ |

- `platform` 是部署侧平台超管，不属于任何租户，不出现在租户账号列表；只在运维通道使用，可处理开通申请。租户接口对 `platform` 一律按 `404` 处理（除开通申请处理）。
- 权限不足统一 `403 FORBIDDEN`；不返回「该功能需要某角色」以外的实现细节。

### 1.7 `sandbox` 与 `demo`

- 列表默认 `sandbox=false`；沙盒页面显式传 `sandbox=true`。
- `demo=true` 的数据正常出现在所有列表与统计中，仅用于界面打标签。
- 沙盒数据不计入工作台、报表、告警角标（服务端聚合时过滤）。

### 1.8 幂等与并发

- 告警处理、队列释放、沙盒动作支持 `Idempotency-Key`。
- 写接口不做乐观锁；前端以响应返回的最新实体为准。状态冲突返回 `409`。

### 1.9 限流

| 范围 | 限制 | 超限 |
|---|---|---|
| 登录 | 同 IP + 用户名 15 分钟 5 次失败 | `429 RATE_LIMITED` |
| 业务接口 | 每账号 120 次/分钟 | `429 RATE_LIMITED` |
| 沙盒对话 | 每账号每天 100 轮 | `429 LIMIT_EXCEEDED` |

---

## 2. 认证

### `POST /auth/login`

角色：公开。请求：

```json
{ "username": "admin", "password": "**********" }
```

响应 `200`：

```json
{
  "account": {
    "id": "acc_01j9za1b2c3d4e5f6g7h8j9k0m",
    "tenantId": "tn_01j9z3k4m5n6p7q8r9s0t1u2v3",
    "username": "admin",
    "displayName": "林主管",
    "role": "admin",
    "status": "active",
    "lastLoginAt": 1762646400000,
    "createdAt": 1760000000000,
    "updatedAt": 1762646400000,
    "deletedAt": null
  },
  "tenant": { "id": "tn_01j9z3k4m5n6p7q8r9s0t1u2v3", "name": "安康健康管理中心", "agentName": "小安", "patientTerm": "患者" }
}
```

错误：`INVALID_CREDENTIALS` / `ACCOUNT_DISABLED` / `RATE_LIMITED`。

### `POST /auth/logout`

角色：登录用户。响应 `204`，清除 Cookie。

### `GET /auth/session`

角色：登录用户。响应 `200`：

```json
{
  "account": { "id": "acc_...", "displayName": "林主管", "role": "admin" },
  "tenant": { "id": "tn_...", "name": "安康健康管理中心", "agentName": "小安", "patientTerm": "患者", "agentAvatar": null, "tone": "亲切、专业、简洁", "timezone": "Asia/Shanghai" },
  "permissions": ["patient.read", "patient.write", "draft.export", "account.write"],
  "serverTime": 1762646400000
}
```

`permissions` 供前端隐藏按钮；**后端仍必须逐接口鉴权**。

### `POST /auth/password`

角色：登录用户。请求 `{ "currentPassword": "...", "newPassword": "..." }`。响应 `204`。

---

## 3. 租户与运营参数

### `GET /tenant`

角色：全部。响应 `200`：完整 tenant（见数据模型 §3.1），含 `settings`。

### `PATCH /tenant`

角色：admin。请求（全部可选）：

```json
{
  "name": "安康健康管理中心",
  "agentName": "小安",
  "agentAvatar": "/assets/agent-default.png",
  "patientTerm": "会员",
  "tone": "亲切、专业、简洁，不超过 150 字",
  "timezone": "Asia/Shanghai",
  "settings": {
    "archiveSeatPriceYuan": 900,
    "writeMinutesPerDraft": 3,
    "mergeWindowSeconds": 30,
    "quietHours": { "start": "21:00", "end": "08:00" },
    "proactivePerHour": 6,
    "memoryInjectLimit": 30,
    "retentionNotice": "按合同约定；当前演示环境不自动删除"
  }
}
```

响应 `200`：更新后的 tenant。保存即生效：`agentName` / `patientTerm` / `tone` 下一轮 Agent 回合使用（#41），前端下次刷新全局文案。

错误：`VALIDATION_FAILED`（称谓只能是「患者 / 客户 / 会员」；`writeMinutesPerDraft` 1–30；`quietHours` 必须合法 HH:mm）。

---

## 4. 工作台与价值看板

### `GET /dashboard/value?range=today|week|month`

角色：全部。默认 `today`。响应 `200`：

```json
{
  "range": "week",
  "from": 1762387200000,
  "to": 1762992000000,
  "adoption": {
    "original": 3,
    "revised": 2,
    "edited": 1,
    "sentTotal": 6,
    "rate": 0.83,
    "rateFormula": "(原样 3 + 改稿后 2) / 已发出 6"
  },
  "savedMinutes": 15,
  "savedMinutesBasis": "（原样 3 + 改稿后 2）× 3 分钟",
  "minutesPerDraft": 3,
  "proactiveCareCount": 1,
  "verificationPassRate": 0.63,
  "patientsPerAdvisor": 2.0,
  "trend": [
    { "date": "2026-11-09", "label": "11-09", "volume": 4, "verified": 3 },
    { "date": "2026-11-10", "label": "11-10", "volume": 7, "verified": 5 }
  ],
  "advisorRanking": [
    { "advisorId": "adv_...", "name": "李广", "status": "active", "volume": 7, "verified": 5, "avgResponseSeconds": 43 }
  ],
  "computedAt": 1762646400000
}
```

口径严格按数据模型 §5；`range` 以租户时区切日。沙盒数据不计入。

`trend` 固定返回近 14 天（含今天）的真实草稿量，按租户时区分日；`advisorRanking` 按当前 `range` 统计每位顾问的草稿量、核验数与平均响应，均为真实数据，不使用示例集。

### `GET /dashboard/kpis?range=today|week|month`

角色：全部。响应 `200`：

```json
{
  "range": "today",
  "onlineAgents": 6,
  "proactiveToday": 4,
  "memoriesToday": 3,
  "draftsToday": 11,
  "verificationPassRate": 0.95,
  "avgResponseSeconds": 78,
  "openAlerts": 2,
  "computedAt": 1762646400000
}
```

### `GET /dashboard/recent?limit=10`

角色：全部。响应 `200`：`{ "items": [ServiceFlowRow] }`，按 `createdAt` 倒序，默认 10、最大 20。`ServiceFlowRow` 见 §6。

### B 档图表数据

趋势图、排行、数据报表为 B 档，数据来自 `console/src/sample/`，**不提供后端接口**。前端必须显示 `<SampleDataTag/>`。

---

## 5. 患者 Agent

### `GET /patients`

角色：全部。Query：`q`（备注名/标签模糊）、`tag`、`advisorId`、`consent`、`status`、`demo`、`sort`（默认 `-lastActiveAt`）、`page`、`pageSize`。

响应 `200`：

```json
{
  "items": [
    {
      "id": "pat_01j9zb2c3d4e5f6g7h8j9k0m1n",
      "displayName": "张女士",
      "avatar": null,
      "externalUserId": "wm...",
      "identityStatus": "confirmed",
      "identitySource": "manual",
      "identityConfirmedAt": 1762645800000,
      "tags": ["控糖", "高血压"],
      "advisorId": "adv_01j9zc3d4e5f6g7h8j9k0m1n2p",
      "groupIds": ["grp_01j9zd4e5f6g7h8j9k0m1n2p3q"],
      "consent": "agreed",
      "status": "serving",
      "demo": false,
      "accompaniedSince": 1759500000000,
      "lastActiveAt": 1762645800000,
      "memoryCount": 4,
      "pendingPlanCount": 2,
      "createdAt": 1759500000000,
      "updatedAt": 1762645800000,
      "deletedAt": null
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 6
}
```

### `POST /patients`

角色：admin / supervisor。请求：

```json
{ "displayName": "郑先生", "tags": ["术后恢复"], "advisorId": "adv_...", "consent": "unknown", "externalUserId": "wm...", "demo": false }
```

响应 `201`：patient。错误：`CONFLICT`（同租户备注名 + 外部 id 重复时提示，但不强制唯一）、`VALIDATION_FAILED`。

### `GET /patients/{id}`

角色：全部。响应 `200`：

```json
{
  "patient": { "id": "pat_...", "displayName": "张女士", "externalUserId": "wm...", "identityStatus": "confirmed", "identitySource": "manual", "identityConfirmedAt": 1762645800000, "tags": ["控糖"], "consent": "agreed", "status": "serving", "demo": false, "memoryCount": 4, "pendingPlanCount": 2 },
  "advisor": { "id": "adv_...", "name": "李顾问", "status": "active", "online": true },
  "groups": [{ "id": "grp_...", "name": "糖友-张女士", "status": "serving", "isPrimary": true }]
}
```

### `POST /patients/{id}/identity`

角色：admin / supervisor。确认 / 改绑患者身份：把患者的企微身份指向其服务群里的一位外部成员。

请求：

```json
{ "groupId": "grp_...", "externalUserId": "wm...", "displayName": "张女士" }
```

- `groupId`、`externalUserId` 必填；`displayName` 可选（缺省时跟随被选成员的昵称）。
- 患者必须已绑定该服务群，否则 `422 VALIDATION_FAILED`（`NOT_BOUND`）。
- 目标必须是该群的外部成员（个人微信），内部员工目标返回 `422`（`MEMBER_NOT_EXTERNAL`）。
- 成功后：患者的 `externalUserId` 指向新成员，`consent` 跟随该成员，`identityStatus='confirmed'`、`identitySource='manual'`、`identityConfirmedAt` 置为当前时间；被选成员角色置为 `self`，原「本人」成员降为 `family`。

响应 `200`：patient。审计 `patient.identity`（仅记录成员 id 尾号，不记录昵称）。

### `PATCH /patients/{id}`

角色：admin / supervisor。请求（可选）：`displayName`、`avatar`、`tags`、`advisorId`、`consent`、`status`、`demo`、`externalUserId`。响应 `200`：patient。

### `DELETE /patients/{id}`

角色：admin。软删除；有进行中草稿时返回 `409 CONFLICT`（先处理草稿或改状态为 `archived`）。响应 `204`。

### 记忆

#### `GET /patients/{id}/memories?category=&includeDeleted=false`

角色：全部。响应 `200`：`{ "items": [memory], "page": 1, "pageSize": 50, "total": 4 }`，按 `category`、`createdAt` 排序。默认 `pageSize=50`。

#### `POST /patients/{id}/memories`

角色：admin / supervisor。请求：

```json
{ "category": "dietary_taboo", "content": "对海鲜过敏", "subject": "self", "sourceText": "我对海鲜过敏" }
```

响应 `201`：memory，`createdBy="staff"`、`createdById=当前账号`。错误：`VALIDATION_FAILED`（`content` 超 200 字）。

#### `PATCH /memories/{id}`

角色：admin / supervisor。请求：`category`、`content`、`subject`。响应 `200`：memory；写审计 `memory.update`。

#### `DELETE /memories/{id}`

角色：admin / supervisor。软删除；写审计 `memory.delete`。响应 `204`。Agent 下一轮不再引用。

### 主动计划

#### `GET /patients/{id}/care-plans?status=pending|done|cancelled`

角色：全部。响应 `200`：`{ "items": [care_plan], ... }`，按 `when` 升序。

#### `POST /patients/{id}/care-plans`

角色：admin / supervisor。请求：

```json
{ "title": "提醒量血压", "when": 1762732800000, "rrule": null, "source": "staff" }
```

响应 `201`：care_plan。`when` 不能早于当前时间（否则 `VALIDATION_FAILED`）。

#### `POST /care-plans/{id}/cancel`

角色：admin / supervisor。响应 `200`：care_plan（`status=cancelled`）。已 `done` 返回 `409 IMMUTABLE_RESOURCE`。

### 办事记录与时间线

#### `GET /patients/{id}/actions?page=&pageSize=`

角色：全部。响应 `200`：`{ "items": [agent_action], ... }`，按 `createdAt` 倒序。

#### `GET /patients/{id}/timeline?page=&pageSize=`

角色：全部。响应 `200`：

```json
{
  "items": [
    {
      "id": "evt_01j9ze5f6g7h8j9k0m1n2p3q4r",
      "at": 1762645800000,
      "type": "inbound",
      "actor": { "type": "patient", "name": "张女士" },
      "title": "客户发来消息",
      "detail": "晚上吃点什么好",
      "draftId": null,
      "verificationOutcome": null
    },
    {
      "id": "evt_...",
      "at": 1762645860000,
      "type": "draft",
      "actor": { "type": "agent", "name": "小安" },
      "title": "生成第 1 版草稿",
      "detail": "晚上建议清淡一点…",
      "draftId": "draft_1001",
      "verificationOutcome": null
    },
    {
      "id": "evt_...",
      "at": 1762646100000,
      "type": "verification",
      "actor": { "type": "system", "name": "system" },
      "title": "核验通过",
      "detail": "与草稿一致",
      "draftId": "draft_1001",
      "verificationOutcome": "verified"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 3
}
```

`type`：`inbound` / `draft` / `revision` / `delivery` / `verification` / `memory` / `care_plan` / `alert` / `note`。

### 饮食记录

#### `GET /patients/{id}/meal-logs?from=&to=&page=`

角色：全部。响应 `200`：`{ "items": [meal_log], ... }`，按 `createdAt` 倒序。

### B 档 Tab

#### `GET /patients/{id}/health-profile`

角色：全部。响应 `200`：`{ "profile": { ... }, "sample": true }`；无数据时 `profile: null, sample: true`。前端显示示例数据标签。

#### `GET /patients/{id}/service-plan`

角色：全部。响应 `200`：`{ "plan": { ... }, "sample": true }`。

---

## 6. 服务流与证据

### `ServiceFlowRow`

```json
{
  "id": "draft_1001",
  "source": "inbound",
  "groupId": "grp_01j9zd4e5f6g7h8j9k0m1n2p3q",
  "groupName": "糖友-张女士",
  "patientId": "pat_01j9zb2c3d4e5f6g7h8j9k0m1n",
  "patientName": "张女士",
  "advisorId": "adv_01j9zc3d4e5f6g7h8j9k0m1n2p",
  "advisorName": "李顾问",
  "summary": "晚上吃点什么好",
  "riskLevel": "low",
  "status": "VERIFIED",
  "mediaKinds": ["meal"],
  "version": 1,
  "fallback": false,
  "sandbox": false,
  "demo": false,
  "createdAt": 1762645800000,
  "durations": {
    "inboundToDraftMs": 60000,
    "draftToPushMs": 2000,
    "pushToAckMs": 180000,
    "ackToVerifiedMs": 185000
  }
}
```

`mediaKinds`：`image` / `meal` / `report` / `medicine` / `voice` / `file` / `video`；无图时 `[]`。`voice` / `file` / `video` 在前端显示「暂不支持自动草稿」。

### `GET /service-flow`

角色：全部。Query：`groupId`、`advisorId`、`patientId`、`status`（可逗号多值）、`riskLevel`、`source`、`fallback`、`sandbox`、`from`、`to`、`sort`（默认 `-createdAt`）、`page`、`pageSize`。

响应 `200`：`{ "items": [ServiceFlowRow], "page": 1, "pageSize": 20, "total": 42 }`。

### `GET /service-flow/{draftId}`

角色：全部。响应 `200`：

```json
{
  "draft": { "id": "draft_1001", "body": "晚上建议清淡一点…", "version": 1, "revisions": [{ "version": 1, "body": "晚上建议清淡一点…", "instruction": null, "createdBy": "agent", "createdAt": 1762645860000 }], "sentVersion": 1, "riskLevel": "low", "status": "VERIFIED", "ruleIds": [], "citedMemoryIds": ["mem_..."], "citedKnowledgeIds": ["knw_..."], "fallback": false, "sandbox": false, "demo": false, "cardTaskId": "task_1001", "pushAttempts": 1, "verifyAttempts": 1, "createdAt": 1762645800000, "pushedAt": 1762645880000, "ackedAt": 1762646060000, "verifiedAt": 1762646245000, "verificationId": "vrf_..." },
  "patient": { "id": "pat_...", "displayName": "张女士" },
  "group": { "id": "grp_...", "name": "糖友-张女士", "roomId": "wr..." },
  "advisor": { "id": "adv_...", "name": "李顾问" },
  "citations": {
    "memories": [{ "id": "mem_...", "category": "dietary_taboo", "content": "对海鲜过敏", "deletedAt": null }],
    "knowledge": [{ "id": "knw_...", "title": "晚餐建议在 19 点前完成", "deletedAt": null }]
  },
  "deliveries": [{ "id": "dly_...", "version": 1, "msgid": "msg_...", "roomId": "wr...", "text": "晚上建议清淡一点…", "sentAt": 1762646100000, "source": "archive", "sandbox": false, "createdAt": 1762646240000 }],
  "verification": { "id": "vrf_...", "outcome": "verified", "matchedMsgId": "msg_...", "matchedRoomId": "wr...", "matchedGroupName": "糖友-张女士", "similarity": 1, "attempts": 1, "checkedAt": 1762646245000, "sandbox": false },
  "timeline": [
    { "at": 1762645800000, "type": "inbound", "actor": "张女士", "title": "客户发来消息", "detail": "晚上吃点什么好" },
    { "at": 1762645860000, "type": "draft", "actor": "小安", "title": "生成第 1 版草稿" },
    { "at": 1762645880000, "type": "push", "actor": "system", "title": "推送到顾问企微" },
    { "at": 1762646060000, "type": "ack", "actor": "李顾问", "title": "点击已发送" },
    { "at": 1762646245000, "type": "verification", "actor": "system", "title": "核验通过" }
  ],
  "audit": [{ "id": "aud_...", "action": "draft.enqueue", "actorName": "system", "result": "success", "at": 1762645860000 }]
}
```

发错群时 `verification.matchedGroupName` 是实际群名；`deliveries[].roomId` 与 `draft.groupRoomId` 不同。

### `GET /drafts/{draftId}/evidence.pdf`

角色：admin / supervisor（viewer `403`）。响应 `200 application/pdf`（`content-disposition: attachment`，`cache-control: no-store`）。内容：客户原话（含图片缩略图）、全部草稿版本与改稿要求、实发正文、存档 msgid 与时间、核验结果、引用与操作人；页脚导出人与生成时间。写审计 `evidence.export`。

错误：`404 NOT_FOUND`（草稿不存在）、`502 UPSTREAM_UNAVAILABLE`（企微插件未就绪或部署机缺少中文字体）。

### `GET /patients/{id}/records.pdf?from=&to=`

角色：admin / supervisor（viewer `403`）。按患者导出服务记录 PDF：默认最近 30 天，单次最多 200 条并在 PDF 中标注截断；`from` / `to` 接受毫秒时间戳或 ISO 8601，`from >= to` 返回 `422`。写审计 `records.export`。

错误：`404 NOT_FOUND`（患者不存在）、`502 UPSTREAM_UNAVAILABLE`（患者插件或企微插件未就绪、缺少中文字体）。

---

## 7. 服务群

> **实现状态（#60 上线）**：`GET /groups`、`PATCH /groups/{id}`、`GET /groups/{id}/members`、
> 绑定（`POST /groups/{id}/bindings`）已实现并有单测覆盖；
> `GET /groups/{id}` 与成员角色标注（`PATCH .../members/{id}`）仍为契约待实现。
> 控制台前端群页面已接入真实数据。
> 运维脚本 `npm run group:status` 基于本节接口，用于把演示群从 `pending` 改为 `serving`。
>
> **自动发现（#106）**：`zhiban-wecom` 每 5 分钟（`serviceGroupDiscovery.intervalMs`，可配置关闭或改间隔）
> 调客户联系 API `externalcontact/groupchat/list`，只发现企业创建的客户群；配置
> `serviceGroupDiscovery.ownerUserIds` 时只登记本环境群主名下的群。新群自动登记为
> `pending` 候选并出现在 `GET /groups?status=pending`。候选不拉存档消息、不生成草稿。

### `GET /groups`

角色：全部（`patient.read`）。Query：`status`、`advisorId`、`q`（匹配名称 / roomId）、`sort`（`lastActiveAt` / `name` / `updatedAt`，默认 `-lastActiveAt`）、`page`、`pageSize`。非法 `status` / `sort` 返回 `422`。

响应 `200`：`{ "items": [group], ... }`，`group` 含 `patientIds`、`consent`、`memberCount`、`externalMemberCount`、`demo`、`createdAt`、`updatedAt`；不含 `tenantId`、`deletedAt`，已软删除的群不返回。

### `GET /groups/{id}`

角色：全部。响应 `200`：

```json
{
  "group": { "id": "grp_...", "roomId": "wr...", "name": "糖友-张女士", "nameSource": "config", "status": "serving", "advisorId": "adv_...", "patientIds": ["pat_..."], "memberCount": 4, "externalMemberCount": 2, "consent": { "agreed": 2, "unknown": 0, "disagreed": 0 }, "lastActiveAt": 1762645800000, "demo": false },
  "advisor": { "id": "adv_...", "name": "李顾问" },
  "patients": [{ "id": "pat_...", "displayName": "张女士", "isPrimary": true }]
}
```

### `PATCH /groups/{id}`

角色：admin / supervisor（`patient.write`）。请求（至少一个字段）：`name`（同时把 `nameSource` 置为 `manual`，此后不再被企微群名同步覆盖）、`status`（`pending` / `serving` / `collect_only` / `disabled`）、`advisorId`。响应 `200`：group。

状态与存档白名单（#106）：

- `serving` / `collect_only` → 该群加入存档拉取白名单（`zhibanWecomAdmin.activateServiceGroup`）；
- `pending` / `disabled` → 移出白名单（`deactivateServiceGroup`）；
- 状态变更立即写入内存白名单，**下一轮存档轮询（默认 5 秒）即生效，无需重启**；
- 企微域未加载时（如仅患者域的测试装配）跳过同步，只改患者域状态。
- 控制台「开始服务」= 指定负责顾问 + 服务对象（`POST .../bindings { memberId }`）后
  再 `PATCH status=serving`；接口层仍允许直接改状态（运维脚本需要），UI 保证不会出现没有服务对象的服务中群。

错误：`404 NOT_FOUND`（群不存在）、`422 VALIDATION_FAILED`（字段为空、状态非法、顾问不存在）、`502 UPSTREAM_UNAVAILABLE`（白名单同步失败，状态已回滚为变更前值，提示「企微服务群同步失败，服务状态未变更」）。多字段一起提交时先整体校验，任一字段不合法则不写入任何字段。成功后写审计 `group.update`，记录本次修改的字段名，不记录字段值。

### `POST /groups/{id}/bindings`

角色：admin / supervisor（`patient.write`）。请求三选一：

```json
{ "memberId": "gm_..." }
```

```json
{ "patientId": "pat_..." }
```

```json
{ "newPatient": { "displayName": "周先生", "tags": ["作息"], "consent": "unknown" } }
```

`memberId` 是「开始服务」的指定服务对象：

- 只能是该群的**外部成员**；员工成员或未知成员返回 `422 VALIDATION_FAILED`；
- 该 `externalUserId` 已有患者时**直接复用**（一个客户多个群共用一位患者 / 一个 Agent），不会重复建档；
- 没有患者时按成员昵称建档，`advisorId` 取群当前负责顾问，并把患者身份指向该成员（`identityStatus=confirmed`、`identitySource=manual`、同意状态跟随成员）；
- 身份回填失败不回滚绑定（可在患者详情重新确认）。

响应 `201`：`{ "binding": { "id": "gbd_...", "groupId": "grp_...", "patientId": "pat_...", "isPrimary": true, "createdAt": 1762646400000, "deletedAt": null }, "patient": { "id": "pat_...", "displayName": "周先生" } }`。

错误：`CONFLICT`（该群已绑定该患者）、`404 NOT_FOUND`（群或患者不存在）、`422 VALIDATION_FAILED`（成员不存在 / 非外部成员 / 无绑定参数）。

### `DELETE /groups/{id}/bindings/{patientId}`

角色：admin / supervisor。软删除绑定；响应 `204`。

### `GET /groups/{id}/members`

角色：全部。响应 `200`：

```json
{
  "items": [
    { "id": "gm_...", "groupId": "grp_...", "externalUserId": "wm...", "externalUserIdTail": "a1b2c3", "displayName": "张女士", "isExternal": true, "staffUserId": null, "role": "self", "consent": "agreed", "lastActiveAt": 1762645800000, "annotatedBy": "acc_...", "annotatedAt": 1762000000000 },
    { "id": "gm_...", "groupId": "grp_...", "externalUserId": "wm...", "externalUserIdTail": "d4e5f6", "displayName": "张女士的女儿", "isExternal": true, "staffUserId": null, "role": "family", "consent": "agreed", "lastActiveAt": 1762000000000, "annotatedBy": "acc_...", "annotatedAt": 1762000000000 },
    { "id": "gm_...", "groupId": "grp_...", "externalUserId": null, "externalUserIdTail": null, "displayName": "李顾问", "isExternal": false, "staffUserId": "li.guwen", "role": "advisor", "consent": "agreed", "lastActiveAt": 1762646060000, "annotatedBy": null, "annotatedAt": null }
  ],
  "total": 3
}
```

### `PATCH /groups/{id}/members/{memberId}`

角色：admin / supervisor。请求 `{ "role": "family" }`。仅允许修改外部成员的 `role`（`self` / `family` / `unknown`）；内部员工角色由系统判定，传其他值返回 `422`。响应 `200`：group_member，写审计 `group.member.annotate`。

---

## 8. 顾问

### `GET /advisors?status=`

角色：全部。响应 `200`：

```json
{
  "items": [
    { "id": "adv_01j9zc3d4e5f6g7h8j9k0m1n2p", "tenantId": "tn_...", "wecomUserId": "li.guwen", "name": "李顾问", "status": "active", "seatExpireAt": 1794067200000, "chatBound": true, "online": true, "queueDepth": 1, "consecutiveMisroutes": 0, "pausedAt": null, "createdAt": 1759500000000, "updatedAt": 1762645800000 }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 3
}
```

### `POST /advisors`

角色：admin。请求：`{ "wecomUserId": "wang.guwen", "name": "王顾问", "seatExpireAt": 1794067200000 }`。响应 `201`：advisor。

### `PATCH /advisors/{id}`

角色：admin。请求（可选）：`name`、`seatExpireAt`、`status`。响应 `200`：advisor。`status=left` 前必须没有进行中草稿，否则 `409`。

### `POST /advisors/{id}/pause`

角色：admin / supervisor。请求 `{ "reason": "手动暂停" }`（可选）。响应 `200`：advisor（`status=paused`）。写审计 `advisor.pause`。

### `POST /advisors/{id}/resume`

角色：admin / supervisor。响应 `200`：advisor（`status=active`、`consecutiveMisroutes=0`）。写审计 `advisor.resume`。

### `POST /advisors/{id}/queue/release`

角色：admin / supervisor。把当前阻塞的草稿置为 `RELEASED`，推下一条。响应 `200`：

```json
{ "releasedDraftId": "draft_1005", "nextDraftId": "draft_1006" }
```

### `GET /advisors/{id}/performance?range=week`

角色：全部。B 档，响应 `200`：`{ "items": [...], "sample": true }`。前端显示示例数据标签。

---

## 9. 质检与告警

### `GET /alerts?kind=&status=&advisorId=&patientId=&from=&to=&page=`

角色：全部。默认按 `createdAt` 倒序，排除沙盒。响应 `200`：`{ "items": [alert], ... }`。

### `GET /alerts/unresolved-count`

角色：全部。响应 `200`：`{ "open": 2, "acknowledged": 1, "total": 3 }`。菜单角标用 SSE `alert.*` 增量更新，打开页面时调此接口校准。

### `GET /alerts/{id}`

角色：全部。响应 `200`：

```json
{
  "alert": { "id": "alt_...", "kind": "misroute", "severity": "critical", "status": "open", "title": "发错群", "message": "草稿发到了「减重-刘先生」", "draftId": "draft_1003", "patientId": "pat_...", "advisorId": "adv_...", "groupId": "grp_...", "note": null, "resolvedBy": null, "resolvedAt": null, "escalatedTo": null, "createdAt": 1762640000000, "updatedAt": 1762640000000, "sandbox": false },
  "draft": { "id": "draft_1003", "summary": "晚上吃点什么好", "status": "MISROUTE_ALERT", "riskLevel": "low" },
  "patient": { "id": "pat_...", "displayName": "孙女士" },
  "advisor": { "id": "adv_...", "name": "李顾问" }
}
```

### `POST /alerts/{id}/resolve`

角色：admin / supervisor。请求 `{ "note": "已电话提醒顾问" }`（必填，≤ 200 字）。响应 `200`：alert（`status=resolved`）。写审计 `alert.resolve`。已解决返回 `409`。

### `POST /alerts/{id}/release-queue`

角色：admin / supervisor。响应 `200`：`{ "alert": { ... }, "releasedDraftId": "draft_1005", "nextDraftId": "draft_1006" }`。写审计 `advisor.queue.release`。

### `POST /alerts/{id}/restore-advisor`

角色：admin / supervisor。解除 `ADVISOR_PAUSED`。响应 `200`：`{ "alert": { ... }, "advisor": { ... } }`。写审计 `advisor.resume`。

---

## 10. 知识库 / 风险规则 / 话术库

### `GET /knowledge?category=&enabled=&q=&page=`

角色：全部。响应 `200`：`{ "items": [knowledge], ... }`，按 `category`、`title` 排序。

### `GET /knowledge/categories`

角色：全部。响应 `200`：

```json
{ "items": [{ "category": "饮食建议", "count": 8 }, { "category": "作息管理", "count": 5 }] }
```

### `POST /knowledge`

角色：admin。请求：`{ "category": "饮食建议", "title": "晚餐建议在 19 点前完成", "content": "……", "enabled": true }`。响应 `201`：knowledge。保存后重新生成 skill 资源，下一轮生效。

### `PATCH /knowledge/{id}`

角色：admin。请求：`category`、`title`、`content`、`enabled`。响应 `200`：knowledge。

### `DELETE /knowledge/{id}`

角色：admin。软删除；响应 `204`。

### `GET /risk-rules?kind=&enabled=`

角色：全部。响应 `200`：`{ "items": [risk_rule], "total": 7 }`。`builtin=true` 的红线只读。

### `POST /risk-rules`

角色：admin。只能创建 `kind="keyword"`：

```json
{ "kind": "keyword", "name": "急症-胸痛", "keywords": ["胸口痛", "胸痛"], "riskLevel": "high", "action": "escalate", "enabled": true }
```

响应 `201`：risk_rule。`kind="redline"` 返回 `422`。

### `PATCH /risk-rules/{id}`

角色：admin。请求：`name`、`keywords`、`riskLevel`、`action`、`enabled`。内置规则返回 `409 BUILTIN_RULE`。响应 `200`：risk_rule。

### `DELETE /risk-rules/{id}`

角色：admin。内置规则 `409 BUILTIN_RULE`；关键词规则响应 `204`。

### `GET /scripts?category=`

角色：全部。B 档。响应 `200`：`{ "items": [script_template], "total": 8, "sample": true }`。前端显示示例数据标签。

---

## 11. 技能市场与方案包

### `GET /skills`

角色：全部。响应 `200`：

```json
{
  "installed": [
    { "id": "skl_zhiban-wecom", "name": "企微服务通道", "description": "存档轮询、机器人推送、回读核验", "version": "1.0.0", "status": "enabled", "pluginId": "zhiban-wecom", "capabilities": ["archive", "bot", "verify"], "tier": "A" },
    { "id": "skl_zhiban-memory", "name": "长期记忆", "description": "抽取、注入、可查可改可删", "version": "1.0.0", "status": "enabled", "pluginId": "zhiban-memory", "capabilities": ["memory"], "tier": "A" },
    { "id": "skl_zhiban-care", "name": "主动关怀", "description": "按计划主动起草关怀消息", "version": "1.0.0", "status": "enabled", "pluginId": "zhiban-care", "capabilities": ["schedule"], "tier": "A" },
    { "id": "skl_zhiban-guard", "name": "健康红线", "description": "不诊断、不调药、不承诺疗效、急症引导就医", "version": "1.0.0", "status": "enabled", "pluginId": "zhiban-guard", "capabilities": ["risk"], "tier": "A" },
    { "id": "skl_zhiban-knowledge", "name": "知识问答", "description": "机构知识条目与命中统计", "version": "1.0.0", "status": "enabled", "pluginId": "zhiban-knowledge", "capabilities": ["knowledge"], "tier": "A" },
    { "id": "skl_meal-vision", "name": "餐食图片识别", "description": "识别食物、结合记忆点评、沉淀饮食记录", "version": "1.0.0", "status": "enabled", "pluginId": "zhiban-guard", "capabilities": ["vision", "meal_log"], "tier": "A" }
  ],
  "upcoming": [
    { "id": "skl_report-reading", "name": "体检报告解读", "description": "即将上线", "version": null, "status": "coming_soon", "pluginId": null, "capabilities": [], "tier": "C" },
    { "id": "skl_appointment", "name": "预约提醒", "description": "即将上线", "version": null, "status": "coming_soon", "pluginId": null, "capabilities": [], "tier": "C" },
    { "id": "skl-device", "name": "智能设备数据接入", "description": "血糖 / 血压设备直连", "version": null, "status": "coming_soon", "pluginId": null, "capabilities": [], "tier": "C" },
    { "id": "skl-miniapp", "name": "患者端小程序直连", "description": "即将上线", "version": null, "status": "coming_soon", "pluginId": null, "capabilities": [], "tier": "C" }
  ]
}
```

`installed` 来自 DSH 插件清单（#30 验证的读取能力），不是静态写死；`upcoming` 为静态配置。

### `GET /solution-packs`

角色：全部。响应 `200`：`{ "items": [solution_pack], "total": 6 }`。P1 只有「健康调理服务」为 `enabled`，其余 `coming_soon`。

---

## 12. 体验沙盒

所有沙盒接口角色：全部。数据带 `sandbox=true`，不计入统计。

### `POST /sandbox/session`

创建或恢复当前账号的沙盒会话。响应 `200`：

```json
{
  "session": {
    "id": "sbx_01j9zf6g7h8j9k0m1n2p3q4r5s",
    "patient": { "id": "pat_sandbox_acc_...", "displayName": "体验患者", "demo": false },
    "groups": [
      { "id": "grp_sandbox_1", "name": "体验客户群", "role": "primary" },
      { "id": "grp_sandbox_2", "name": "另一个客户群", "role": "other" }
    ],
    "createdAt": 1762640000000,
    "lastActiveAt": 1762646400000
  },
  "presets": [
    { "id": "preset_allergy", "label": "我对海鲜过敏", "kind": "text" },
    { "id": "preset_dinner", "label": "晚上吃什么好", "kind": "text" },
    { "id": "preset_meal_photo", "label": "发一张餐食照片", "kind": "image", "mediaId": "med_sample_meal_01" }
  ],
  "guideSteps": [
    { "step": 1, "title": "告诉 Agent 一件重要的事", "hint": "点击「我对海鲜过敏」" },
    { "step": 2, "title": "看记忆面板", "hint": "右侧出现一条饮食禁忌记忆" },
    { "step": 3, "title": "问一个相关问题", "hint": "点击「晚上吃什么好」，草稿会避开海鲜" },
    { "step": 4, "title": "试试四种发送方式", "hint": "照发 / 改写后发 / 发到别的群 / 只点已发送" }
  ],
  "quota": { "dailyLimit": 100, "usedToday": 6, "remaining": 94 }
}
```

### `GET /sandbox/session`

响应 `200`：同上（无 `presets` / `guideSteps` 时可只返回 session + quota）。

### `POST /sandbox/session/reset`

清空该账号的沙盒患者、记忆、草稿、核验与事件。响应 `200`：新的 session + `quota`。

### `POST /sandbox/messages`

模拟客户在群里发消息。请求：

```json
{ "kind": "text", "text": "我对海鲜过敏" }
```

```json
{ "kind": "image", "mediaId": "med_..." }
```

响应 `202`：

```json
{ "messageId": "msg_sbx_01j9...", "acceptedAt": 1762646400000, "quota": { "usedToday": 7, "remaining": 93 } }
```

Agent 回合异步进行，结果通过 SSE `sandbox.*` 推送；无 SSE 时用 `GET /sandbox/state` 轮询。超限 `429 LIMIT_EXCEEDED`。

### `GET /sandbox/state?since=`

轮询兜底。响应 `200`：

```json
{
  "session": { "id": "sbx_...", "lastActiveAt": 1762646400000 },
  "messages": [{ "id": "msg_sbx_...", "at": 1762646400000, "sender": "customer", "kind": "text", "text": "我对海鲜过敏" }],
  "memories": [{ "id": "mem_...", "category": "dietary_taboo", "content": "对海鲜过敏", "createdAt": 1762646410000 }],
  "drafts": [{ "id": "draft_...", "version": 1, "body": "……", "status": "PUSHED", "createdAt": 1762646420000 }],
  "verification": null,
  "events": [{ "id": "evt_...", "type": "memory.created", "at": 1762646410000, "data": {} }],
  "quota": { "dailyLimit": 100, "usedToday": 7, "remaining": 93 }
}
```

`since` 为毫秒时间戳，只返回该时刻之后的事件。

### `POST /sandbox/drafts/{draftId}/actions`

模拟顾问在手机上的四种操作。请求：

```json
{ "action": "send_original" }
```

```json
{ "action": "send_edited", "editedBody": "晚上建议吃得清淡一些…" }
```

```json
{ "action": "send_wrong_group", "targetGroupId": "grp_sandbox_2" }
```

```json
{ "action": "ack_only" }
```

| action | 产生 outcome |
|---|---|
| `send_original` | `verified` |
| `send_edited` | `edit_sent` |
| `send_wrong_group` | `misroute` |
| `ack_only` | `unverified` |

响应 `200`：

```json
{
  "outcome": "verified",
  "draftStatus": "VERIFIED",
  "verification": { "id": "vrf_...", "outcome": "verified", "matchedMsgId": "msg_sbx_...", "matchedRoomId": "grp_sandbox_1", "matchedGroupName": "体验客户群", "similarity": 1, "attempts": 1, "checkedAt": 1762646480000, "sandbox": true }
}
```

错误：`NOT_FOUND`（草稿不属于本账号沙盒）、`CONFLICT`（已终态）。

### `POST /sandbox/uploads`

`multipart/form-data`，字段 `file`（JPG / PNG，≤ 10 MB）。响应 `201`：

```json
{ "mediaId": "med_sbx_...", "url": "/zhiban/api/media/med_sbx_...", "width": 1280, "height": 960, "size": 284123 }
```

---

## 13. 媒体

### `GET /media/{mediaId}`

角色：登录用户。返回二进制，`Content-Type` 按实际类型，`Cache-Control: private, max-age=300`。

- 未登录：`401 UNAUTHORIZED`。
- 跨租户：`404 NOT_FOUND`。
- 沙盒媒体只能由创建它的账号读取。
- 前端 `<img>` 直接使用此地址，不暴露磁盘路径（#57）。

---

## 14. 账号 / 审计 / 安全 / 开通

### `GET /accounts?role=&status=`

角色：admin。响应 `200`：`{ "items": [account], ... }`，不含 `platform` 账号与密码哈希。

### `POST /accounts`

角色：admin。请求：`{ "username": "wang.guwen", "displayName": "王顾问", "role": "supervisor", "password": "**********" }`。响应 `201`：account。错误：`CONFLICT`（用户名重复）。

### `PATCH /accounts/{id}`

角色：admin。请求：`displayName`、`role`、`status`。不能停用或降级自己（`409`）。响应 `200`：account。

### `POST /accounts/{id}/reset-password`

角色：admin。请求 `{ "newPassword": "**********" }`。响应 `204`。写审计 `account.reset_password`。

### `DELETE /accounts/{id}`

角色：admin。软删除；不能删除自己（`409`）。响应 `204`。

### `GET /accounts/permission-matrix`

角色：全部。响应 `200`：§1.6 的机器可读版本：

```json
{
  "roles": [
    { "role": "admin", "label": "机构管理员", "permissions": ["*"] },
    { "role": "supervisor", "label": "主管", "permissions": ["patient.read", "patient.write", "draft.read", "alert.write", "advisor.operate", "audit.read", "export"] },
    { "role": "viewer", "label": "只读", "permissions": ["patient.read", "draft.read", "alert.read", "audit.read"] }
  ]
}
```

### `GET /audit?actorType=&actorId=&action=&targetType=&targetId=&result=&from=&to=&page=`

角色：全部。响应 `200`：`{ "items": [audit_event], ... }`，按 `at` 倒序。`detail` 已脱敏。

### `GET /audit/export.csv?<同上筛选>`

角色：admin / supervisor。响应 `200 text/csv; charset=utf-8`（带 BOM，Excel 中文正常）。写审计 `audit.export`。

### `GET /settings/wecom/status`

角色：全部。响应 `200`：

```json
{
  "archive": { "status": "green", "lastPolledAt": 1762646390000, "lastSeq": 128431, "lagSeconds": 4, "message": "正常" },
  "bot": { "status": "green", "connectedSince": 1762600000000, "lastDisconnectAt": null, "message": "长连接正常" },
  "host": { "status": "green", "uptimeSeconds": 86400, "version": "0.2.1-rc.5", "message": "运行中" },
  "seat": { "purchased": 1, "expiresAt": 1794067200000, "message": "1 个席位，2026-11-08 到期" },
  "checkedAt": 1762646400000
}
```

`status`：`green` / `yellow` / `red`。停止长连接后 30 秒内变红（#51）。

### `GET /settings/model`

角色：全部。响应 `200`：

```json
{ "model": "deepseek-v4.1-flash", "callsToday": 142, "avgLatencyMs": 3120, "fallbackCount": 3, "estimatedCostYuanToday": 0.86, "updatedAt": 1762646400000 }
```

### `GET /settings/security`

角色：全部（`tenant.read`）。响应 `200`：

```json
{
  "deployment": {
    "dataRegion": "中国大陆（腾讯云）",
    "modelRegion": "中国大陆",
    "modelService": "DeepSeek（境内）",
    "transport": "HTTPS（Secure Cookie）",
    "retentionNotice": "按合同约定；当前演示环境不自动删除",
    "dataStores": ["DSH 领域存储（业务数据与审计）", "沙盒与图片文件：/srv/zhiban/media", "企微会话存档（原文与实发核验）"]
  },
  "retention": { "notice": "按合同约定；当前演示环境不自动删除", "autoDelete": false },
  "roles": ["admin", "supervisor", "viewer"],
  "access": { "roles": [{ "role": "viewer", "label": "只读", "permissions": ["tenant.read"] }] },
  "audit": { "enabled": true, "exportable": true, "retention": "不自动删除", "events30d": 42, "exports30d": 3, "lastExportAt": 1762646400000 },
  "consent": { "agreed": 6, "unknown": 3, "disagreed": 1, "total": 10 },
  "pdf": { "fontConfigured": true },
  "generatedAt": 1762646400000
}
```

内容必须是真实部署事实：`deployment` 来自 zhiban-console 插件配置（`deployment.region` / `deployment.modelRegion` / `deployment.modelService`），`deployment.transport` 按 `cookieSecure` 判定；`retentionNotice` 直接来自 `tenant.settings`；`consent` 来自患者领域实时统计（患者插件未就绪时为 `null`）；`audit` 计数取最近 30 天的审计事件与导出动作（`evidence.export` / `records.export` / `audit.export`）；`pdf.fontConfigured` 表示部署机是否找到可用于 PDF 的中文字体。

相对 P1 初版契约，本接口新增了 `deployment.modelService` / `dataStores`、`retention`、`access`、`audit` 的近 30 天计数与 `pdf` 字段；原有字段保持不变。

### `GET /settings/onboarding`

角色：全部。响应 `200`：

```json
{
  "prerequisites": [
    { "id": "verify-subject", "title": "企微主体已认证", "owner": "customer", "days": 0, "materials": ["营业执照"] },
    { "id": "buy-archive", "title": "购买会话存档席位（按顾问人数）", "owner": "customer", "days": 1, "materials": ["顾问名单"] },
    { "id": "create-app", "title": "创建自建应用并授权客户群接口", "owner": "customer", "days": 1, "materials": ["企微管理员账号"] },
    { "id": "trusted-ip", "title": "配置可信 IP", "owner": "both", "days": 0, "materials": ["服务器公网 IP"] },
    { "id": "advisor-consent", "title": "顾问知情与授权", "owner": "customer", "days": 0, "materials": [] },
    { "id": "patient-consent", "title": "患者存档同意告知", "owner": "customer", "days": 1, "materials": ["告知话术"] }
  ],
  "timeline": { "minWorkdays": 3, "maxWorkdays": 5, "summary": "材料齐全后约 3–5 个工作日" },
  "pricing": { "archiveSeatPriceYuan": 900, "platformFeeText": "按方案报价", "currency": "CNY" },
  "entryPoints": ["工作台价值条下方引导卡片", "系统设置 → 开通正式服务"]
}
```

### `POST /settings/onboarding/requests`

角色：admin / supervisor（viewer `403`）。请求：

```json
{ "contactName": "赵经理", "contactPhone": "138****0000", "contactTitle": "运营负责人", "expectedAdvisors": 5, "expectedPatients": 200, "note": "希望下月上线", "consentToContact": true }
```

响应 `201`：onboarding_request。后端通过机器人通知我方负责人（#61），并写审计 `onboarding.submit`。

### `GET /settings/onboarding/requests?status=`

角色：admin。响应 `200`：`{ "items": [onboarding_request], ... }`。

### `PATCH /settings/onboarding/requests/{id}`

角色：`platform`。请求 `{ "status": "contacted" }`。响应 `200`：onboarding_request。租户角色调用返回 `404`。

---

## 15. SSE

### `GET /stream?types=draft.*,alert.*`

角色：登录用户。`text/event-stream`，连接保持；每 15 秒发送注释心跳 `: ping`。断线后前端重连，携带 `Last-Event-ID` 时服务端补发最近 5 分钟内的事件（内存环形缓冲，不保证跨重启）。

事件格式：

```text
id: evt_01j9zg7h8j9k0m1n2p3q4r5s6t
event: draft.pushed
data: {"id":"evt_...","type":"draft.pushed","at":1762646400000,"tenantId":"tn_...","sandbox":false,"data":{"draftId":"draft_1001","advisorId":"adv_...","status":"PUSHED"}}
```

`types` 支持前缀通配：`draft.*`、`sandbox.*`、`alert.*`。

| 事件 | 触发 | `data` |
|---|---|---|
| `draft.created` | Agent 产出草稿并入队 | `{ draftId, patientId, groupId, advisorId, source, riskLevel, status }` |
| `draft.pushed` | 卡片 + 正文推送到顾问 | `{ draftId, advisorId, status, cardTaskId }` |
| `draft.acked` | 顾问点「已发送 / 忽略」 | `{ draftId, advisorId, ackAction }` |
| `draft.revised` | 顾问指令触发的第 N 版 | `{ draftId, version, instruction }` |
| `draft.verified` | 核验完成 | `{ draftId, outcome, matchedGroupName?, similarity? }` |
| `draft.failed` | 推送失败 / 死信 / 释放 | `{ draftId, status, errorCode? }` |
| `draft.released` | 管理员释放队列 | `{ draftId, advisorId, nextDraftId? }` |
| `alert.created` | 新告警 | `alert`（完整实体） |
| `alert.updated` | 告警状态变化 | `alert` |
| `alert.resolved` | 告警处理完成 | `alert` |
| `patient.created` / `patient.updated` | 患者变化 | `patient` 摘要 |
| `memory.created` / `memory.updated` / `memory.deleted` | 记忆变化 | `{ memoryId, patientId, category, subject }` |
| `care_plan.created` / `care_plan.fired` / `care_plan.cancelled` | 计划变化 | `{ planId, patientId, status, when }` |
| `meal_log.created` | 饮食记录新增 | `{ mealLogId, patientId, mealType }` |
| `group.updated` | 群状态 / 名称 / 顾问变化 | `group` 摘要 |
| `group.member.updated` | 成员角色标注变化 | `{ groupId, memberId, role }` |
| `advisor.updated` | 顾问状态 / 队列变化 | `advisor` 摘要 |
| `system.status` | 接入状态变化（绿黄红） | `{ archive, bot, host, seat }` 摘要 |
| `sandbox.message` | 沙盒收到客户消息 | `{ sessionId, message }` |
| `sandbox.draft` | 沙盒草稿生成 / 推送 | `{ sessionId, draft }` |
| `sandbox.memory` | 沙盒记忆变化 | `{ sessionId, memory }` |
| `sandbox.verification` | 沙盒四种动作产生结果 | `{ sessionId, outcome, verification }` |
| `sandbox.state` | 沙盒状态快照（重置 / 大变化） | `{ sessionId }` |

- 单条 `data` 一律是完整 JSON（不是行分隔的多段）。
- 事件也写 `audit_event` 的关键动作不受影响；SSE 是通知通道，不是事实来源。前端断线重连后必须用 REST 拉一次当前状态。

---

## 16. 页面数据覆盖表

> 验收要求：P1-scope §4 的每个页面、每个区块都能在下表中找到数据来源。

| 页面 | 区块 | 数据来源 | 档 |
|---|---|---|---|
| 工作台 | 价值条 | `GET /dashboard/value` | A |
| 工作台 | KPI | `GET /dashboard/kpis` | A |
| 工作台 | 最近动态 | `GET /dashboard/recent` | A |
| 工作台 | 趋势图、排行 | `GET /dashboard/value` 的 `trend` / `advisorRanking` | A |
| 工作台 | 开通引导卡片 | `GET /settings/onboarding` | A |
| 患者 Agent | 卡片墙列表 | `GET /patients` | A |
| 患者 Agent 主页 | 基本信息、标签 | `GET /patients/{id}` | A |
| 患者 Agent 主页 | 记忆 | `GET /patients/{id}/memories` + `PATCH/DELETE /memories/{id}` | A |
| 患者 Agent 主页 | 主动计划 | `GET /patients/{id}/care-plans` + `POST` | A |
| 患者 Agent 主页 | 办事记录 | `GET /patients/{id}/actions` | A |
| 患者 Agent 主页 | 对话时间线 | `GET /patients/{id}/timeline` | A |
| 患者 Agent 主页 | 饮食记录 | `GET /patients/{id}/meal-logs`、`GET /media/{id}` | A |
| 患者 Agent 主页 | 健康档案 | `GET /patients/{id}/health-profile`（`sample:true`） | B |
| 患者 Agent 主页 | 服务计划 | `GET /patients/{id}/service-plan`（`sample:true`） | B |
| 实时服务流 | 列表 + SSE | `GET /service-flow`、`GET /stream` | A |
| 实时服务流 | 详情抽屉 | `GET /service-flow/{id}` | A |
| 实时服务流 | 图片缩略图 | `mediaKinds` + `GET /media/{id}` | A |
| 体验中心 | 沙盒全流程 | §12 全部接口 + `sandbox.*` SSE | A |
| 质检与告警 | 列表、详情 | `GET /alerts`、`GET /alerts/{id}` | A |
| 质检与告警 | 三种操作 | `resolve`、`release-queue`、`restore-advisor` | A |
| 质检与告警 | 菜单角标 | `GET /alerts/unresolved-count` + SSE | A |
| 服务群 | 列表、状态、改名、绑定 | §7 | A |
| 服务群 | 成员角色标注 | `GET/PATCH /groups/{id}/members` | A |
| 服务群 | 同意状态 | `group.consent` | A |
| 顾问 | 列表、席位、暂停恢复 | §8 | A |
| 顾问 | 绩效 | `GET /advisors/{id}/performance`（`sample:true`） | B |
| 健康打卡 | 整页 | C 档介绍页，无接口 | C |
| 排班与交接 | 整页 | C 档介绍页，无接口 | C |
| 知识库 | 分类、条目、命中 | §10 | A |
| 风险规则 | 红线只读 + 关键词 CRUD | `GET/POST/PATCH/DELETE /risk-rules` | A |
| 话术库 | 整页 | `GET /scripts`（`sample:true`） | B |
| 技能市场 | 已启用 / 即将上线 | `GET /skills` | A+C |
| 行业方案包 | 整页 | `GET /solution-packs` | B+C |
| 数据报表 | 整页 | `console/src/sample/` | B |
| 系统设置 · Agent 设定 | 表单 | `GET/PATCH /tenant` | A |
| 系统设置 · 企微接入状态 | 四盏灯 | `GET /settings/wecom/status` + SSE | A |
| 系统设置 · AI 模型 | 统计 | `GET /settings/model` | A |
| 系统设置 · 账号与角色 | 列表、权限矩阵 | §14 | A |
| 系统设置 · 审计日志 | 列表、导出 | `GET /audit`、`GET /audit/export.csv` | A |
| 系统设置 · 数据与安全 | 事实、同意统计 | `GET /settings/security` | A |
| 系统设置 · 数据与安全 | 证据 / 记录导出 | `GET /drafts/{id}/evidence.pdf`、`GET /patients/{id}/records.pdf` | A |
| 系统设置 · 开通正式服务 | 清单、计算器、申请 | `GET /settings/onboarding`、`POST /settings/onboarding/requests` | A |

**缺口检查**：P1-scope §4 的所有 A 档区块都有接口；B 档全部标注 `sample`；C 档不需要接口。语音 / 文件 / 视频只返回 `mediaKinds` 标记，不提供内容接口（P1 不做）。

---

## 17. Mock 与 fixtures

- fixtures 目录：`console/src/mock/fixtures/`，由本工作包维护；前端 mock 层（#42）直接加载。
- `manifest.json` 列出文件、实体、条数与契约版本；加载顺序按依赖：tenant → accounts → advisors → patients → groups → bindings → members → memories → care_plans → meal_logs → drafts → deliveries → verifications → alerts → knowledge → risk_rules → agent_actions → audit_events → onboarding_requests → skills → solution_packs → sse_events。
- **自洽要求**：所有外键都存在；`total` 与数组长度一致；价值看板数字可由 drafts/deliveries 复算；时间线递增；演示数据全部虚构，不出现真实姓名、手机号、健康档案。
- 图片：`photoUrl` 指向 `/zhiban/api/media/{mediaId}`，mock 层返回统一的占位图；不引用外网 URL。
- SSE：`sse_events.json` 提供一段可回放的事件序列，mock 层按 1.5–3 秒间隔推送，供 #43 演示动效。
- 前端切换真接口后，fixtures 保留用于组件测试。

| 文件 | 实体 | 条数 | 说明 |
|---|---|---|---|
| `tenant.json` | tenant | 1 | 虚构机构「安康健康管理中心」 |
| `accounts.json` | account | 3 | admin / supervisor / viewer |
| `advisors.json` | advisor | 3 | 含 1 位 paused |
| `patients.json` | patient | 6 | 2 位 `demo=true` |
| `groups.json` | group | 8 | serving ×6、collect_only ×1、pending ×1 |
| `group-bindings.json` | group_binding | 6 | 群 ↔ 患者 |
| `group-members.json` | group_member | 16 | 10 位外部成员，含家属标注、同意状态 |
| `memories.json` | memory | 9 | 覆盖 7 个分类 |
| `care-plans.json` | care_plan | 5 | pending / done / cancelled |
| `meal-logs.json` | meal_log | 4 | 含照片路径与置信度 |
| `drafts.json` | draft | 14 | 覆盖 10 种状态与三种采纳口径 |
| `deliveries.json` | delivery | 7 | 含 1 条发错群的 delivery |
| `verifications.json` | verification | 8 | verified ×5、edit_sent ×1、misroute ×1、unverified ×1 |
| `alerts.json` | alert | 5 | 覆盖 5 种类型 |
| `knowledge.json` | knowledge | 8 | |
| `risk-rules.json` | risk_rule | 7 | 4 条内置红线 + 3 条关键词 |
| `agent-actions.json` | agent_action | 10 | 覆盖各工具 |
| `audit-events.json` | audit_event | 12 | |
| `onboarding-requests.json` | onboarding_request | 1 | |
| `skills.json` | skill | 11 | 7 已启用 + 4 即将上线 |
| `solution-packs.json` | solution_pack | 6 | 1 启用 + 5 即将上线 |
| `scripts.json` | script_template | 8 | B 档，`sample:true` |
| `sse-events.json` | SSE | 10 | 服务流演示序列 |

---

## 18. 契约变更

1. **只做新增**：加接口、加字段、加枚举值。新增字段必须可空或有默认值。
2. 删改接口、字段或语义：先在 #62 评论说明原因与影响面，项目负责人确认后，同时更新本文与 [P1-data-model.md](./P1-data-model.md)，并更新 fixtures。
3. 后端实现与本契约不一致时，**以契约为准**；确认契约有误时按第 2 条走，不自行改实现。
4. 任何 PR 的「契约变更」一节必须列出：接口/字段、兼容性、需要前端配合的点。
5. P1 不引入 breaking change；确需 breaking 时新开 `/zhiban/api/v2`。
