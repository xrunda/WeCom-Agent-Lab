# 知伴健康患者端 H5 · API 契约

> 版本：**v0.1**（2026-11-25，草案）· 归属：PH5-01（#230）
> 依据：[患者端 H5 PRD v0.1](./PATIENT-H5-PRD.md) §5–§13 · 配套：[PATIENT-H5-data-model.md](./PATIENT-H5-data-model.md)（字段与枚举的唯一依据）
> 状态：**草案**，与 #229 范围闸门并行评审；「已审核内容 H5 发布规则」冻结后定稿。
>
> 患者端接口使用**独立前缀 `/zhiban/h5`**，与控制台（`/zhiban/api`）、侧边栏（`/zhiban/sidebar`）并列，不复用任一会话。团队配套接口挂在现有 `/zhiban/api` 下，由同一批新增路由承载，控制台前端调用。
> 字段以数据模型文档为准；示例数据全部虚构。现有 P1 接口**零改动**，本文全部为新增。

---

## 1. 通用约定

### 1.1 地址与前缀

| 前缀 | 使用者 | 认证 |
|---|---|---|
| `/zhiban/h5` | 患者 H5 | Cookie `zb_h5_session`（独立签发） |
| `/zhiban/api/...`（本文 §12 新增路径） | 控制台团队端 | 现有 `zhiban_session` |

- 除特别说明外 `Content-Type: application/json; charset=utf-8`，`Cache-Control: no-store`（媒体 `private, max-age=300`）。
- 静态页面由 nginx 在 `/h5/` 提供，API 反代到 DSH 插件注册的路由（同 `/zhiban/sidebar` 模式）。

### 1.2 认证与会话

- 会话签发：邀请兑换（§2.2）或绑定手机号登录（§2.4）。Cookie：`zb_h5_session=<opaque>; Path=/zhiban/h5; HttpOnly; Secure; SameSite=Lax`。
- 有效期：绝对 7 天、空闲 24 小时（配置 `session.absoluteTtlMs` / `session.idleTtlMs`）；服务端可随时撤销（授权撤回、解绑、服务停止、团队吊销）。
- 变更类请求（POST/PATCH/DELETE）校验 `Origin` 与 H5 域名一致，否则 `403 FORBIDDEN`。
- 不提供 Bearer Token、不提供跨域 API。登录态判断用 `GET /auth/session`，不用推测。
- **患者会话与员工会话完全隔离**：控制台 Cookie 不能调患者接口，反之亦然。

### 1.3 请求与响应头

沿用 P1-api §1.3：`X-Request-Id`（响应必带）、`Idempotency-Key`（患者写接口，24h 窗口，见数据模型 §1.4）、`Retry-After`（429）。

### 1.4 分页、筛选与排序

沿用 P1-api §1.5（`page` / `pageSize` ≤ 100 / `items` 包装 / `sort=-createdAt` / `from`、`to` 毫秒时间戳开区间）。患者端日期筛选用 `from` / `to`；按天查询用 `date=YYYY-MM-DD`（本地日期，Asia/Shanghai）。

### 1.5 错误格式

沿用 P1-api §1.4 的 `{ error: { code, message, details, requestId } }`。新增错误码：

| code | HTTP | 含义 |
|---|---|---|
| `INVITATION_NOT_FOUND` | 404 | 邀请不存在或已被使用/撤销（不区分，防探测） |
| `INVITATION_EXPIRED` | 410 | 邀请已过期（可提示联系顾问重新办理） |
| `PHONE_MISMATCH` | 422 | 手机号与预绑定不一致 |
| `VERIFY_CODE_INVALID` | 422 | 验证码错误或已过期 |
| `SMS_UNAVAILABLE` | 503 | 短信资源未配置/不可用——真实登录阻塞，不得用演示账号顶替 |
| `CONSENT_REQUIRED` | 403 | 需要相应分项授权（`details[0].scope` 给出缺的 scope） |
| `SERVICE_PAUSED` | 403 | 患者服务已暂停（只读降级由 `GET /me` 表达，写接口拒绝） |
| `PLAN_NOT_AVAILABLE` | 404 | 无已发布计划（配合 `GET /me` 的状态展示） |
| `PLAN_VERSION_CONFLICT` | 409 | 并发发布/编辑冲突（版本已被他人变更） |
| `ITEM_NOT_MODIFIABLE` | 409 | 未来事项不能提前确认完成；或已取消事项不可反馈 |
| `RECORD_IMMUTABLE` | 409 | 记录处于不可更正状态（删除申请处理中） |
| `FOLLOWUP_CLOSED` | 409 | 跟进请求已处理，不能再认领 |
| `MEDIA_NOT_FOUND` | 404 | 媒体不存在或不属于本人（不暴露存在性） |
| `RATE_LIMITED` | 429 | 沿用（含短信、兑换尝试） |

通用沿用 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `VALIDATION_FAILED` / `CONFLICT` / `UPSTREAM_UNAVAILABLE` / `INTERNAL`。

### 1.6 限流

| 范围 | 限制 | 超限 |
|---|---|---|
| 验证码发送 | 同手机号 1 条/分钟、5 条/天；同 IP 20 条/天 | `429 RATE_LIMITED` |
| 邀请兑换尝试 | 同邀请 5 次失败锁定；同 IP 30 次/小时 | `429 RATE_LIMITED` |
| 患者业务接口 | 每会话 60 次/分钟 | `429 RATE_LIMITED` |
| 照片上传 | 每患者 30 张/天；单张 ≤10MB | `429 RATE_LIMITED` / `422` |
| 埋点上报 | 每会话 120 条/小时（超出静默丢弃，不报错） | 200 照常返回 |

