# P1 长期记忆与主动关怀：实现与验收（#35 / #36）

> 状态：代码与离线测试完成；真机项待项目负责人执行。
> 关联：[P1 数据模型](./P1-data-model.md) · [P1 API](./P1-api.md) · [P1 患者 Agent](./P1-patient-agent.md)

---

## 1. 结构

```
患者回合（zhiban-patient）
   │  ← 每轮注入 MemoryService.render(patientId)
   │  → 模型调用 memory_write / memory_update / memory_list
   ▼
zhiban-memory ──► MemoryService ──► zhiban_memory 领域（memories / audit）
   │                                  每轮上限 injectLimit，默认 30
   └── provide zhibanMemory { available, render, list, get, count }

患者回合（zhiban-patient）
   │  ← 模型调用 schedule_create 建一次性计划
   ▼
zhiban-care ──► CareService ──► zhiban_care 领域（plans / audit）
   │              单一定时器 → 最近一条 pending 计划
   │              到期 → startProactiveTurn（患者域）
   ▼
PatientAgentRuntime.startProactiveTurn
      → 主动回合 → reply_draft（source=proactive）→ C2 卡片「来源：Agent 主动」
                 → reply_skip（不需要发）
```

两个插件都不硬依赖患者插件：工具通过 `ctx.get('zhibanPatient')` 懒加载
会话→患者映射；患者域未就绪时工具明确报错，active 计划顺延而不是丢失。
`zhiban-patient` 反向懒加载 `zhibanMemory` / `zhibanCare`，缺插件时提示词不出现对应工具。

### 关键模块

| 模块 | 职责 |
|---|---|
| `src/p1/memory.ts` | 记忆校验、去重写入、更新、软删除、每轮注入渲染、审计与事件 |
| `src/p1/memory-tools.ts` | `memory_write` / `memory_update` / `memory_list` 参数校验与 DSH 定义 |
| `src/p1/care.ts` | 计划存储、时间校验、安静时段顺延、单定时器调度、重启恢复、审计与事件 |
| `src/p1/care-tools.ts` | `schedule_create` 参数校验（when / afterSeconds）与 DSH 定义 |
| `src/p1/runtime.ts` | `startProactiveTurn`、`patientContextForSession`、优先级与限流 |
| `plugins/zhiban-memory/` | DSH 装配：领域、工具注册、`zhibanMemory` 服务 |
| `plugins/zhiban-care/` | DSH 装配：领域、定时器、`schedule_create`、`zhibanCare` 服务 |

---

## 2. 长期记忆（#35）

### 2.1 数据

- id 前缀 `mem_`；字段对齐 [P1 数据模型 §3.8](./P1-data-model.md)，另含
  `tenantId`、`sandbox`、`subject`、`sourceText`、`createdById`、`deletedBy`。
- 分类：`dietary_taboo`（饮食禁忌/过敏）、`routine`（作息）、`goal`（健康目标）、
  `body`（身体状况）、`family`（家庭情况）、`preference`（偏好）、`other`。
- `subject`：`self`（本人）/ `family`（家属）/ `unknown`。
- `content` 最多 200 字；`sourceText` 截到 100 字；正文只存在业务实体里，
  日志、审计、事件都不带正文。

### 2.2 写入

- Agent 每轮通过 `memory_write` 写入，`patientId` 与 `sourceMsgId` 由运行时
  从当前会话解析，**不允许模型指定患者**；拿不到上下文时返回
  `INVALID_TOOL_ARGS`。
- 同一患者 + 同一分类 + 同一句话重复出现时走 `upsertFact`：更新来源消息与
  主题，不新增记录（避免同一句「对海鲜过敏」记十遍）。
- 家属发言写入时 `subject=family`；系统提示词要求家属的事不能写成患者本人事实。
- 只有「患者/家属明确说过的稳定事实」才写，不记推断与寒暄（提示词约定）。

### 2.3 读取与注入

- 每轮开始前 `MemoryService.render(patientId)` 生成注入行：

  ```
  【患者长期记忆（引用时把方括号里的 id 填进 citedMemoryIds）】
  - 饮食禁忌/过敏
    - [mem_01J...] 对海鲜过敏（本人）
  - 健康目标
    - [mem_01J...] 三个月减重 5 公斤（本人）
  ```

- 按分类顺序分组，组内按创建时间；只取未删除记录，最多 `injectLimit` 条。
- 草稿引用记忆时，模型把 id 填进 `citedMemoryIds`，原样进入 C2 草稿。
- 未安装 `zhiban-memory` 时提示词不出现记忆工具，也不注入记忆。

### 2.4 编辑、删除与审计

- `memory_update` 只允许修改当前患者自己的记忆，跨患者返回 `WRONG_PATIENT`。
- 删除是软删除：`deletedAt` / `deletedBy` 保留，下一轮不再注入；历史草稿里的
  `citedMemoryIds` 不动。
- 审计动作：`memory.write` / `memory.update` / `memory.delete`，含 actor
  （`agent` / `staff`）与目标 id，不含正文；落 `zhiban_memory.audit` 表。
