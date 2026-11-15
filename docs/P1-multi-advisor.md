# 知伴健康 Agent · P1 增补：多顾问名册、归属与数据隔离

> 状态：设计稿，待项目负责人确认
> 日期：2026-11-15
> 起因：种子合作按「10 位顾问」报价，但当前实现只有 1 个顾问身份；控制台账号也没有数据范围，任何具备 `patient.read` 的账号看到的是同一份全量数据。

---

## 1. 一句话

把「一位顾问负责哪些群、哪些患者」从配置里的一个字符串，变成**可管理的名册 + 落库的归属 + 可鉴权的账号范围**：顾问只看自己名下的数据，管理员看全部，越权一律 `404`。

---

## 2. 现状（已核实到代码）

| 能力 | 契约 | 实现 |
|---|---|---|
| 顾问名册 | [P1-data-model §3.3](./P1-data-model.md)、[P1-api §8](./P1-api.md) 已有 `POST/PATCH /advisors` | 只有 `GET /advisors` + 暂停/恢复/放行；顾问记录由插件启动时按配置 `upsertAdvisor` 写入一条（`plugins/zhiban-patient/index.ts:368`） |
| 患者归属 | `patient.advisorId` | 有字段；读时若无值则从所属群兜底推导（`src/p1/console-views.ts:337`） |
| 群归属 | `group.advisorId` | 有字段，`PATCH /groups/{id}` 可改（`plugins/zhiban-console/index.ts:1021`） |
| 账号范围 | — | `AccountRecord` 只有角色，无 `advisorId`、无范围（`src/p1/console-types.ts:143`） |
| 数据接入鉴权 | — | `GET /patients`、`GET /patients/:id`、`/drafts`、`/alerts`、`/stream` 全部是**租户级**：只校验 `patient.read`，`advisorId` 只是可选查询参数 |
| 侧边栏 | — | 已有顾问级校验：`group.advisorId !== advisor.id → FORBIDDEN`（`src/p1/sidebar-view.ts:288`） |
| 跨租户 | — | 已隔离，跨租户按 `NOT_FOUND` |

**结论**：地基都在，缺两块——「名册可以管」和「鉴权按归属收窄」。前者影响 10 席位能不能真上人，后者影响能不能把控制台账号发给顾问。

---

## 3. 三个决策

### D1 · 归属是单值，改派就是改字段

一个患者、一个群、一份草稿只属于**一位**负责顾问。多人协作、排班、工单、转交审批全部不做（见 §11）。

- 理由：业务上「这个客户跟谁」有唯一答案；多值会立刻引出「谁算采纳率」「谁被暂停」的口径问题。
- 归属变更写审计（`patient.advisorId` / `group.advisorId` 前后值），不写正文。

### D2 · 账号范围用显式 `scope`，不靠角色推断

`account.scope ∈ {tenant, self}`：

| scope | 含义 | 约束 |
|---|---|---|
| `tenant`（默认） | 看本租户全部数据 | 现状行为，**存量账号不受影响** |
| `self` | 只看 `advisorId` 名下数据 | 必须绑定 `advisorId`；`admin` 不能是 `self` |

- 理由：用角色推断（「viewer 就是顾问」）会把「只读的运营同事」误收窄。范围是数据维度，角色是动作维度，两者正交。
- 不新增 `advisor` 角色。顾问账号 = `viewer` 或 `supervisor` + `scope=self` + `advisorId`。
- 一个自然人一个席位：无论从企微还是控制台进入，同一位顾问只对应一条 `advisor` 记录、一个存档席位。

### D3 · 越权返回 `404`，不返回 `403`

`self` 账号访问他人患者/草稿/告警时，与资源不存在返回同一个 `404 NOT_FOUND`。

- 理由：`403` 会泄露「这个 id 存在，只是不属于你」，够用于枚举患者 id。
- 审计里仍然记录被拦截的尝试（`access.denied`，只有 actor、资源类型、id 尾号）。

---

## 4. 数据模型改动

### 4.1 account（`accounts` 表）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `scope` | enum | 否 | `tenant` / `self`，默认 `tenant`，存量数据迁移时补默认值 |
| `advisor_id` | string | 是 | `scope=self` 时必填且必须存在于 `advisors`；`scope=tenant` 时为 `null` |

约束：`CHECK (scope = 'tenant' OR advisor_id IS NOT NULL)`；`admin` 角色写入时强制 `scope='tenant'`。

### 4.2 advisor（`advisors` 表）

契约已完整（[P1-data-model §3.3](./P1-data-model.md)），只补约束与迁移：

- 唯一索引 `UNIQUE (tenant_id, wecom_user_id)`。
- 启动迁移：名册为空时，把配置里的 `advisorId / advisorName / advisorWecomUserId` 写入名册（保持现有部署升级后可用）。
- `status=left` 前必须没有 `QUEUED`/`PUSHED` 草稿，否则 `409`（契约已写，未实现）。

### 4.3 归属字段的取值口径