### 1.7 安全约定（PRD §13 的落地）

- 所有患者接口的服务端鉴权以会话推导 `tenantId + patientId`；**请求参数里的患者标识一律忽略并记审计**（改 URL 参数读他人数据 → `404`，A01）。
- 邀请参数兑换后前端清理 URL（`history.replaceState`）；邀请 code 不进埋点、错误日志、来源字段。
- 日志不记健康正文、照片内容、手机号、令牌；`X-Request-Id` 与审计 id 可关联排障。
- 图片上传：魔数校验（扩展名不可信）、MIME 白名单、剥离 EXIF GPS、服务端压缩；不存公开静态目录。

---

## 2. 邀请、登录与会话

### 2.1 `POST /zhiban/h5/auth/verify-code`

角色：公开（限流生效）。发送短信验证码。

```json
{ "phone": "138****" }
```

- 首次兑换流程：携带 `invitationCode`，向邀请预绑定手机号发送（`phone` 只用于展示掩码确认，实际以预绑定为收件人）。
- 绑定后再次登录：`phone` 为绑定手机号本身。
- 短信资源未配置时返回 `503 SMS_UNAVAILABLE`，`message` 说明「短信通道未开通，真实登录暂不可用」——**不得**回退到无验证码模式承载真实数据。
- 响应 `202`：`{ "phoneTail": "3421", "expiresIn": 300, "resendAfter": 60 }`。响应不含完整手机号。

### 2.2 `POST /zhiban/h5/auth/redeem`（首次：邀请 + 手机号 + 验证码）

角色：公开。

```json
{ "invitationCode": "pinv_opaque...", "phone": "13800003421", "code": "4832" }
```

成功 `200`：

```json
{
  "session": { "patientId": "pat_01j9...", "expiresAt": 1762646400000 },
  "binding": { "phoneTail": "3421", "boundAt": 1762646400000 },
  "me": { "status": "profile_incomplete", "next": "/profile/onboarding" }
}
```

并 `Set-Cookie: zb_h5_session=...`。

- 幂等语义：`pending → used` 只发生一次；重放返回 `404 INVITATION_NOT_FOUND`。
- 错误：`INVITATION_NOT_FOUND`（不存在/已用/已撤销）、`INVITATION_EXPIRED`、`PHONE_MISMATCH`、`VERIFY_CODE_INVALID`、`RATE_LIMITED`、`SMS_UNAVAILABLE`；患者 `status != serving` 或租户停用时 `403 SERVICE_PAUSED`（邀请保持 pending）。
- 成功写 `h5_audit(h5.session.issue)`；失败只记错误类型与邀请 id 尾号。

### 2.3 `GET /zhiban/h5/auth/session`

角色：患者会话。响应 `200`：

```json
{ "patientId": "pat_...", "issuedAt": 1762646400000, "expiresAt": 1763251200000, "lastSeenAt": 1762732800000 }
```

`401 UNAUTHORIZED`。会话被撤销、过期或从未登录都返回同一个码；需要区分时读
`error.details[0].reason`（`revoked` / `expired` / `missing`），前端据此决定是否提示「请重新验证身份」。

### 2.4 `POST /zhiban/h5/auth/login`（再次登录：手机号 + 验证码）

角色：公开。仅对已绑定（`h5_binding.status=bound`）患者可用。

```json
{ "phone": "13800003421", "code": "4832" }
```

- `phone` 与绑定手机号不符：`401`（不区分「未绑定/不匹配」，防探测）。
- 响应同 §2.2。**待决项**：该入口的安全评审（数据模型 §12.1）通过前，可配置 `patientLoginMode: "invite_only"` 关闭本接口（返回 `403`）。

### 2.5 `POST /zhiban/h5/auth/logout`

角色：患者会话。撤销当前会话，清 Cookie。响应 `204`。本地敏感缓存清理由前端执行（§11.5）。

### 2.6 `POST /zhiban/h5/auth/sessions/revoke-all`（可选增强，S 档）

患者踢出其他设备会话。响应 `204`。首期可不实现，契约预留。

---

## 3. 授权与隐私

### 3.1 `GET /zhiban/h5/consents`

角色：患者会话。响应 `200`：

```json
{
  "textsVersion": 3,
  "items": [
    { "scope": "service_basic", "status": "granted", "version": 3, "grantedAt": 1762646400000, "withdrawnAt": null,
      "title": "进入个人服务", "summary": "查看你的计划、日历和记录" },
    { "scope": "reminder", "status": "withdrawn", "version": 3, "grantedAt": 1762646400000, "withdrawnAt": 1762732800000,
      "title": "提醒触达", "summary": "顾问按你的计划发送提醒" }
  ]
}
```

- 文案来自租户配置 `h5.consentTexts`（title/summary 每 scope），版本号统一。
- 与企微存档同意分别记录的说明页文案由前端静态提供。

### 3.2 `POST /zhiban/h5/consents/decide`

角色：患者会话。请求：

```json
{ "scope": "reminder", "action": "grant" }
```

- `action`：`grant` / `withdraw`。
- 撤回效果按数据模型 §5 取消传播表**即时**执行（未发出提醒取消、识别停止等）；写 `h5_audit(h5.consent.grant|withdraw)`。
- 响应统一 `200`：`{ scope, status, version }`（更新后的 scope 项）。
- `service_basic` 撤回时**同样返回 `200`**，另带 `Set-Cookie: zb_h5_session=; Max-Age=0`；
  此请求之后该会话的所有接口返回 `401`。前端以响应体为准、以 `Set-Cookie` 判定是否回到登录态，
  不依赖 204。
