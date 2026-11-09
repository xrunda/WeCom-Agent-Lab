# 知伴健康 Agent · P1 开发指南（多 Agent 并行）

> 读者：参与 P1 开发的 AI Agent（以及带它们的人）
> 读完本文就可以开工：认领一个工作包，在独立工作树里开发，一个工作包提交一个 PR，等项目负责人 review 和合并。
> 版本：2026-11-09 · 维护人：项目负责人

---

## 0. 五条铁律（违反任何一条，PR 一律退回）

1. **不合并，不推 main。** 只推自己的分支，只开 PR。合并由项目负责人手动完成。不要 force push 别人的分支，也不要动 `main`。
2. **一个工作包一个分支、一个 PR。** 不要每个 issue 开一个 PR；也不要越界去改别的工作包负责的目录（§5）。
3. **不提交、不打印任何密钥。** `.env.local`、`config.txt`、私钥、Secret、Token、CorpID 都不进 git、日志、PR 描述和评论。仓库根目录的 `.env.local` 是真实凭据：**不要 cat、不要 grep、不要读取它的内容**，代码只通过环境变量取值。
4. **不伪造验收。** 本地能验证的就验证；需要真机、服务器或企微后台的验收项，在 PR 里标「⏳ 待真机」，写清验证步骤，交给项目负责人执行。**禁止把 mock 通过写成真机通过。**
5. **不违反平台硬约束。** 任何「机器人 / Agent 自动发到客户群」的设计都不成立（F1）。动手前先读交接文档 §1 的 F1–F15。

---

## 1. 开工前必读（按顺序，约 15 分钟）

| 顺序 | 文档 | 读什么 |
|---|---|---|
| 1 | [PRD.md](../PRD.md) | 产品是什么、原则（§5）、不做什么（§12） |
| 2 | [docs/P1-scope.md](./P1-scope.md) | 决策 D1–D16、A/B/C 分档、架构（§3）、页面（§4）、Agent 行为（§5） |
| 3 | [docs/HANDOFF-C2-business-product.md](./HANDOFF-C2-business-product.md) | §1 平台事实 F1–F15、§4 已实现、§6 三个接缝 |
| 4 | 你认领的工作包里的每一个 issue | 范围、不做、验收标准、依赖。**issue 是验收的唯一依据** |
| 5 | `docs/P1-api.md`、`docs/P1-data-model.md` | 接口和数据契约（WP-A 产出后才有） |
| 6 | `docs/P1-M0-dsh-validation.md` | DSH 的插件形态、注入会话的接口、路由方式（WP-B 产出后才有） |

现有代码的入口：`src/c2/`（C2 核心，73 个测试，真机验证过）、`src/c2/live-e2e.ts`（真实链路）、`experiments/minimal/session-archive/`（存档 SDK 的 C++ 工具）。

---

## 2. 工作包

38 个 issue 合并成 14 个工作包。**工作包是认领、分支和 PR 的单位。** GitHub 上每个 issue 都带了 `wp-x` 标签。

| 包 | 名称 | Issue | 前置条件（必须**已合并**） | 估时 |
|---|---|---|---|---|
| **A** | 契约与数据模型 | #62 | 无 | 0.5d |
| **B** | M0 底座验证（闸门） | #28 #29 #30 | 无。#29、#30 先在**本机 DSH** 上验证；#28 的服务器部分写成安装脚本加步骤，由项目负责人在服务器上执行（§8） | 2d |
| **C** | 企微通道 | #31 #32 #54 #65 | #31 无前置；#32、#54、#65 需要闸门通过。**固定拆成 2 个 PR**：(1/2) #31 立即做；(2/2) 其余 | 4d |
| **D** | 患者路由与 Agent 回合 | #33 #34 #63 #56 | A、B、C | 5.5d |
| **E** | 记忆与主动计划 | #35 #36 | D | 2d |
| **F** | 红线与知识库 | #37 #38 | D | 2d |
| **G** | 图片理解与质量评测 | #55 #64 | C、D、E、F | 2.5d |
| **H** | 控制台后端 | #41 #39 #40 | A、B；#39 还需要 C；#40 还需要 D、E | 4d |
| **I** | 控制台骨架 | #42 | A | 1d |
| **J** | 前端：服务中心 | #43 #44 #47 #57 | I | 5d |
| **K** | 前端：患者与团队 | #45 #46 | I | 3d |
| **L** | 前端：配置与展示 | #48 #49 #50 #51 | I | 4.5d |
| **M** | 前端：商业页面 | #58 #59 #61 | I、H | 2d |
| **N** | 上线 | #52 #60 #53 | 全部（#52 可提前） | 3.5d |

