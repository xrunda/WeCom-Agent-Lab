# P1 患者 Agent：实现与验收（#33 / #34 / #56 / #63）

> 状态：代码与离线测试完成；真机项待项目负责人执行。
> 关联：[P1 数据模型](./P1-data-model.md) · [P1 API](./P1-api.md) · [P1 环境隔离](./P1-environments.md)

---

## 1. 结构

```
会话存档 ──► zhiban-wecom（轮询 / C2 卡片 / 企微机器人）
                 │  pollWithContext：外部发言 + 内部发言 + 群成员
                 ▼
          zhiban-patient（本插件）
                 │
    PatientService（同步路由：serving / collect_only / pending / disabled）
                 │
    PatientAgentRuntime（合并窗口 → 患者长期 Session → 回合 → 工具 → 降级）
                 │  reply_draft / reply_skip
                 ▼
          PatientBridge ──► zhiban-wecom ──► C2Service（版本化卡片）
```

- **一个患者一个长期 Session**：`zhiban-patient-<patientId>`，工作区
  `<workspaceRoot>/<patientId>`；群与患者的绑定、会话 id、同意状态、统计都落在
  领域 `zhiban_patient`，重启不丢。
- **两个插件互不硬依赖**：
  - 患者插件通过 `ctx.get('zhibanWecom')` 懒加载草稿桥（写操作在 wecom 未就绪时
    明确报错，读操作安全降级为空）。
  - wecom 通过 `ctx.get('zhibanPatient')` 懒加载患者域；患者域不存在时保持原模板链路。
  - 谁先加载都能启动，不要求 DSH profile 里的插件顺序。

### 关键模块

| 模块 | 职责 |
|---|---|
| `src/p1/patient-service.ts` | 群发现、成员角色、患者建档/绑定、同意状态、同步路由判定 |
| `src/p1/patient-store.ts` | 内存镜像 + 串行持久化；同步读，写入不阻塞路由 |
| `src/p1/merge.ts` | 连发合并：30 秒安静窗口，120 秒强制放行，单批最多 20 条 |
| `src/p1/runtime.ts` | 回合编排、内部上下文、模板降级、核验回写、顾问改稿 |
| `src/p1/persona.ts` | 系统提示词、红线、发言人身份、改稿提示 |
| `src/p1/reply-tools.ts` | `reply_draft` / `reply_skip` 参数校验与 DSH 工具定义 |
| `plugins/zhiban-patient/` | DSH 装配：领域存储、Session 适配、工具注册、`zhibanPatient` 服务 |
| `plugins/zhiban-wecom/runtime.ts` | 把存档消息转交患者域；旧模板链路兜底；STALE_CARD 提示 |

---

## 2. 行为约定

### 2.1 群与患者

- 存档里出现带外部成员的群 → 自动登记为 `pending`，**不自动服务**。
  需要管理员改为 `serving` 后才生成草稿；`collect_only` 只写上下文；`disabled` 不处理。
- 群内外部成员默认 `role=unknown`、`consent=unknown`；内部员工自动标为
  `advisor` / `colleague`，内部发言只作为上下文，不触发回合。
- 第一个外部发言会自动建档并绑定；也可以把多个群绑定到同一患者，路由到同一个 Session。
- 家属/身份未知的发言会在回合提示词里明确「不能当作患者本人的事实」。

### 2.2 回复与降级

- Agent 唯一出口是 `reply_draft`；本轮不需要回复时用 `reply_skip`。
- 超时（默认 15 秒）、模型报错、没调工具、Session 创建失败 → **模板草稿**
  （`fallback=true`，卡片带「模板草稿」标记），不丢消息。
- `reply_draft` 参数：`body` 1–1000 字、`inboundSummary` 1–80 字、
  `riskLevel` low/medium/high、引用 id 数组最多 50 项。
- 同一回合重复调用 `reply_draft` / `reply_skip` 报 `ALREADY_REPLIED` /
  `ALREADY_SKIPPED`；回合结束再调用报 `NO_ACTIVE_TURN`。

### 2.3 连发合并

- 同一群最后一条消息后静默 30 秒放行；从第一条起最多等 120 秒。
- 文字按顺序拼进提示词，图片标 `[图片] + 本地路径`；一次合并只产生一个回合、一份草稿，
  `inboundMessageIds` / `mediaIds` 携带全部消息与图片。
- 内部员工刚发过的、与已核验草稿正文相同的消息会去重，不重复写入上下文。

### 2.4 顾问改稿（#56）

1. 顾问在机器人 1:1 里发一句文字；
2. 有活动草稿 → `draft.revision.request` 审计 → 提示「正在改第 N 版」；
3. Agent 在患者会话里按指令重写，调用 `reply_draft`；
4. `reviseDraft` 生成第 N+1 版（`revisions` 保留历史），重新排队推送；
5. 新卡片按钮 key 带版本（`ack:<id>:v<n>:action`），旧卡片点击返回 `STALE_CARD`，
   顾问只会看到「已有新版本，请使用最新一条卡片操作」；