- 幂等：重复同向决定返回当前状态（200），不重复执行传播。

### 3.3 `GET /zhiban/h5/privacy/summary`

角色：患者会话。响应 `200`：

```json
{
  "retentionNotice": "按合同约定；当前演示环境不自动删除",
  "requests": [ { "id": "prq_...", "kind": "export", "status": "submitted", "createdAt": 1762646400000 } ],
  "teamAccessScopes": ["health_processing", "team_access"]
}
```

### 3.4 `POST /zhiban/h5/privacy/requests`

角色：患者会话。请求：

```json
{ "kind": "correction", "targetType": "profile_entry", "targetId": "ppe_...", "detail": "写错了，希望更正" }
```

- `kind`：`export` / `correction` / `deletion`。`correction` 必带 `targetType`+`targetId`。
- 响应 `201`：privacy_request。团队端处理见 §12.7。
- `deletion` 提交后关联记录进入 `RECORD_IMMUTABLE` 保护（不再可患者更正），直至处理完成。

---

## 4. 我的与档案

### 4.1 `GET /zhiban/h5/me`

角色：患者会话（`service_basic`）。首屏路由与状态总览。响应 `200`：

```json
{
  "status": "plan_active",
  "profile": { "completeness": 0.6, "safetyMissing": false, "conflicts": [] },
  "plan": { "planId": "hpl_...", "version": 2, "status": "published", "endDate": "2026-12-28", "acknowledgedAt": null },
  "team": { "advisorName": "李顾问（虚构）", "duty": "工作日 09:00–18:00" },
  "reminderEnabled": true,
  "companionDays": 34,
  "serverTime": 1762646400000
}
```

`status` 枚举（H03/H04 无计划与状态覆盖的验收依据）：

| 值 | 含义 | 首页主行动 |
|---|---|---|
| `profile_incomplete` | 建档未完成 | 继续建档 |
| `data_pending` | 资料待补充（计划被阻塞，A03） | 补充资料 |
| `plan_generating` | 生成中 / 生成失败 / 待审核（对患者统一「准备中」） | 等待 + 联系团队 |
| `plan_active` | 已发布执行中 | 今日行动 |
| `plan_suspended` | 计划暂停 | 查看说明 + 联系团队 |
| `service_paused` | 服务暂停 | 只读 + 联系团队 |

- `safetyMissing` / `conflicts` 非空时前端**必须**先展示补充/确认引导（数据模型 §3.5 安全规则）。

### 4.2 `GET /zhiban/h5/profile`

角色：患者会话。响应 `200`：

```json
{
  "items": [
    { "id": "ppe_...", "fieldKey": "goal", "value": { "items": ["改善睡眠"] }, "valueText": "希望改善睡眠",
      "source": "patient", "status": "confirmed", "confirmedAt": null, "updatedAt": 1762646400000 },
    { "id": "ppe_...", "fieldKey": "allergy", "value": { "items": ["海鲜（自述）"], "unknown": false },
      "valueText": "海鲜（自述）", "source": "patient", "status": "confirmed", "updatedAt": 1762646400000 }
  ]
}
```

- 来源与确认状态**必须**展示（患者自述 ≠ 专业确认，A03/H02）。
- `agent` 来源且 `draft` 状态的条目标「待确认」，可确认或申请更正。

### 4.3 `PUT /zhiban/h5/profile/answers`

角色：患者会话。H02 分步建档提交。请求：

```json
{ "step": "basics", "answers": { "goal": { "items": ["改善睡眠"] }, "meal_times": { "breakfast": "07:00" } } }
```

- 按步提交（`step`：`basics` / `routine` / `food` / `safety` / `guidance`）；每步内字段整体替换，`source=patient`。
- 已有 `professional` 确认的同字段：并列为待确认条目，**不覆盖**（数据模型 §3.5）。
- 响应 `200`：更新后的条目列表 + `{ "completeness": 0.8, "safetyMissing": false }`。
- 幂等：`Idempotency-Key` + step；同 key 重复返回首次结果。

### 4.4 `POST /zhiban/h5/profile/confirm`

确认既有资料（「已有资料让患者确认或申请更正」）。请求 `{ "entryIds": ["ppe_..."] }` → 条目 `status=confirmed`（source 不变）。响应 `200`。

### 4.5 `POST /zhiban/h5/profile/corrections`

档案纠错申请 → 生成 `privacy_request(kind=correction)`（与 §3.4 同一队列）。请求 `{ "entryId": "ppe_...", "detail": "..." }`，响应 `201`。

---

## 5. 健康计划

### 5.1 `GET /zhiban/h5/plan/current`

角色：患者会话。**只返回已对患者可见的版本**（A04：未审核、`data_pending`、`generating`、`reviewing`、
`rejected` 一律不可见）。可见状态为 `published`、`suspended`（返回计划 + 暂停说明，前端展示暂停态）、
`ended`（最后有效版本，只读）——`suspended` 不能返回 404，否则患者看不到暂停说明（数据模型 §4.2/§5）。

- 无已发布计划：`404 PLAN_NOT_AVAILABLE`（前端配合 `GET /me` 的 status 展示「准备中」）。
- 响应 `200`：