**前端包（J、K、L）只依赖 I 和契约**，按 `console/src/mock/` 开发和验收；后端接口就绪后，在同一个包里（或后续小 PR 里）切换到真接口再验一次。

### 2.1 开发波次

```text
第 1 波（立即）   A 契约 ──┐        B M0 验证（闸门）       C 中的 #31 日志脱敏
                          │
第 2 波           I 骨架 ◀┘        ⛔ 闸门评审：B 合并 + 项目负责人确认 M0 结论
                                          │
第 3 波           J  K  L（前端，mock）    C 余下 → D → E、F（可并行）     H
                                          │
第 4 波           M 商业页面               G 图片与评测                   前端切真接口
                                          │
第 5 波                              N 上线（播种 → 走查）
```

**闸门**：B 合并后，项目负责人会对照 M0 结论检查 #33、#41、#36 是否需要调整。**闸门放开之前，不要开工 C 余下部分、D、H。** 放开的标志是 #29 关闭，并且 #29 下面有项目负责人「闸门通过」的评论。

**第 2 周检查点**：D、J、K 合并后，沙盒、服务流、患者 Agent 主页要能端到端演示，项目负责人会先体验一次。

### 2.2 同时开几个 Agent

依赖关系决定了大约 **4～5 个 Agent** 并行最合适。第 1 波 3 个（A、B、C 中的 #31）；第 3 波最多 6 个（J、K、L、C/D、E、F 或 H）。再多也只会排队等依赖。

---

## 3. 认领流程

### 3.1 决定做哪个包

- 带你的人在提示词里**指定了工作包**（例如「读 docs/DEV-GUIDE.md，做 WP-E」）：直接做那个包
- **没有指定**：按 §2 的表从上往下找第一个满足以下三个条件的包：
  1. 前置条件全部已合并（`gh pr list --state merged`、看 issue 是否已关闭）
  2. 包内 issue 没有 `status:in-progress` 或 `status:in-review` 标签
  3. 不在闸门后面，或者闸门已经通过

```bash
R=xrunda/WeCom-Agent-Lab
gh issue list -R $R --label wp-e --state all --json number,title,state,labels
```

### 3.2 认领

给包内**每个** issue 打标签并留言，留言里写清是谁、在哪个分支：

```bash
for n in 35 36; do
  gh issue edit $n -R $R --add-label status:in-progress
  gh issue comment $n -R $R --body "认领：WP-E，分支 p1/wp-e-memory-care，开工于 $(date '+%F %H:%M')"
done
```

认领后发现已经有人在做（标签是刚刚被别人打上的）：撤回自己的标签和评论，换一个包。

### 3.3 工作树（多个 Agent 共用一台机器时必须用）

每个 Agent 在自己的 git worktree 里工作，**不要在主目录里切分支**，否则会互相覆盖。

```bash
cd /Users/liguang/Documents/xRunda/project/AI/github/WeCom-Agent-Lab
git fetch origin
git worktree add ../zhiban-wp-e -b p1/wp-e-memory-care origin/main
cd ../zhiban-wp-e && npm ci
```

分支命名：`p1/wp-<包字母>-<英文短名>`。

---

## 4. 开发约定

### 4.1 目录结构（目标形态）

```text
src/c2/                     C2 核心（WP-C 负责迁移；迁移前不要动）
plugins/
  zhiban-wecom/             WP-C
  zhiban-patient/           WP-D
  zhiban-memory/            WP-E
  zhiban-care/              WP-E
  zhiban-guard/             WP-F
  zhiban-knowledge/         WP-F
  zhiban-console/           WP-H（业务接口由各包在自己的路由文件里添加，见 §5）
console/                    控制台前端（WP-I 搭骨架）
  src/pages/<page>/         每个页面一个目录，归属见 §5
  src/mock/                 mock 层与 fixtures
  src/sample/               B 档示例数据集（WP-L 负责 #49）
eval/drafts/                草稿评测集（WP-G）
docs/
```

**插件的打包形态**（每个插件一个包，还是一个包里注册多个插件；JS 还是 TS；共享代码放在哪里）**以 WP-B 的结论为准**，写在 `docs/P1-M0-dsh-validation.md`。在那之前，上面只是目标目录。

### 4.2 技术栈与版本