- **鉴权只用落库的显式 `advisor_id`**，不用兜底推导。
- 兜底推导（患者无归属时取主群的顾问）**只用于展示**，并在界面上标注「随群」。
- 迁移任务：把当前能推导出顾问的患者/群一次性回填，写审计 `migration.advisors_backfill`，报告回填条数与仍为「未分配」的条数。

### 4.4 索引

```sql
CREATE UNIQUE INDEX idx_advisors_tenant_wecom ON advisors(tenant_id, wecom_user_id);
CREATE INDEX idx_accounts_tenant_scope ON accounts(tenant_id, scope);
CREATE INDEX idx_patients_tenant_advisor ON patients(tenant_id, advisor_id, deleted_at);
CREATE INDEX idx_groups_tenant_advisor ON groups(tenant_id, advisor_id);
CREATE INDEX idx_alerts_tenant_advisor_status ON alerts(tenant_id, advisor_id, status);
```

---

## 5. 可见范围矩阵

| 资源 | `admin` | `scope=tenant`（主管 / 只读） | `scope=self`（顾问） |
|---|---|---|---|
| 患者、记忆、计划 | 全部 | 全部 | 仅名下；未分配不可见 |
| 服务群 | 全部 | 全部 | 仅自己是负责人的群 |
| 草稿 / 服务流 | 全部 | 全部 | 仅名下 |
| 告警 | 全部 | 全部 | 仅 advisorId 指向自己的 |
| 工作台、价值看板、报表 | 全租户 | 全租户 | 仅个人口径，**不出现团队对比** |
| 证据链 / 记录导出 | 全部 | 全部 | 仅自己患者的 |
| 审计 | 全部 | 全部 | **不授予**（返回 403，前端不显示入口） |
| 账号与角色 / 数据与安全 / 开通页 | 读写 / 读 / 读 | 按角色 | **不授予** |
| 知识库 / 风险规则 / 话术库 | 读写 | 读 | 读 |
| SSE `/stream` | 全部事件 | 全部事件 | 仅 `data.advisorId` 指向自己的事件 |

未分配（`advisor_id IS NULL`）的数据只有 `admin` 与 `scope=tenant` 可见，界面上单独一个「未分配」筛选。

---

## 6. 接口改动

### 6.1 补齐顾问名册

| 接口 | 状态 | 说明 |
|---|---|---|
| `POST /advisors` | 需实现 | `{ wecomUserId, name, seatExpireAt? }`；`wecomUserId` 租户内唯一，重复 `409`；写审计 `advisor.create` |
| `PATCH /advisors/{id}` | 需实现 | `name` / `seatExpireAt` / `status`；`left` 前进草稿校验；写审计 `advisor.update` |
| `GET /advisors` | 已有 | 补分页与 `q`（按名称 / wecomUserId） |

### 6.2 账号带范围

`POST /accounts`、`PATCH /accounts/{id}` 增加 `scope`、`advisorId`；`GET /accounts` 返回两者。`scope=self` 但未绑定顾问 → `422`。

### 6.3 统一收窄点

在 `plugins/zhiban-console` 增加一个 `scopedActor(rc)`，取代受影响路由里的 `tenantActor(rc)`：

```ts
type DataScope = { kind: 'tenant' } | { kind: 'advisor'; advisorId: string };

function scopedActor(rc): { actor: Actor; scope: DataScope };
function applyScope<T>(items: T[], scope: DataScope, pick: (item: T) => string | null): T[];
function assertVisible(scope: DataScope, advisorId: string | null): void; // 不通过 → NOT_FOUND
```

**列表**：查询后在 `applyScope` 过滤（先按租户取，再按顾问收窄；SQL 落地时把条件下推到 `WHERE advisor_id = ?`）。
**详情/写**：取回后 `assertVisible`，不通过抛 `NOT_FOUND`。

必须接上的端点（缺一个就等于漏）：

- `GET /patients`、`GET /patients/:id`、`PATCH /patients/:id`、`DELETE /patients/:id`
- `GET /groups`、`GET /groups/:id`、`PATCH /groups/:id`
- `GET /drafts`、`GET /drafts/:id`、`GET /drafts/{id}/evidence.pdf`、`POST /drafts/{id}/ack`
- `GET /patients/{id}/records.pdf`
- `GET /alerts`、`GET /alerts/:id`、告警处理类动作
- `GET /dashboard/*`、价值看板、`GET /advisors/{id}/performance`
- `GET /stream`（SSE 推送过滤）
- `GET /audit`、`GET /audit/export.csv`（`self` 直接 403）

### 6.4 错误码

| 场景 | 返回 |
|---|---|
| `self` 访问他人资源 | `404 NOT_FOUND` |
| `scope=self` 未绑定顾问 | `422 VALIDATION_FAILED` |
| `self` 访问审计 / 账号 / 安全页 | `403 FORBIDDEN` |
| 停用仍有进行中草稿的顾问 | `409 CONFLICT` |

---

## 7. 前端改动（`console/`）