```json
{
  "plan": {
    "id": "hpl_...", "version": 2, "stageGoal": "...", "startDate": "2026-12-01", "endDate": "2026-12-28",
    "foodTherapyRationale": "...", "focusPoints": ["晚餐清淡", "睡眠规律"],
    "actions": [ { "actionId": "act_1", "title": "晚餐清淡少油", "purpose": "...", "method": "...",
      "schedule": { "kind": "daily", "time": "18:30" }, "feedbackKind": "record_meal", "linkedArticleIds": ["art_..."] } ],
    "rationale": { "basedOn": ["你的目标：改善睡眠", "已确认习惯：22:30 入睡", "已审核食养原则：晚餐七分饱"],
      "ruleRefs": [ { "refType": "article", "refId": "art_...", "refVersion": 2 } ] },
    "review": { "reviewerName": "陈营养师（虚构）", "reviewedAt": 1762646400000 },
    "publishedAt": 1762646400000, "effectiveFrom": 1762646400000, "effectiveTo": null,
    "acknowledgedAt": null
  }
}
```

- `rationale` 是「为什么这样安排」的患者可读说明（依据个人目标/习惯/已审核原则），**不含内部提示词**（H04）。
- 换版后旧版走 §5.2；当前接口恒返回有效版本。

### 5.2 `GET /zhiban/h5/plan/versions/{version}`

角色：患者会话。历史版本（`superseded/ended`）只读。响应同上（含 `status`）。`404`：版本不存在。

### 5.3 `POST /zhiban/h5/plan/acknowledge`

「已了解计划」留痕。无请求体；响应 `200`：`{ "acknowledgedAt": 1762646400000 }`。重复调用幂等。写 `h5_audit` + `h5.plan_acknowledge` 事件。**不替代专业审核**。

### 5.4 `POST /zhiban/h5/plan/adjust-requests`

「计划不适合」调整申请（H04）。请求：

```json
{ "planVersion": 2, "message": "晚餐时间做不到 18:30，可以调整吗", "linkedActionId": "act_1" }
```

- 响应 `201`：followup_request（kind=plan_adjust）。团队处理后新版本仍走审核发布。
- 同版本重复提交：24h 内合并进同一请求（追加留言）。

---

## 6. 今天、日历与行动反馈

### 6.1 `GET /zhiban/h5/today`

角色：患者会话。今日聚合（H03）。响应 `200`：

```json
{
  "date": "2026-11-25",
  "greeting": "下午好",
  "nextItem": { "id": "cal_...", "title": "晚餐清淡少油", "scheduledAt": 1764181800000, "status": "pending" },
  "progress": { "done": 2, "missed": 0, "needsHelp": 0, "pending": 1, "total": 3 },
  "quickRecord": { "meal": true, "review": false },
  "relatedArticles": [ { "id": "art_...", "title": "晚餐七分饱的道理", "category": "classics_life" } ],
  "teamContact": { "advisorName": "李顾问（虚构）", "available": true },
  "allDone": false
}
```

- `progress` 只统计**当天已发布计划**的行动（自由记录不进分母，H03/A06）。
- `pending==0` 且当天有已发布事项：全部完成 → `allDone: true`，温和回顾文案（前端），不催办。`nextItem` 为空但 `pending>0` 表示数据异常，前端按「有未完成事项」展示，不显示完成态。
- 无计划时 `404 PLAN_NOT_AVAILABLE`（前端按 `/me` 状态展示准备中）。

### 6.2 `GET /zhiban/h5/calendar?from=&to=&date=`

角色：患者会话。周/日视图数据（H05）。

- `from`/`to`（毫秒，开区间）或 `date`（本地日期，返回该日 ±0）；默认本周（周一至周日，Asia/Shanghai）。
- 响应 `200`：

```json
{
  "days": [
    { "date": "2026-11-25", "items": [
      { "id": "cal_...", "title": "晚餐清淡少油", "purpose": "减少晚间油腻", "scheduledAt": 1764181800000,
        "status": "pending", "overdue": false, "feedbackKind": "record_meal", "cancelled": false, "cancelReason": null }
    ] }
  ],
  "from": 1764181800000, "to": 1764268200000
}
```

- 过去/今天/未来由前端按 `date` 与本地今天判断；`overdue` 服务端派生。

### 6.3 `GET /zhiban/h5/calendar/items/{id}`

角色：患者会话。事项详情（执行方式 + 反馈方式）。响应 `200`：calendar_item 完整体（含 `method`、`feedback`、`linkedArticles` 读时校验发布状态——retired 的显示 `{ "id": "art_...", "retired": true }` 不含正文，A09）。

### 6.4 `POST /zhiban/h5/calendar/items/{id}/feedback`

角色：患者会话。行动反馈（A06 核心验收）。请求：

```json
{ "kind": "missed", "reason": "聚餐了", "occurredAt": null, "recordId": null }
```

- `kind`：`patient_confirmed`（患者明确确认，对应数据模型 `feedback.kind`）/ `missed` / `needs_help`。
  **不要**传 `done`：数据模型 §3.7 的 `feedback.kind` 枚举是 `patient_confirmed` / `record_matched` / `missed` / `needs_help`；
  `record_matched` 由服务端在关联记录满足要求时回填，客户端不可直接提交。