| 项 | 约定 |
|---|---|
| Node | ≥ 22.6（本机为 24.13）。现有代码是直接运行 TS（类型擦除），保持这种方式，不引入编译步骤，除非 WP-B 证明 DSH 必须用 JS |
| DSH | **精确锁定 0.2.1-rc.5**，不升级，不用 `latest`/`next` 标签 |
| 模型 | DeepSeek V4.1 Flash，只在 DSH 模型设置里配置，代码里不出现 API Key |
| 前端 | Vite + React 18 + TS + Ant Design 5 + ProComponents + ECharts；包管理器用 **npm**（仓库已有 `package-lock.json`） |
| 存储 | DSH `storage-sqlite` / `storage-domain`；数据模型以 `docs/P1-data-model.md` 为准 |
| 测试 | 后端用 `node --test`；前端用 Vitest + Testing Library（WP-I 引入） |

### 4.3 编码规则

- **契约优先**：接口、事件、字段以 `docs/P1-api.md` 和 `docs/P1-data-model.md` 为准。需要改契约时，在自己的 PR 里**只做新增**（加字段、加接口），并在 PR 描述的「契约变更」一节列出；要删改已有字段，先在 #62 下评论，等项目负责人确认
- **C2 核心不改逻辑**：`C2Service`、`SerialQueue`、`Verifier`、`ArchiveTrigger` 只换端口实现。原有 73 个测试必须一直通过
- **通用化**：代码、界面、示例数据里不出现「七通」（`grep -ri 七通` 必须为空）。机构名、Agent 名、称谓一律从租户设置读取
- **分档**：B 档页面用 `<SampleDataTag/>`，C 档页面用 `<ComingSoonPage/>`；A 档页面禁止使用写死的假数据
- **隐私**：日志里不打消息正文（#31 的规则对所有新代码都生效）；测试和示例只用虚构数据
- **注释和文档用中文**，标识符用英文
- 不引入大型依赖，除非 issue 里写了；新增依赖要在 PR 描述里说明理由

### 4.4 提交

- 粒度：一个 issue 至少一个提交，便于 review 时按 issue 看
- 格式：`<类型>(<范围>): <说明> (#issue)`，例如 `feat(memory): 记忆写入工具与每轮注入 (#35)`；类型用 feat / fix / test / docs / refactor / chore
- 提交信息末尾按你所在环境的要求加署名

---

## 5. 文件归属（防止并行冲突）

| 路径 | 归属 | 其他包可以做什么 |
|---|---|---|
| `docs/P1-api.md`、`docs/P1-data-model.md` | A | 只能做新增，见 §4.3 |
| `src/c2/**`、`experiments/minimal/session-archive/**`、`plugins/zhiban-wecom/**` | C | 只读 |
| `plugins/zhiban-patient/**` | D | 只读 |
| `plugins/zhiban-memory/**`、`plugins/zhiban-care/**` | E | 只读 |
| `plugins/zhiban-guard/**`、`plugins/zhiban-knowledge/**` | F | 只读；G 可以在 `zhiban-guard` 里新增图片相关规则文件 |
| `plugins/zhiban-console/` 的框架、登录、SSE、审计 | H | 各业务包在 `plugins/zhiban-console/routes/<包字母>-*.ts` 里加自己的路由文件，不改框架文件 |
| `console/` 的根配置、布局、路由表、菜单、通用组件 | I | **I 必须为 §4 的每个页面预先建好路由和占位页面文件**，后续包只改自己的页面目录 |
| `console/src/pages/{service-flow,sandbox,alerts}/**` | J | — |
| `console/src/pages/{patients,groups,advisors}/**` | K | — |
| `console/src/pages/{knowledge,rules,scripts,dashboard,reports,skills,solutions,settings}/**`、`console/src/sample/**` | L | M 可以在 `dashboard/` 里新增价值条组件文件，在 `settings/` 里新增两个子页面目录 |
| `console/src/pages/{onboarding}/**`、`dashboard/ValueBar*`、`settings/{security,onboarding}/**` | M | — |
| `eval/**` | G | — |
| `docs/P1-deploy.md`、`docs/P1-environments.md`、`docs/P1-demo-seed.md` | N（`P1-environments.md` 归 C 的 #65） | — |
| 根目录 `package.json` / `package-lock.json` | 共享 | 只做新增；提 PR 前先 rebase 到最新 main，重新 `npm install` 生成 lock |
| `ISSUES.md` | **项目负责人** | **PR 里不要改**，合并后由项目负责人统一同步状态 |

碰到必须改别人目录的情况：**不要改**，在对应 issue 下评论说明需求，然后继续做自己的部分。

---

## 6. 完成标准（每个 issue）

- [ ] issue 里的每一条「范围」都做了；「不做」里的一条也没做
- [ ] 每条「验收标准」都标了结果：✅ 本地已验证 / ⏳ 待真机（附步骤）/ ❌ 未达成（附原因）
- [ ] `npm test` 全部通过（包括原有 73 个）；新逻辑有对应的测试
- [ ] `npx tsc --noEmit` 无错误
- [ ] 前端：mock 模式下所有相关页面能点，无白屏、无控制台报错；附截图（1440 宽）
- [ ] `grep -ri 七通` 结果为空（租户种子数据除外）；diff 里没有密钥
- [ ] 契约有新增的话，已更新 `docs/P1-api.md` / `docs/P1-data-model.md`