1. **账号与角色页**：新增「数据范围」（全机构 / 仅本人负责）与「绑定顾问」两个字段；`self` 时顾问必选；列表列显示范围。
2. **患者 / 服务流 / 告警页**：当前账号 `scope=self` 时，**隐藏顾问筛选器**，标题旁显示「仅显示我负责的客户」；不再允许通过 URL `?advisorId=` 切换（后端已拦，前端也不要给入口）。
3. **未分配视图**：`admin` / `tenant` 账号在患者页增加「未分配」筛选，并可批量改派。
4. **顾问页**：补「新增顾问」「编辑」「改派客户」入口；席位到期前 30 天标黄，到期后标红，**不自动暂停**（席位是客户侧合同，停下服务反而更难解释）。
5. **`self` 账号的导航**：隐藏 设置 · 账号与角色、数据与安全、开通正式服务、审计日志。

---

## 8. 迁移与兼容

1. 发布时自动执行：`accounts.scope` 补 `tenant`；顾问名册为空则从配置写入；回填群/患者归属。全部幂等。
2. **存量行为不变**：现有所有账号都是 `tenant`，接口返回与今天一致。回归用例必须证明这一点。
3. 若迁移前存在「一个部署配多个顾问」的脏数据，以配置里那条为准，其余进名册但标 `paused`，等待人工确认。

---

## 9. 验收标准

> 每条都要能在本地用种子数据跑出来；涉及企微的标「⏳ 待真机」。

| # | 验收项 | 判定 |
|---|---|---|
| AC1 | 名册 CRUD：新增两位顾问 A、B，`wecomUserId` 重复时 `409` | 接口 + 页面 |
| AC2 | 群改派：把群 G 从 A 改派给 B，患者 P 的归属随之变化；审计有前后值 | 接口 + 页面 |
| AC3 | 列表收窄：A 的账号 `GET /patients` 只返回名下，总数等于 A 名下的患者数 | 接口测试 |
| AC4 | 详情收窄：A 的账号 `GET /patients/{B的患者}` 返回 `404`，响应体与「不存在」完全一致 | 接口测试 |
| AC5 | 写收窄：A 不能 `PATCH`/`DELETE` B 的患者；A 可以改自己患者的标签 | 接口测试 |
| AC6 | 导出收窄：A 导出记录 PDF / 证据链，只含自己患者；跨顾问 `404` | 接口测试 |
| AC7 | SSE 收窄：A 的连接收不到 B 的 `draft.created` | 接口测试 |
| AC8 | 管理员视角不变：`admin` 列表条数 = 全租户；存量 `viewer`（tenant）行为与升级前逐字段一致 | 回归测试 |
| AC9 | 未分配：`advisor_id IS NULL` 的患者对 `self` 不可见、对 `tenant` 可见并可改派 | 接口 + 页面 |
| AC10 | 规模：种子 10 顾问 × 20 患者，列表分页、筛选、改派均正常，响应体不出现他人数据 | 接口测试 |
| AC11 | 日志与审计：不出现患者昵称、消息正文、密码；越权尝试只记录 actor、资源类型、id 尾号 | 日志抽查 |
| AC12 | 迁移幂等：连续启动两次，数据与审计不重复 | 启动测试 |
| AC13 | ⏳ 待真机：企微侧边栏仍是 A 只看自己的群；B 看不到 A 的会话 | 真机 |

---

## 10. 分期与估时

| 阶段 | 内容 | 估时 |
|---|---|---|
| v1-1 | 名册 CRUD + 启动迁移 + 唯一约束 | 2d |
| v1-2 | 归属落库与改派、未分配视图、审计 | 1.5d |
| v1-3 | `scope` 模型 + 收窄中间件 + 全部端点 + 单测 | 2.5d |
| v1-4 | 前端：账号范围、列表锁定、未分配、顾问页 | 1.5d |
| v1-5 | 回归（含 10 顾问种子）与文档同步 | 1.5d |
| 合计 | | **9d** |

建议拆两个 PR：`v1-1 + v1-2`（名册与归属，不碰鉴权，风险低，先把 10 席位撑起来）、`v1-3 + v1-4 + v1-5`（数据隔离，需要重点回归）。

---

## 11. 非目标

排班与轮值、工单与转交审批、一个患者多位顾问、跨顾问协作、代班登录 / 账号切换、顾问离职的会话交接流程、多租户、计费与席位扣减、控制台移动端适配。

---

## 12. 附录：对报价口径的影响

1. **席位定义要写死**，避免客户把「10 席位」理解成 10 个登录账号。建议对外口径：

   > 一位顾问 = 一位获得授权使用知伴 Agent 的企微员工（含其负责的服务群与客户）。控制台管理员账号不单独计费，不占席位。

2. **存档席位是第三方成本**：900 元 / 人 / 年，客户直接付给企业微信（[PRD §12](../PRD.md)）。10 位顾问约 9,000 元 / 年，不包含在平台服务费里；若由我们代采代付，需另计。

3. **平台服务费结构不变**：本增补是交付能力，不改变 1.98 万 / 月的构成（不按账号、不按量、不设增购价目）。

4. **交付承诺**：种子期把 v1-1/v1-2 作为「10 席位可落地」的必备项；v1-3 起的控制台顾问账号，可以按客户是否真的需要顾问登控制台决定先做后做——不做也不影响 10 位顾问在企微里工作。