- 事件：`memory.created` / `memory.updated` / `memory.deleted`，只带
  `{ memoryId, patientId, category, subject }`。

### 2.5 持久化

- 内存镜像同步读，写入异步串行落盘（与 `patient-store` 一致）。
- 落盘失败不阻塞回合，发 `alert.created(PERSIST_FAILED)`；该条记录仍在内存中。
- 卸载时 `flush()` 等待落盘完成，再关闭 `zhiban_memory` 领域。

---

## 3. 主动计划（#36）

### 3.1 数据

- id 前缀 `pln_`；字段：`patientId`、`title`、`when`、`rrule?`、`source`
  （`agent` / `staff`）、`status`（`pending` / `done` / `cancelled`）、
  `quietHoursShifted`、`lastFiredAt`、`sandbox`、`tenantId`。
- P1 只支持一次性计划；`rrule` 非空直接 `RRULE_UNSUPPORTED`（复杂随访二期）。
- `when` 必须严格晚于当前时间；`title` 1–120 字。

### 3.2 Agent 建计划

- `schedule_create` 参数：`title` + `when`（毫秒时间戳或 ISO 8601）或
  `afterSeconds`（正数），二选一；患者从当前会话解析。
- 创建成功返回 `{ planId, title, when, status, quietHoursShifted }`。
- 来源固定 `agent`；服务端手动新建走 `CareService.create({ source: 'staff' })`。

### 3.3 安静时段

- 默认 `Asia/Shanghai` 的 21:00–08:00（可用插件配置改时区与起止小时）。
- 到点落在安静时段：`when` 顺延到下一个 08:00，`quietHoursShifted=true`；
  已顺延的计划在 `defer` 时再次经过同一规则。
- 时间换算用 `Intl.DateTimeFormat` 的时区局部时间，DST 用二次校正。

### 3.4 调度与重启恢复

- **与 DSH `ctx.schedule` 的差异（已知偏差）**：本版 DSH 的 `ctx.schedule`
  是 Host 级的「把提醒投递进指定 Session 并激活它」，插件侧拿不到到期回调，
  也无法把「哪条 care_plan 触发了」关联回业务实体。因此 `zhiban-care` 自建
  调度器：
  - 计划落 `zhiban_care.plans`；
  - 单个 `setTimeout`（unref）指向最近一条 pending 计划，避免长连接被定时器挂住；
  - 触发时批量处理所有到期计划，处理期间不允许重入；
  - 每次创建/取消/顺延/完成都重新 arm；
  - 重启加载领域数据后 `start()` 自动按 `when` 继续触发。
- 到期处理：
  - `zhiban-patient` 未就绪 → 顺延 60 秒（`PATIENT_UNAVAILABLE`）；
  - 患者回合忙 / 有消息在合并窗口 / 超出小时限流 → 按返回的 `retryAt` 顺延；
  - 产出草稿或 `reply_skip` → `done`；
  - 会话失败或模型没调工具 → `done` 并记 `care_plan.failed`，**不生成模板草稿**
    （主动消息宁可漏发，也不能用模板冒充关怀）。
- 事件：`care_plan.created` / `fired` / `cancelled` / `deferred` / `failed`；
  审计 `care_plan.create` / `cancel` / `defer` / `fire`。

### 3.5 优先级与限流

- 患者提问优先：患者正在回合中、上一轮溢出排队、或群内还有消息在 30 秒合并
  窗口内，主动计划一律顺延 30 秒再试，不抢在患者提问前出草稿。
- 同一顾问每小时主动草稿默认最多 6 条（插件配置 `maxProactivePerHour`，1–60）；
  超出返回 `HOURLY_LIMIT`，`retryAt` 为最早一条 + 1 小时 + 1 秒，避免早 8 点集中涌入。
- 主动草稿 `source='proactive'`、`inboundMessageIds=[]`；C2 卡片带「来源：Agent 主动」。
- 主动回合提示词明确「本轮由主动计划触发，没有新的患者消息」，不需要就让
  `reply_skip`。

---

## 4. 配置

`zhiban-memory`：

```json
{
  "tenantId": "tn_demo",
  "injectLimit": 30,
  "sandbox": false
}
```

- `tenantId` 必填；`injectLimit` 1–200，默认 30；`sandbox` 只影响记录标记。
- 没有 Secret。

`zhiban-care`：

```json
{
  "tenantId": "tn_demo",
  "timeZone": "Asia/Shanghai",
  "quietHoursStart": 21,
  "quietHoursEnd": 8,
  "sandbox": false
}
```

- `tenantId` 必填；`timeZone` 必须是有效 IANA 时区；起止小时 0–23。
- 限流阈值在 `zhiban-patient` 的 `maxProactivePerHour`（默认 6），因为统计
  依赖运行时的顾问队列。
- 没有 Secret。

---

## 5. 验收

### 5.1 本地已通过（`npm test`）

