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
                 │  reply_draft / reply_skip / image_classify / meal_log_write
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
| `src/p1/vision.ts` | 图片读取与格式嗅探、类型/饮食记录校验、图片提示词、饮食记录视图 |
| `src/p1/meal-tools.ts` | `image_classify` / `meal_log_write` 参数校验与 DSH 工具定义 |
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
- **患者身份**（`identityStatus` / `identitySource` / `identityConfirmedAt`）：
  - 系统按发言猜测建档的自动患者为 `pending` / `auto`（员工先发言时取第一个外部成员建档，
    可能绑错人）；
  - 顾问在控制台确认/改绑后置为 `confirmed` / `manual`：患者指向服务群里选定的外部成员，
    被选成员角色置为 `self`，原「本人」成员降为 `family`，患者的同意状态跟随被选成员；
  - 患者姓名默认跟随被选成员的群昵称，可显式覆盖。
- 家属/身份未知的发言会在回合提示词里明确「不能当作患者本人的事实」，并要求
  用自然提问核实（如「请问是您本人还是家属？」），不把「家属说」「群里有人问到」
  这类来源说明写进正文。
- **群名同步**：`zhiban-wecom` 用客户联系 API（`groupchat/get?need_name=1`，与昵称同一次请求）
  取回企微当前群名，经 `observeGroup({ groupName, groupNameSource: 'api' })` 写回群名；
  群里改名后下一轮存档轮询（昵称缓存 10 分钟）内生效。控制台手工改名把
  `nameSource` 置为 `manual`，此后企微群名不再覆盖；空群名不覆盖已有名称。

### 2.2 回复与降级

- Agent 唯一出口是 `reply_draft`；本轮不需要回复时用 `reply_skip`。
- 草稿正文是顾问会直接复制到客户群的最终消息：以顾问口吻直接回复、开头直接回应问题，
  不出现「群里」「存档」「草稿」「审核」「有人问」等内部视角或来源说明；尽量控制在
  500 字以内，先给结论和最重要的 3–5 条。
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

### 2.6 图片理解（#55）

- 回合内的图片（JPEG / PNG / WebP，单张 ≤ 10 MB，最多 4 张）以 base64 附件注入 Session，
  并在提示词里追加 `imageInstructionBlock`：先分类、餐食写饮食记录、报告/药品不解读。
- 读取失败或超限时降级为纯文字回合，发 `patient.image.skipped`，不中断草稿。
- `image_classify` 记录本轮图片类型；`meal_log_write` 每回合最多一次，写入
  `meal_logs` 并计入患者存储。
- **服务端风险兜底**：含图片的回合风险至少 `medium`；只有「已写饮食记录且没有
  报告/药品图」才保持模型给出的 `low`。模型失败时的模板正文为「收到您的照片…」，风险 `medium`。