- `done`：患者明确确认；可带 `recordId`（关联已保存记录）。
- `needs_help`：自动生成 followup（kind=need_help），响应 `201` 附 `{ "followupId": "fup_..." }`。
- 校验（`409 ITEM_NOT_MODIFIABLE`）：事项 `scheduledDate > 今天`（禁止提前完成）；`status=cancelled`（被取消事项不再可反馈，A05）；计划 `suspended`（展示说明但写被拒）。
- 历史补记：`occurredAt` 允许过去时刻，与 `submittedAt` 分别保存（A06）；过去日期补反馈合法（`pending+overdue` 的事项）。
- 更正：对已有反馈再次 POST → 写入 revisions，旧值保留（`409` 不需要，`200` 返回最新 feedback）。
- 幂等：`Idempotency-Key`；同 key 返回首次结果。

---

## 7. 记录（餐食、晚间回顾、随手记）

### 7.1 `POST /zhiban/h5/records`

角色：患者会话（`health_processing`）。创建记录（H06/H07）。**必须带 `Idempotency-Key`**（A07：同一请求重试不重复创建）。

```json
{
  "kind": "meal",
  "occurredAt": 1764181800000,
  "mealType": "dinner",
  "confirmedFoods": [ { "name": "清蒸鲈鱼（自填）", "portion": "适中" } ],
  "patientNotes": "在妈妈家吃的",
  "linkedCalendarItemId": "cal_..."
}
```

```json
{
  "kind": "evening_review",
  "occurredAt": 1764206100000,
  "overall": "fair",
  "mood": null,
  "sleep": "light",
  "bowel": null,
  "discomfort": "晚饭后有点胀",
  "notes": ""
}
```

- `occurredAt` 必填（默认前端填当前时刻；可补记历史，`occurredDate` 服务端派生）。
- evening_review 各项可空 = 跳过；**不预选**（前端不默认 normal，A08）。
- 同日已有回顾：返回 `200`（更新当日记录， revisions 保留），不新建。
- `discomfort` 命中风险规则 → 自动生成 followup（kind=risk，riskLevel 按规则最高级），响应附 `{ "riskFollowupId": "fup_..." }`；固定安全提示由前端按审核规则展示，紧急不适提示就医。
- 响应 `201`：patient_record 完整体（含 `recognition: { "status": "skipped" }` 当无图）。

### 7.2 `POST /zhiban/h5/records/{id}/photo`

角色：患者会话（`health_processing` + `photo_analysis`）。`multipart/form-data`，字段 `photo`。响应 `201`：

```json
{ "mediaId": "med_...", "recognition": { "status": "pending" } }
```

- 校验：魔数白名单、≤10MB、剥离 EXIF（服务端执行，A07）。
- 上传后异步识别：`recognition.status=pending → succeeded/failed/timeout`。
- 授权撤回 `photo_analysis` 后本接口 `403 CONSENT_REQUIRED`；已有照片可读。
- 上传失败（网络/超限）不阻塞：记录已在（7.1 先建后传），前端提示重试（A07）。

### 7.3 `GET /zhiban/h5/records/{id}`

角色：患者会话。详情（识别候选 + 确认结果 + 修订历史）。响应 `200`：patient_record。识别中返回当前 `recognition.status`，前端轮询 ≤3s；超过 60s 状态置 `timeout`。

### 7.4 `POST /zhiban/h5/records/{id}/confirm`

患者确认/修改识别候选（H06：确认、删除或补充）。请求：

```json
{ "confirmedFoods": [ { "name": "清蒸鲈鱼", "portion": "适中" }, { "name": "米饭", "portion": "少" } ] }
```

- 候选（aiCandidates）与确认结果（confirmedFoods）**分开保存**（A07）；响应 `200`：记录。
- 未确认的候选不进团队报表口径、不输出精确热量（首期不输出，PRD §6 H06）。

### 7.5 `GET /zhiban/h5/records?date=&from=&to=&kind=&page=`

角色：患者会话。按日查看（H09）。响应 `200`：`{ items: [patient_record], ... }`，按 `occurredAt` 倒序。

### 7.6 `PATCH /zhiban/h5/records/{id}`

更正（H09 历史更正）。请求同 7.1 的 content 字段子集（整体替换 kind 对应 content）。响应 `200`；旧值进 revisions。`409 RECORD_IMMUTABLE`：删除申请处理中。

### 7.7 `GET /zhiban/h5/media/{id}`

角色：患者会话。授权照片读取。`Cache-Control: private, max-age=300`，`Content-Type` 按魔数。`404 MEDIA_NOT_FOUND`（不存在或不属于本人，A01）。团队端读取走控制台媒体接口（§12.9）。

### 7.8 疑似重复

同日同餐（H5 与群 meal_log 并存）时，`GET /records` 与控制台列表返回 `duplication: { "suspectedIds": ["meal_..."], "status": "suspected" }`；确认结果由团队端写入（§12.6），患者端只读展示「团队核对中」。

---

## 8. 专业团队联系（H10）

### 8.1 `GET /zhiban/h5/team`

角色：患者会话。响应 `200`：

```json
{
  "advisor": { "name": "李顾问（虚构）", "role": "负责顾问" },
  "members": [ { "name": "陈营养师（虚构）", "role": "专业审核" } ],
  "serviceHours": "工作日 09:00–18:00（配置）",
  "requestCategories": [ { "key": "plan", "label": "计划问题" }, { "key": "record", "label": "记录问题" }, { "key": "other", "label": "其他" } ]
}
```

- 全部来自真实配置/名册，无静态假名单。

### 8.2 `POST /zhiban/h5/team/requests`

留言（可关联计划/事项，H10）。请求：

```json
{ "category": "plan", "message": "这周出差，晚餐时间不固定怎么办", "linkedPlanId": "hpl_...", "linkedCalendarItemId": null }
```

