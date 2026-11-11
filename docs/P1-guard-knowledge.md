# P1 红线门禁与知识库（#37 / #38）

工作包 F。代码目录：

- `plugins/zhiban-guard/`：红线规则、草稿后校验、风险分级、升级告警
- `plugins/zhiban-knowledge/`：知识条目、skill 资源生成、引用命中统计
- `src/p1/guard.ts`、`src/p1/guard-tools.ts`、`src/p1/knowledge.ts`、`src/p1/knowledge-seed.ts`：可单测的纯逻辑

## 1. 总体结构

```
患者消息 ──► zhiban-patient runtime ──► reply_draft（模型草稿）
                     │
                     ▼
              zhibanGuard.review()        # 同步、进程内
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   命中 flag    命中 guide     命中 escalate
   抬高风险     正文改写为     正文改写为就医引导
   交顾问审核   就医引导        + critical 告警
                     │
                     ▼
              草稿进入 zhiban-wecom 卡片推送
```

- 门禁**不阻断**推送：命中的草稿仍会生成卡片，由顾问决定发不发。
- 校验是同步的，保证在同一回合内改写草稿后再入队。
- 日志、审计、告警、事件都不带患者消息正文与草稿正文，只带规则 id / 名称 / 等级。

## 2. #37 红线门禁

### 2.1 内置规则（只读，共 4 条）

| id | 名称 | 关键词（字面匹配） | 等级 | 动作 |
|---|---|---|---|---|
| `rul_builtin_no_diagnosis` | 不诊断 | 诊断、确诊、病情判断 | high | `flag` |
| `rul_builtin_no_medication` | 不调药 | 停药、减药、加量、换药 | high | `flag` |
| `rul_builtin_no_efficacy` | 不承诺疗效 | 保证、根治、包治、一定能好 | high | `flag` |
| `rul_builtin_emergency` | 急症只引导就医 | 胸痛、胸口很痛、胸口疼、呼吸困难、喘不上气、昏迷、意识不清、大出血、晕厥、抽搐 | high | `escalate` |

- 与 `docs/P1-data-model.md` §3.12 的四条内置红线一致，`builtin=true`，不可改、不可删。
- 服务启动时缺哪条补哪条并落盘，重启不会重复写入。

### 2.2 校验算法

1. `action=flag` 的规则用**字面包含**匹配草稿正文，防止 Agent 自己说出「停药 / 根治 / 诊断」这类违规内容。
2. `action=guide|escalate` 的规则**只**匹配本轮患者输入：急症证据必须来自患者本人（或其家属）的话，模型即使没在草稿里复述「胸痛」也会触发。草稿里的条件式提醒（如「如果出现胸痛、呼吸困难请立即就医」）是合规提示，不参与匹配，否则正常关怀草稿会被整段替换掉。改稿回合没有新消息时，沿用该患者最近一次入站文本（只在内存中保留，不落盘、不进日志）。
3. 命中规则写入草稿的 `ruleIds` / `ruleNames`，顾问卡片显示规则名称；未命中时卡片显示「无」。
4. 风险等级 = `max(模型自评, 所有命中规则等级)`。
5. 动作合并：
   - 任一 `escalate` → 改写正文为就医引导（`REFERRAL_BODY`），生成 `kind=escalate / severity=critical` 告警；
   - 否则任一 `guide` → 同样改写正文；
   - 仅 `flag` → 只抬高风险，正文不动。
6. 命中规则 `hitCount += 1`，写审计 `risk_rule.hit`，发 `risk_rule.hit` 事件。
7. 命中且 `escalate || riskLevel === 'high'` 时生成告警；普通 low/medium 命中不告警。告警创建时带 `patientId` / `groupId` / `sessionId` / `ruleIds`，草稿入队后由运行时代回调 `linkDraft` 回填 `draftId`。

`REFERRAL_BODY`：`您描述的情况需要尽快由医生处理。请立即拨打 120 或前往最近医院急诊，不要等待线上回复。`

### 2.3 自定义关键词规则

- 只允许创建 `kind=keyword` 的规则；字段：名称（≤40 字）、关键词（1–20 个，每个 ≤30 字）、等级、动作、启用状态。
- `update` / `remove` 对 `builtin=true` 返回 `IMMUTABLE_RESOURCE`。
- 删除会同时删除领域表记录；内置规则删不掉，避免租户把红线关掉。

### 2.4 `escalate_to_human` 工具