| 项 | 测试 |
|---|---|
| 说「我对海鲜过敏」→ 写入记忆，`sourceMsgId` 指向该消息 | `tests/memory.test.ts`（回合内 `memory_write`） |
| 下一轮自动注入，草稿 `citedMemoryIds` 原样进入 C2 | `tests/memory.test.ts` |
| 删除后不再注入 | `tests/memory.test.ts` |
| 写入 / 编辑 / 删除审计可见 | `tests/memory.test.ts` |
| 家属发言 `subject=family` | `tests/memory.test.ts`、`tests/group-context.test.ts` |
| 分类校验、200 字上限、去重、注入上限、落盘失败告警 | `tests/memory.test.ts` |
| 插件装配：工具注册、按会话患者写入、领域落盘、卸载关闭 | `tests/plugin-wiring.test.ts` |
| `schedule_create` 参数（ISO / 相对秒 / 二选一 / 过去时间 / 患者解析） | `tests/care.test.ts` |
| 计划创建、来源 agent、取消、已执行不可取消、顺延 | `tests/care.test.ts` |
| 安静时段 21–8 双向顺延 | `tests/care.test.ts` |
| 到期触发、`lastFiredAt`、重启后按领域恢复 | `tests/care.test.ts` |
| 到期处理失败与落盘失败 | `tests/care.test.ts` |
| 主动回合产出 `proactive` 草稿、无 inbound 消息 id、卡片来源 | `tests/proactive.test.ts` |
| 不需要时 `reply_skip`；没调工具不套模板 | `tests/proactive.test.ts` |
| 患者忙 / 合并窗口内 → 顺延；患者提问先出草稿 | `tests/proactive.test.ts` |
| 每小时限流与 `retryAt` | `tests/proactive.test.ts` |
| 未同意 / 群未启用 / 患者停服不发主动消息 | `tests/proactive.test.ts` |
| 插件装配：`schedule_create` 落盘、事件、卸载关闭 | `tests/plugin-wiring.test.ts` |

### 5.2 ⏳ 待真机（项目负责人执行）

1. **DSH 内插件加载**：profile 同时加载 `zhiban-memory`、`zhiban-care`、
   `zhiban-patient`，确认 `ctx.get('zhibanMemory')` / `ctx.get('zhibanCare')`
   可达，日志出现「已就绪」，`inject=['storageDomain']` 满足。
2. **真实模型抽取**：对患者说「我对海鲜过敏」，确认模型调用 `memory_write`，
   控制台/领域里出现一条 `dietary_taboo`，`sourceMsgId` 指向该消息。
3. **真实记忆引用**：随后问「晚上吃什么」，确认草稿避开海鲜且 `citedMemoryIds`
   含该条 id（模型行为，不能由单测代替）。
4. **删除后不再引用**：删除该记忆，再问同样问题，确认草稿不再引用；历史草稿
   的引用 id 仍在。
5. **真实建计划**：说「明天早上提醒我量血压」，确认生成 `source=agent` 的计划。
6. **2 分钟到点**：把计划改到 2 分钟后，确认顾问 1:1 收到卡片且带「来源：Agent 主动」。
7. **Host 重启**：重启后确认 pending 计划仍在，并在 `when` 到点触发（含错过时间
   的计划是否立即补触发，按现场行为记录）。
8. **安静时段**：把计划设到 21:30，确认顺延到次日 08:00 触发。
9. **优先级**：同时制造 1 条患者提问与 3 条到期计划，确认顾问先收到患者提问草稿。
10. **限流**：把 `maxProactivePerHour` 设为 1，触发两条计划，确认第二条顺延。
11. **控制台接口**：`GET/POST /patients/{id}/care-plans`、记忆列表/编辑/删除
    目前只有进程内服务函数，HTTP 路由未实现（见 §6），需在接口层补齐后验收。

> 以上 1–11 未在真机验证前，不得在 PR / issue 中写「真机通过」。

---

## 6. 已知缺口

- **控制台 HTTP 接口未实现**：`zhibanMemory` / `zhibanCare` 已提供列表、编辑、
  软删除、手动新建、取消的进程内函数；[P1 API](./P1-api.md) 里的
  `/memories`、`/care-plans` 路由待控制台工作包接入。
- **同意状态**仍靠手工写入（#35 / #36 不解决 `check_room_agree` 同步）。
- **事件只到 DSH bus**：没有 SSE / 控制台订阅；`memory.*`、`care_plan.*`
  事件与审计已发出，前端接入随控制台包。
- **rrule 未实现**：非空直接拒绝，复杂随访方案二期。
- **主动计划存储**：`zhiban_care.plans` 是插件领域表，尚未与控制台数据模型
  的 `care_plans` 表合并（同一契约字段，后续迁移）。
- **安静时段只作用于 `when`**：`defer` 时也套用；如果计划在 08:00 前后与
  限流叠加，可能多顺延一轮，属预期保守行为。

---

## 7. 运维注意

- 日志只打计划 id / 患者 id / 原因码，**不打消息正文与记忆正文**。
- 统计：`PatientAgentRuntime.stats()` 增加 `proactiveDrafts` /
  `proactiveSkipped` / `proactiveDeferred`。
- 领域写入失败发 `alert.created(PERSIST_FAILED)`。
- 卸载 `zhiban-care` 先 `dispose()` 取消定时器，再等待落盘、关闭领域；
  卸载 `zhiban-memory` 先等待落盘再关闭领域。