- `meal-vision` skill 由插件写入 `skillDir`（可选配置），内容与提示词一致。
- 草稿把 `mediaKinds` 带到 C2：卡片显示「客户发来图片 · 餐食」，原图按 JPEG/PNG ≤ 2 MB
  转发到服务群；转发失败的图片只记审计，不阻塞卡片与正文。

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
  "turnTimeoutMs": 15000,
  "skillDir": "/var/lib/zhiban/skills"
}
```

- `advisorId` 必须与 `zhiban-wecom` 配置的 `advisorId` 一致；`advisorWecomUserId`
  是顾问企微 userid（缺省沿用 `advisorId`）。
- `requireConsentForTurn=false`（默认）：`unknown` 仍可服务，界面提示「状态待确认」；
  `disagreed` 永远不自动服务。设为 `true` 时只有 `agreed` 才触发回合。
- 本插件没有任何 Secret；企微凭据只在 `zhiban-wecom` 配置里。
- `skillDir`（可选）：插件启动时把 `meal-vision.md` 写入该目录；不配则不写。

### 系统提示词

`zhibanPatient.systemPrompt()` 返回租户化的人设与红线。生产环境应把同一预设
（`agentPreset`）配置到 DSH，使患者 Session 使用它；工具 `reply_draft` / `reply_skip` /
`image_classify` / `meal_log_write` 由本插件注册。

---

## 4. 同意状态自动同步

- `zhiban-wecom` 启动时用存档凭据（`/etc/zhiban/archive/config.txt` 第 1 行 corpid、
  第 2 行会话存档 Secret）创建 `RoomAgreeClient`，轮询存档时按 roomid 调
  `msgaudit/check_room_agree`，把 `Agree` / `Disagree` 映射为 `agreed` / `disagreed`，
  经 `memberConsent` 交给 `PatientService.observeGroup`，再刷新成员与患者的同意状态。
- 成功结果缓存 5 分钟、失败负缓存 10 分钟；token 失效（40014/42001）自动换一次。
  凭据缺失、权限不足（如内部群 90501）或网络失败时静默保持原状态，不阻塞存档链路。
- Secret / access_token / 外部联系人 id / 昵称都不进日志；只记群 id 尾号、成员数量与
  errcode。本插件仍没有任何 Secret，凭据只从环境或存档配置文件读取。
- 控制台仍保留 `setMemberConsent` / `refreshConsent` 手工修正入口。
- ⏳ 待真机：确认 `check_room_agree` 返回的 `exteranalopenid` 与存档/成员表里的
  `externalUserId` 是同一个值；若不一致，状态不会落到成员上（需按真机返回值调整映射）。
  本项在真机确认前不能写成「已通过」。
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
| 群名同步（企微改名生效、手工改名优先、空名不覆盖） | `tests/patient-service.test.ts`、`tests/wecom-group-info.test.ts` |
| 同意状态自动同步（映射、缓存、token 重试、失败降级、不落 id） | `tests/wecom-room-agree.test.ts`、`tests/wecom-runtime.test.ts` |
| 工具参数校验、正常草稿、四种降级 | `tests/agent-reply.test.ts` |
| reply_skip、重复调用、核验回写 | `tests/agent-reply.test.ts` |
| 连发合并、2 分钟上限、内部上下文、去重、家属提示 | `tests/group-context.test.ts` |
| v1 → 改稿 → v2 卡片、旧卡片 STALE_CARD、审计与版本历史 | `tests/revision.test.ts` |
| wecom ↔ patient 转交、旧模板兜底、1:1 改稿、配置与 Session 适配 | `tests/patient-plugin.test.ts` |
| 图片注入、餐食记录、风险兜底、读图失败降级 | `tests/image-turn.test.ts` |
| 图片格式嗅探、大小/数量上限、类型与记录校验、视图不泄露路径 | `tests/vision.test.ts` |

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
6. **群名同步**：在企业微信里改群名，等一轮存档轮询后确认控制台群名变化；
   再在控制台手工改名，确认随后的轮询不再把它改回企微群名。
7. **同意状态**：让真实客户在群里分别点「已同意保存 / 不同意保存」，等一轮轮询后确认
   控制台成员与患者状态自动变化；同时核对接口返回的 `exteranalopenid` 与成员
   `externalUserId` 一致。`disagreed` 的消息不再触发自动服务，且顾问能看到提示。
7. **真实图片回合**：客户在服务群发一张餐食照，确认 Session 收到图片、模型调用
   `image_classify` / `meal_log_write`、卡片出现「客户发来图片 · 餐食」、
   原图转发到顾问 1:1，控制台饮食记录可见。
8. **报告与药品图**：发一张化验单 / 药盒，确认草稿风险至少 `medium`、
   正文不解读指标、不判断能否服用。

> 以上 1–8 未在本地 mock 之外验证前，不得在 PR / issue 中写「真机通过」。

---

## 6. 运维注意

- 日志只打元数据（患者 id、群 id、消息 id 尾部、错误码），**不打消息正文**。
- 盘点：`zhibanPatient.stats()` 返回 `turns / replies / skips / fallbacks / timeouts /
  errors / mergedBatches / contextMessages / revisions / duplicatesSkipped`。
- 领域存储失败会发 `alert.created(PERSIST_FAILED)`；同一次失败只告警一次。
- 卸载插件时取消合并定时器、等待落盘、关闭 `zhiban_patient` 领域。