- 参数只有 `reason`：`emergency_symptom` / `patient_request` / `other`，不收患者原文。
- 插件用 `ctx.get('zhibanPatient').patientForSession(exec.agent.id)` 反查患者；查不到直接报 `INVALID_TOOL_ARGS`。
- 生成 `kind=escalate / severity=critical` 告警，`message` 只写原因，不写消息正文。

### 2.5 与患者运行时的衔接（跨包最小改动）

DSH 现有 hook 无法在 `reply_draft` 入队前改写参数（`tools/pre-execute` 只能放行/拒绝，`tools/post-execute` 已经太晚），因此：

- `src/p1/runtime.ts` 新增 `DraftGuardPort`（只有 `review(input)`），`replyDraft` 在 `enqueueDraft` / `reviseDraft` 之前调用它，并用返回的 `riskLevel`、`referralBody`；
- 命中后发 `draft.guard.hit`，并通过 `notifyAdvisor` 给顾问发一条只含规则名的提醒；
- `plugins/zhiban-patient/index.ts` 增加 `LazyDraftGuard`：启动时用 `ctx.get('zhibanGuard')` 懒解析，guard 未安装/未就绪时返回「未命中」，患者流程不受影响；
- 为 `escalate_to_human` 增加 `patientForSession(sessionId)` 只读方法。

> 这些文件属 D 包（`plugins/zhiban-patient/**`）。本 PR 的跨包改动已单独列出，合并前请 D 包负责人确认；不改动任何既有行为，未安装 guard 时完全走原路径。

### 2.6 插件装配与配置

```ts
// DSH profile
{ tenantId: 'tn_xxx', sandbox: false }
```

- 领域：`zhiban_guard`（`rules` / `alerts` / `audit`）。
- 提供 `zhibanGuard` 服务：`review`、`linkDraft`、`listRules`、`getRule`、`createRule`、`updateRule`、`deleteRule`、`escalate`、`alerts`、`audits`、`flush`。
- 事件：`risk_rule.created|updated|deleted|hit`、`alert.created`、`draft.guard.hit`、`audit`。

## 3. #38 知识库

### 3.1 数据与行为

- 条目字段与 `docs/P1-data-model.md` §3.11 一致：`knw_`、分类（≤30 字，自由文本）、标题（≤60 字）、正文（≤2000 字）、`enabled`、`hits`、软删除 `deletedAt`。
- 删除 = 软删除 + 停用；停用/删除的条目不会进入 skill 文件。
- 预置 30 条虚构示例（6 个分类 × 5–6 条），固定 id `knw_seed_01`–`knw_seed_30`，重复启动幂等。
- 示例内容只含通用生活建议，不含机构专属信息、诊断或用药建议。

### 3.2 skill 资源生成

- 按分类聚合**启用且未删除**的条目，每个分类一个 Markdown 文件。
- 文件名：`zhiban-knowledge-<分类名 FNV-1a 8 位哈希>.md`，避免中文/标点造成非法 skill 名；同哈希冲突时追加序号。
- 文件内容：YAML frontmatter（`name`、`description`）+ 每条 `## [knw_id] 标题` + 正文，并提示模型把用到的 id 填进 `citedKnowledgeIds`。
- 条目增/改/删/seed 后立即串行重写；`syncSkillFiles` 还会删除目录里过期的 `zhiban-knowledge-*.md`，不动其他文件。
- DSH profile 必须把 `skillDir` 加入 `customSkillDirs`，文件系统 skill provider 才会在下一轮加载（本仓库没有 profile 文件，这一步属于部署配置）。

### 3.3 引用命中统计

- 监听 DSH `tools/result`：`exec.name === 'reply_draft'` 且 `result.isError !== true` 时，读取 `exec.arguments.citedKnowledgeIds`。
- 只给「启用且未删除」的条目 `hits += 1`，写审计 `knowledge.hit` 并发事件；未知 id 忽略。
- 同一轮重复 id 只计一次。

### 3.4 插件装配与配置

```ts
// DSH profile
{
  tenantId: 'tn_xxx',
  skillDir: '/abs/path/to/dsh/skills/knowledge', // 同时加入 customSkillDirs
  workspaceRoot: '/abs/path/to/workspace',        // 可选，skillDir 为相对路径时使用
  seedExamples: true                              // 可选，默认 true
}
```