- 响应 `201`：followup_request（kind=question）。自动回执「已收到」（autoAckSentAt）**不算处理**（A11）。
- 幂等：`Idempotency-Key`。

### 8.3 `GET /zhiban/h5/team/requests/{id}` 与 `GET /zhiban/h5/team/requests?page=`

状态跟踪（待接收 → 跟进中 → 已处理）。响应含 `{ status, claimedAt, resolvedAt, assigneeName, escalated: false }`。H5 **不展示**答复正文（首期经企微会话人工送达），显示「请在服务会话查看答复」+ 返回指引（H10，不做唤起微信会话的承诺）。`404`：非本人请求。

---

## 9. 食养内容（公开 + 关联）

### 9.1 `GET /zhiban/h5/manifesto`（公开，无需登录）

食养主张（H01，可跳过引导）。响应 `200`：

```json
{
  "slogans": ["饮食有养", "起居有常", "健康有伴"],
  "sections": [
    { "kind": "classic_quote", "text": "五谷为养，五果为助", "citation": "《黄帝内经·素问》" },
    { "kind": "plain_explanation", "text": "主食养身，果菜辅助……" }
  ],
  "version": 2
}
```

- 经典引用逐字核对、带出处；白话与自拟文案结构上分离（A09）。
- 配图按 [素材清单](./design/patient-h5/ASSET-INVENTORY.md) 制作；未制作时占位，不用整页概念图。

### 9.2 `GET /zhiban/h5/articles?category=&page=`（公开）

分类浏览（H08）：`classics_life` / `ingredients` / `seasonal_living`。只返回 `published` 且未 `retired`。响应 `200`：`{ items: [{ id, title, summary, category, seasonTerm, coverUrl, microAction, scenarioTags, publishedAt }], ... }`。

- `microAction`：实践段首句（≤60 字），作为「今天可以做的一件小事」；无实践段为 `null`。
- `scenarioTags`：场景标签，前端与档案关键词匹配后决定是否放进「按你的情况」；匹配不上就整段不出现。
- `coverUrl`：列表配图；为 `null` 时前端用占位图。

- 分享预览只有标题/摘要，不含个人信息（A09）。

### 9.3 `GET /zhiban/h5/articles/{id}`（公开）

详情。响应 `200`：content_article（sections 含 kind 标注、citations、authorName、ingredientSafety）。`retired`：`404`，前端显示「内容已更新」（A09）。

- 已登录时附 `linkedToCurrentPlan: true/false`（场景标签匹配当前已发布计划）。

### 9.4 `GET /zhiban/h5/articles/related?context=plan|calendar_item`

角色：患者会话。计划/日历相关内容（H03/H04/H05 关联）。只返回 published；无适配内容返回 `{ "items": [] }`——**不强推**（PRD §9）。

---

## 10. 提醒偏好（H09）

### 10.1 `GET /zhiban/h5/reminder-prefs`

```json
{ "enabled": true, "dailyLimit": 2, "quietHours": { "start": "21:00", "end": "08:00" }, "gentleInquiry": true }
```

### 10.2 `PATCH /zhiban/h5/reminder-prefs`

可改：`enabled`（总开关=撤回 reminder scope 的快捷方式，走 §3.2 传播）、`quietHours`（只能更严于租户默认，服务端校验取交集）、`gentleInquiry`（关闭温和询问）。响应 `200`：更新后 prefs。变更即时作用于调度（A10）。

---

## 11. 埋点与杂项

### 11.1 `POST /zhiban/h5/events`

白名单事件（数据模型 §3.15）。请求 `{ "event": "h5.record_submit", "itemId": "rec_...", "durationMs": 42 }`；白名单外 `400 VALIDATION_FAILED`；超频静默丢弃返回 `200`。载荷不含健康正文/姓名/手机号。

### 11.2 `GET /zhiban/h5/health`（公开）

探活：`{ "ok": true, "at": 1762646400000 }`。

### 11.3 `GET /zhiban/h5/server-time`（公开）

`{ "serverTime": 1762646400000, "timezone": "Asia/Shanghai" }`。前端时钟对齐（日历切日判定兜底）。

---

## 12. 团队端接口（`/zhiban/api` 新增，控制台会话）

> 由同一患者 H5 后端插件注册，复用控制台认证与权限矩阵；权限列标注新增能力（数据模型 §6.3）。控制台前端页面归属后续工作包（PH5-02/04/07/08/09/10）。

### 12.1 邀请与绑定（`h5.invite.manage`；scope=self 限名下）

| 接口 | 说明 |
|---|---|
| `POST /patients/{id}/invitations` | 创建邀请：`{ "phone": "138...", "ttlHours": 24, "note": "" }` → `201` invitation（含 `link` 与 `code` 一次性返回，列表不再回 code） |
| `GET /patients/{id}/invitations` | 历史 + 状态（`phoneTail` 展示） |
| `POST /patient-invitations/{id}/revoke` | 撤销；`409`：非 pending |
| `GET /patients/{id}/h5-binding` | 绑定状态与会话列表（撤销入口） |
| `POST /patients/{id}/h5-binding/sessions/{sid}/revoke` | 吊销患者会话 |

- 邀请链接格式 `https://<h5-host>/h5/invite?code=<opaque>`；code 不落日志。
- 审计 `h5.invitation.create/revoke`。

### 12.2 计划工作台（读：`patient.read`；写：`h5.plan.review`）