---

## 7. 提交 PR

工作包里**所有** issue 都完成后，提**一个** PR。工作包超过 4 天、或者 diff 太大不好 review（超过 3000 行，lock 文件不算）时，可以拆成**最多 2 个**按依赖排好顺序的 PR，在标题里注明 `(1/2)`、`(2/2)`。

```bash
git fetch origin && git rebase origin/main && npm test
git push -u origin p1/wp-e-memory-care
gh pr create -R $R --base main --title "[WP-E] 记忆与主动计划（#35 #36）" --body-file /tmp/pr-body.md
for n in 35 36; do gh issue edit $n -R $R --remove-label status:in-progress --add-label status:in-review; done
```

有「⏳ 待真机」验收项的 issue，再加上 `needs-device` 标签。

### PR 描述模板

```markdown
## 工作包
WP-E 记忆与主动计划

Closes #35
Closes #36

## 做了什么
（按 issue 分节，每节 3～5 行，讲清主要设计决策）

## 验收结果
### #35 长期记忆
- [x] ✅ 说「我对海鲜过敏」→ 新增饮食禁忌记忆（本地 DSH + mock 渠道；测试：tests/memory.test.ts）
- [ ] ⏳ 待真机：……（步骤：1. … 2. …；预期：…）

### #36 主动计划
- …

## 测试
（npm test 的汇总输出；前端附截图）

## 契约变更
（没有就写「无」）

## 需要项目负责人做的事
（真机步骤、后台配置、要提供的凭据。没有就写「无」）

## 已知问题与后续
```

PR 提交后，Agent 的工作就结束了，**不要等合并**。review 意见会以 PR 评论的形式给出；被要求修改时，在同一个分支上继续提交，不要新开 PR。

---

## 8. 需要人来做的事

以下事项 Agent 做不了，遇到了就在 PR 的「需要项目负责人做的事」里列出，并给 issue 加 `needs-device` 标签。被这些事项卡住的部分先跳过，继续做能做的：

| 事项 | 涉及 |
|---|---|
| 登录腾讯云 Ubuntu 服务器（存档可信 IP 在这台机器上） | #28 部署、#52、所有真机验收 |
| 企微后台操作（建第二个机器人、授权、可信 IP） | #65、#33 同意状态接口 |
| 真实凭据：企微 Secret、机器人凭据、DeepSeek API Key | 所有真机链路 |
| 在测试群里用个人微信发消息、在企微里点按钮 | 所有「真机：」验收项 |
| 子域名与证书 | #52 |
| 抽查评测集是否像真实患者的提问 | #64 |

**本地能做的尽量在本地做**：本机已安装 DSH 0.2.1-rc.5（`dsh --version`），可以用独立 profile 跑插件；企微侧用 `src/c2` 里的假端口（`npm run demo` 那一套）。

---

## 9. 遇到问题怎么办

| 情况 | 做法 |
|---|---|
| issue 写的和实际情况冲突（接口不存在、约束不成立） | 不要自行改需求。在 issue 下评论：现象、证据、建议方案，然后做不受影响的部分 |
| 前置包没合并，但你已经认领了 | 用 mock / 假端口先开发，PR 描述里写明「依赖 #x 合并后需要再验」 |
| 和别的包有冲突 | 按 §5 归属来；归属不清的，在双方 issue 下评论，等项目负责人裁定 |
| DSH 行为和文档不一致 | 以实测为准，补充到 `docs/P1-M0-dsh-validation.md`（只做新增），在 #29 下评论 |
| 中途放弃 | 移除 `status:in-progress` 标签，在 issue 下评论已完成的部分和分支名，把分支推上去 |

---

## 10. 给带 Agent 的人：启动提示词

在新会话里给 Agent 下面这段话，替换包字母即可：

```text
读 docs/DEV-GUIDE.md，按指南认领并完成工作包 WP-E。
在独立 worktree 中开发，完成后提一个 PR，不要合并。
```

不指定包时：

```text
读 docs/DEV-GUIDE.md，按指南自行选择一个可开工的工作包，认领并完成，提一个 PR，不要合并。
```

建议的第一波：三个会话分别做 **WP-A**、**WP-B**、**WP-C 的 (1/2)（只做 #31）**。C 的 (2/2) 在闸门通过后另开会话继续，提示词写「继续 WP-C 的 (2/2)」。