6. 改稿超时/报错时保留旧版本，并提示顾问重试。

无活动草稿时，顾问发文字只会收到用法提示。

### 2.5 核验回写

C2 核验结果（已核验 / 有改动 / 错群 / 未核验）通过 `injectContext` 写回患者 Session，
作为后续回合的背景，**不唤醒新回合**。

---

## 3. 配置

`zhiban-patient` 插件配置示例（放在 DSH profile 的插件配置里）：

```json
{
  "tenantId": "tn_demo",
  "workspaceRoot": "/var/lib/zhiban/patients",
  "advisorId": "adv_1",
  "advisorWecomUserId": "wang.guwen",
  "advisorName": "王顾问",
  "agentName": "小安",
  "patientTerm": "患者",
  "tone": "亲切、专业、简洁",
  "agentPreset": "zhiban-health",
  "requireConsentForTurn": false,
  "demo": true,
  "mergeWindowMs": 30000,
  "mergeMaxWaitMs": 120000,
  "turnTimeoutMs": 15000
}
```

- `advisorId` 必须与 `zhiban-wecom` 配置的 `advisorId` 一致；`advisorWecomUserId`
  是顾问企微 userid（缺省沿用 `advisorId`）。
- `requireConsentForTurn=false`（默认）：`unknown` 仍可服务，界面提示「状态待确认」；
  `disagreed` 永远不自动服务。设为 `true` 时只有 `agreed` 才触发回合。
- 本插件没有任何 Secret；企微凭据只在 `zhiban-wecom` 配置里。

### 系统提示词

`zhibanPatient.systemPrompt()` 返回租户化的人设与红线。生产环境应把同一预设
（`agentPreset`）配置到 DSH，使患者 Session 使用它；工具 `reply_draft` / `reply_skip`
由本插件注册。

---

## 4. 同意状态（已知缺口）

- 目前没有调用企微 `check_room_agree` 接口；同意状态通过
  `PatientService.setMemberConsent` / `refreshConsent` 手工写入（控制台接口后续补）。
- 因此真机验收中「客户同意存档状态自动同步」为 ⏳ 待真机，不能写成已通过。
- 未同意时的提示文案固定为「该成员未同意存档，需人工服务（状态待确认）」。

---

## 5. 验收

### 5.1 本地已通过（`npm test`）

| 项 | 测试 |
|---|---|
| 群自动登记 pending、不触发回合 | `tests/patient-service.test.ts` |
| serving / collect_only / disabled 即时生效 | `tests/patient-service.test.ts` |
| 两群绑同一患者、重启后状态与会话不丢 | `tests/patient-service.test.ts` |
| 成员角色与同意状态 | `tests/patient-service.test.ts` |
| 工具参数校验、正常草稿、四种降级 | `tests/agent-reply.test.ts` |
| reply_skip、重复调用、核验回写 | `tests/agent-reply.test.ts` |
| 连发合并、2 分钟上限、内部上下文、去重、家属提示 | `tests/group-context.test.ts` |
| v1 → 改稿 → v2 卡片、旧卡片 STALE_CARD、审计与版本历史 | `tests/revision.test.ts` |
| wecom ↔ patient 转交、旧模板兜底、1:1 改稿、配置与 Session 适配 | `tests/patient-plugin.test.ts` |

### 5.2 ⏳ 待真机（项目负责人执行）

1. **DSH 内插件加载**：按 profile 同时加载 `zhiban-wecom` 与 `zhiban-patient`，
   确认 `zhibanPatient` / `zhibanWecom` 均能 `ctx.get` 到，日志出现「已就绪」。
2. **真实模型回合**：让客户在服务群发一条文字，确认 Session 创建、
   `reply_draft` 被调用、卡片与正文到达顾问 1:1。
3. **连发合并**：同一群 30 秒内连发 3 条（含 1 张图片），确认只出现一份草稿，
   卡片摘要与图片路径正确。
4. **顾问改稿**：顾问在机器人 1:1 回一句改稿指令，确认收到「正在改第 2 版」、
   新卡片标题为「第 2 版」、点旧卡片提示新版本。
5. **停用与采集**：把群改为 `collect_only` / `disabled`，确认不再生成新草稿。
6. **同意状态**：手工把成员同意改为 `disagreed`，确认消息不再触发自动服务，
   且顾问能看到提示。

> 以上 1–6 未在本地 mock 之外验证前，不得在 PR / issue 中写「真机通过」。

---

## 6. 运维注意

- 日志只打元数据（患者 id、群 id、消息 id 尾部、错误码），**不打消息正文**。
- 盘点：`zhibanPatient.stats()` 返回 `turns / replies / skips / fallbacks / timeouts /
  errors / mergedBatches / contextMessages / revisions / duplicatesSkipped`。
- 领域存储失败会发 `alert.created(PERSIST_FAILED)`；同一次失败只告警一次。
- 卸载插件时取消合并定时器、等待落盘、关闭 `zhiban_patient` 领域。