| 接口 | 说明 |
|---|---|
| `GET /health-plans?patientId=&status=&page=` | 版本链列表（含草稿/审核/发布历史） |
| `GET /health-plans/{id}` | 完整定义 + inputSnapshot + ruleRefs + reviewHistory |
| `POST /patients/{id}/health-plans/generate` | 触发 AI 生成草稿（生成中异步；返回 `202 { planId }`）；资料缺失返回 `422` 并列缺失项（A03） |
| `PATCH /health-plans/{id}` | 编辑草稿/审核修改（reviewing 或 data_pending 的 manual 接管）；带 `expectedVersion` 乐观检查，冲突 `409 PLAN_VERSION_CONFLICT` |
| `POST /health-plans/{id}/submit-review` | 草稿 → reviewing |
| `POST /health-plans/{id}/reject` | 退回：`{ "note": "" }`；rejected 终态，新版本走 generate/manual |
| `POST /health-plans/{id}/publish` | 发布：事务内 supersede 旧版 + 取消传播（§5）；发布门禁见数据模型 §3.6；`409 PLAN_VERSION_CONFLICT`（并发发布或 review 非 approved） |
| `POST /health-plans/{id}/suspend` / `POST /health-plans/{id}/resume` | 暂停/恢复（传播见 §5） |
| `POST /health-plans/{id}/end` | 结束 |
| `GET /patients/{id}/h5-consents` | 分项授权状态（团队侧视角） |

- 发布/暂停/退回均写 `h5_audit`，`detail` 含版本与操作账号。
- 无 `h5.plan.review` 的账号调用写接口 → `403 FORBIDDEN`（不透露具体缺哪项能力之外的信息）。

### 12.3 日历与跟进（读：`patient.read`）

| 接口 | 说明 |
|---|---|
| `GET /patients/{id}/calendar-items?from=&to=&status=` | 团队侧日历（含 overdue 统计） |
| `POST /calendar-items/{id}/cancel` | 团队取消（`team_cancelled`，传播取消关联提醒）；`scope=self` 限名下 |
| `GET /followup-requests?status=&patientId=&kind=&page=` | 跟进队列（默认排序 `slaDueAt` 升序） |
| `POST /followup-requests/{id}/claim`（`h5.followup.handle`） | 认领（首次人工响应）；`409 FOLLOWUP_CLOSED`（并发认领） |
| `POST /followup-requests/{id}/resolve`（`h5.followup.handle`） | 处理完成：`{ "resolutionNote": "" }` |
| `GET /followup-requests/unresolved-count` | 待办角标（超时优先） |

- 超时升级由服务端定时任务自动执行（`slaDueAt` 到期未认领 → `escalatedTo` 主管），并出 SSE 事件（§13）。

### 12.4 记录与照片（读：`patient.read`）

| 接口 | 说明 |
|---|---|
| `GET /patients/{id}/h5-records?date=&from=&to=&kind=` | H5 记录列表（含 duplication 状态） |
| `GET /patients/{id}/h5-records/{recId}/photo` | 授权照片读取（同 P1 meal 照片的鉴权口径） |
| `POST /h5-records/{id}/duplication` | 疑似重复确认：`{ "status": "distinct_confirmed" }`（或发起核对留言） |
| `POST /h5-records/{id}/team-note` | 团队备注（不含患者正文覆盖） |

### 12.5 内容库（读：登录；编辑 `h5.content.edit`；审核 `h5.content.review`）

| 接口 | 说明 |
|---|---|
| `GET /content-articles?category=&status=&page=` / `GET /content-articles/{id}` | 列表/详情（含版本与审核记录） |
| `POST /content-articles` | 新建草稿 |
| `PATCH /content-articles/{id}` | 编辑（version+1）；`expectedVersion` 乐观检查 |
| `POST /content-articles/{id}/submit-review` | → reviewing |
| `POST /content-articles/{id}/publish`（`h5.content.review`） | → published（A09：未审核不可发布） |
| `POST /content-articles/{id}/retire`（`h5.content.review`） | 下架；引用方显示「内容已更新」 |

### 12.6 提醒任务（读：`patient.read`；发送走现有草稿链）

| 接口 | 说明 |
|---|---|
| `GET /reminder-tasks?status=&patientId=&date=&page=` | 投递状态看板（六状态分别统计，A10） |
| `GET /patients/{id}/reminder-tasks/summary?date=` | 频控用量（当日已用/上限） |
| `POST /reminder-tasks/{id}/cancel` | 团队取消 |

- 顾问发送动作复用现有侧边栏/控制台草稿链（`reminder_task.draftId`），不在本表重复定义接口。

### 12.7 隐私申请（`h5.privacy.handle`）

| 接口 | 说明 |
|---|---|
| `GET /privacy-requests?status=&page=` | 队列 |
| `POST /privacy-requests/{id}/handle` | 处理：`{ "result": "handled" \| "rejected", "note": "" }`；deletion 处理时执行软删并冻结，文案按真实政策 |

### 12.8 患者卡片扩展（读：`patient.read`）

- `GET /patients/{id}` 响应**新增可空字段**（additive，不动现有字段）：`"h5": { "bound": true, "phoneTail": "3421", "consents": { "reminder": "granted", "health_processing": "granted" }, "planVersion": 2, "planStatus": "published", "lastSessionAt": 1762646400000 }`。

### 12.9 账号能力（admin）

| 接口 | 说明 |
|---|---|
| `GET /accounts/{id}/h5-permissions` / `PUT /accounts/{id}/h5-permissions` | 查看/分配 §6.3 能力数组（写审计） |