- 领域：`zhiban_knowledge`（`entries` / `audit`）。
- 提供 `zhibanKnowledge` 服务：`list`、`get`、`create`、`update`、`remove`、`categories`、`stats`、`recordCitations`、`sync`、`audits`、`flush`。
- 事件：`knowledge.created|updated|deleted|seeded|hit`、`audit`、`alert.created`（持久化或 skill 生成失败时）。

## 4. 本地验收（已通过）

运行：`npx tsc --noEmit && npm test`（182 个用例全部通过；新增 20 个）。

| 验收项 | 覆盖用例 |
|---|---|
| 4 条内置规则启动即补齐、不可改删 | `tests/guard.test.ts` 初始化用例 |
| 草稿命中调药词 → high、hitCount/审计/告警 | 草稿命中关键词用例 |
| 患者只说胸痛、草稿没复述 → 改写就医引导 + critical 告警 | 急症用例 |
| 自定义规则 CRUD、停用后不命中、guide 改写 | 自定义规则用例 |
| 参数校验（名称/关键词/等级/动作） | 规则校验用例 |
| 插件配置必填与 sandbox 默认值 | 配置用例 |
| `escalate_to_human` 只收原因枚举、会话反查患者、告警不带正文 | 升级工具用例 |
| 运行链路新草稿分支、改稿分支都过门禁 | 两条运行链路用例 |
| guard 未安装时患者流程不受影响 | `LazyDraftGuard` 用例 |
| 插件装配：内置规则落盘、工具注册、服务提供、卸载落盘 | 插件装配用例 |
| 30 条示例幂等 seed、6 个分类 | 示例知识用例 |
| 条目校验、CRUD、软删除、搜索 | 条目用例 |
| 引用命中只算启用条目、失败工具不计 | 引用命中用例 |
| 每个分类一个 skill 文件、停用/删除不出现 | skill 资源用例 |
| 重写删除过期文件、保留非本插件文件 | sync 用例 |
| 配置必填与相对路径解析 | 配置用例 |
| 插件装配：seed → 生成文件 → 命中累加 → 卸载 | 知识插件用例 |

## 5. ⏳ 待真机验证

| 项 | 步骤 |
|---|---|
| DSH 插件加载顺序 | 同时启用 `zhiban-guard` 与 `zhiban-patient`，确认先加载 patient 时 `LazyDraftGuard` 在首个回合前能解析到 guard |
| `exec.agent.id` 与患者会话一致 | 真模型触发 `escalate_to_human`，确认能反查到患者；查不到时应报错且不产生告警 |
| 真模型引用行为 | 观察模型是否按 skill 提示填写 `citedKnowledgeIds`；未填写时 hits 为 0 属预期 |
| skill 发现 | 把 `skillDir` 写入 profile 的 `customSkillDirs`，重启后确认 6 个 skill 出现在 Agent 技能列表 |
| skill 文件限制 | 确认 DSH 对 skill 文件名长度与文件大小无额外限制（当前单分类约 1–3 KB） |
| 落盘与重启 | 重启后规则 hitCount、告警、知识条目与 hits 保留 |
| 告警可见性 | 控制台服务流/告警页能读到 `alert.created` 与 `zhibanGuard.alerts()`（HTTP 路由尚未实现） |
| 顾问提醒 | 命中规则后顾问 1:1 收到不含正文的提醒 |
| 文件权限 | 运行用户对 `skillDir` 有读写权限；生成失败时应出现 `SKILL_SYNC_FAILED` 告警 |
| 下一轮生效 | 控制台改知识/规则后，下一轮会话按新规则/新 skill 工作 |
| 租户隔离 | 两个租户使用不同 `tenantId` 与领域库时规则/知识互不可见 |

## 6. 已知缺口

- 控制台所需 HTTP 路由（`/zhiban/api/rules`、`/knowledge`、`/alerts`）尚未实现，目前只提供 DSH 服务接口。
- 自定义关键词规则只做输出后校验，不注入系统提示词；静态红线仍由 `src/p1/persona.ts` 每轮注入。
- 关键词是字面包含，不做分词/正则/否定识别；「不能保证」也会命中「保证」，但只抬高风险、不阻断。
- 告警只有 `open` 状态，确认/解决流程留给控制台包。
- 知识正文按受信任的租户内容处理，未做内容安全过滤；写入 skill 前只做长度校验。
- 未实现 `risk-rules.json` 中 3 条示例关键词规则的运行时种子（fixtures 仍可用于控制台演示）。