---

## 13. SSE 新增事件类型

现有 `GET /stream` 增加（向后兼容，控制台订阅）：

| 事件 | 载荷（不含正文） |
|---|---|
| `h5.plan.generated` | `{ patientId, planId, version }` |
| `h5.plan.published` | `{ patientId, planId, version, supersededVersion }` |
| `h5.plan.suspended` | `{ patientId, planId }` |
| `h5.followup.created` | `{ patientId, followupId, kind, riskLevel }` |
| `h5.followup.claimed` / `h5.followup.resolved` | `{ followupId }` |
| `h5.followup.escalated` | `{ followupId, escalatedTo }` |
| `h5.record.created` | `{ patientId, recordId, kind, duplicationSuspected }` |
| `h5.privacy.requested` | `{ patientId, requestId, kind }` |

---

## 14. 页面数据覆盖表（验收映射）

| 页面 | 读取 | 写入 | 状态/来源要求 |
|---|---|---|---|
| H01 食养主张 | §9.1 | 跳过标记（本地）+ §11.1 事件 | 出处可核对；主按钮按 `/me.status` |
| H02 轻量建档 | §4.1 §4.2 | §4.3 §4.4 | 来源标注；「不清楚」合法；缺失/冲突阻止进入可执行建议 |
| H03 今天首页 | §6.1 §9.4 | §7.1 §6.4 | 进度仅计划行动；无计划=准备中 |
| H04 我的健康计划 | §5.1 §5.2 | §5.3 §5.4 | 未发布不可见；审核人来自真实记录 |
| H05 健康日历 | §6.2 §6.3 §9.4 | §6.4 | 五状态+overdue；禁止提前完成 |
| H06 餐食记录 | §7.3 | §7.1 §7.2 §7.4 | 候选/确认分离；失败降级；幂等 |
| H07 晚间回顾 | §7.5 | §7.1(6) | 不预选；可跳过；风险→跟进 |
| H08 食养阅读 | §9.2 §9.3 | §11.1 | 未审核不发布；下架占位 |
| H09 我的 | §4.1 §7.5 §10.1 | §4.5 §3.4 §10.2 | 真实统计口径；纠错入口 |
| H10 团队联系 | §8.1 §8.3 | §8.2 | 状态可跟踪；自动回执≠处理 |
| 团队·邀请绑定 | §12.1 | §12.1 | 一次性 code 不回显 |
| 团队·计划审核 | §12.2 | §12.2 | 发布门禁+版本传播 |
| 团队·日常跟进 | §12.3 §12.4 | §12.3 §12.4 | 认领/超时升级 |
| 团队·任务处理 | §12.3 §12.6 | §12.3 §12.6 | 六状态证据 |
| 团队·内容维护 | §12.5 | §12.5 | 审核留痕 |

**未实现入口隐藏**（PRD §3.1）：语音、搜索、收藏、分享增强、月历、独立报告——前端不放无效按钮。

---

## 15. Mock 与 fixtures

- 目录：`patient-h5/src/mock/fixtures/`（前端骨架包 PH5-03 建立）；全部虚构数据，`sample: true` 标记；不出现真实姓名/手机号/健康档案。
- 后端开发期提供 `mock` 渠道：验证码固定 `000000`（仅 `NODE_ENV !== production` 且 `h5.sms.mode=mock`）；**生产禁用**，mock 通过不得记为真机通过。
- fixtures 覆盖：1 份邀请全状态、绑定会话、5 scope 授权组合、6 状态计划版本链（v1 superseded → v2 published）、五状态事项+overdue、餐食/回顾记录（识别三态）、跟进（认领/超时升级）、文章（三分类+下架）、提醒六状态、隐私申请。
- 与 P1 fixtures（console/src/mock）互不引用；H5 前端联调切真实接口后 fixtures 保留组件测试。

---

## 16. 契约变更

沿用 P1-api §18：**只做新增**；删改先在 #230 评论登记，负责人确认后同步数据模型与本文；实施 PR 单列「契约变更」节；患者端 breaking change 新开 `/zhiban/h5/v2`（v0.1 期间不预期）。

---

## 17. 验收清单对照（本文契约层的自检，供实施 issue 引用）

| PRD 验收 | 契约落点 |
|---|---|
| A01 越权 | §1.7 服务端推导身份；`404` 防探测；媒体鉴权 §7.7 |
| A02 撤回/暂停 | §3.2 + 数据模型 §5 传播表；发送前校验 |
| A03 资料缺失/冲突 | §4.1 safetyMissing；`/generate` 422；不伪装成功 |
| A04 审核门禁 | §5.1 只返回 published；review 真实记录 |
| A05 换版 | §12.2 publish 事务；§6.4 cancelled 不可反馈 |
| A06 状态区分 | §6.4 + 数据模型 §4.3/完成判定 |
| A07 记录失败/幂等 | §7.1 Idempotency-Key；§7.2 降级 |
| A08 回顾不预选 | §7.1 请求示例各字段可空 |
| A09 内容审核/下架 | §12.5 发布门禁；§9.3 retired 404 |
| A10 提醒口径 | 数据模型 §3.12 状态语义 + §12.6 |
| A11 升级 | 数据模型 §4.4 + §12.3 自动升级 + SSE |
| A12 真机 | 本契约不宣称；验证步骤由 PH5-11 承载 |

> 本契约仅定义行为；**未实现、未验证**。所有「✅」判定属于后续实施 issue。
