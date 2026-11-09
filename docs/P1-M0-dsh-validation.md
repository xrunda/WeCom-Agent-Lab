# P1 M0 DSH 底座验证

> 工作包：WP-B（#28 / #29 / #30）
> 验证日期：2026-11-09
> 验证环境：macOS 本机 + DSH 0.2.1-rc.5 + Node.js v24.13.0 + DeepSeek-V4.1-Flash
> 结论性质：本机验证；Ubuntu VM 上的 systemd、开机自启、kill 后拉起标为 **⏳ 待真机**。
> 验证插件与脚本：[`experiments/m0-dsh-validation/`](../experiments/m0-dsh-validation/)

## 0. 结论摘要

| Issue | 结论 | 说明 |
|---|---|---|
| #28 | **本机通过；服务器部分 ⏳** | DSH 0.2.1-rc.5、独立 `zhiban` profile、DeepSeek-V4.1-Flash、hello 插件、5 张餐食照片 + 1 张虚构化验单均已在本机验证；systemd / 开机自启 / kill 拉起 / Web UI 手工复核待 Ubuntu VM |
| #29 | **可行，无需回退** | 插件在没有客户端连接时，可通过公开接口向指定长期会话注入消息并触发回合，并能捕获 `reply_draft` 工具参数；连续注入、忙时注入、重启后继续注入均验证通过 |
| #30 | **五项均可行；Connection Fetch 有认证边界** | Connection Fetch GET/POST 可用，但只对 owner 开放（未认证 401）；控制台 API/SSE 应使用 `ctx.webServer.register`。SSE 60 秒、schedule 一次性/cron、提醒投递与跨重启、插件清单均验证通过 |

**对后续包最重要的三个结论：**

1. **「一位患者 = 一条长期会话」成立。** P1-R-03 直接用 `sessionController.prompt`（患者消息）和 `resolveAgent + agent.followup`（主动投递），不需要回退到「每条消息开子任务会话」。
2. **控制台 API 不要用 Connection Fetch 对服务端开放。** 它对未认证的外部 curl 返回 401；应使用 `ctx.webServer.register`，并自行加认证、限流和来源限制。
3. **看图能力可用于起草，但不能自动定稿。** 食物识别和化验单转录质量不错；模型会主动做疾病倾向解读，必须在 #55 的提示词里明确「只描述、不诊断、不处方」。

---

## 1. #28：DSH Host 常驻 + 模型 + hello 插件 + 看图摸底

### 1.1 安装与目录布局

**本机实际版本：**

| 项 | 值 |
|---|---|
| DSH | `0.2.1-rc.5`（`npm install -g @deepseek-ai/dsh@0.2.1-rc.5`） |
| Node.js | `v24.13.0`（DSH 要求 >= 22.6） |
| 模型 | `provider: deepseek-official`，`model: deepseek-flash`，catalog 名 `DeepSeek-V4.1-Flash` |
| Web 监听 | `127.0.0.1:3399`（仅本机） |
| 插件数 | 196（含 DSH 内置插件与两个验证插件） |

**DSH_HOME 与 profile 布局：**

```text
$DSH_HOME/                              # 本机默认 ~/.dsh；服务器建议 /var/lib/zhiban/dsh
├── profiles/
│   └── zhiban/
│       ├── package.json                # 声明 bundles: dsh-base + dsh-web-app
│       ├── cordis.yml                  # 空根（[]），不要在这里写插件
│       ├── cordis.patch.yml            # 用户覆盖层：insert zhiban-hello / zhiban-m0
│       └── pnpm-workspace.yaml
├── sessions/                           # 会话持久化
└── storages/                           # schedule 等存储
```

`package.json` 的关键内容：

```json
{
  "name": "dsh-profile-zhiban",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

`cordis.patch.yml` 的关键内容（路径由部署脚本生成，下面是本机形态）：

```yaml
- insert:
    - id: zhiban-hello
      name: /absolute/path/to/experiments/m0-dsh-validation/plugins/zhiban-hello.js
    - id: zhiban-m0
      name: /absolute/path/to/experiments/m0-dsh-validation/plugins/zhiban-m0.js
      config:
        cwd: /absolute/path/to/workspace
        sseSeconds: 60
        turnTimeoutMs: 180000
```

**创建与启动命令：**

```bash
# 从官方 web 模板创建 profile；--dump-config 只组合配置，不启动服务
dsh --profile zhiban --from-default-profile web --dump-config

# 启动：profile 名称已经选择了应用，后面不要再加 web 位置参数
dsh --profile zhiban --no-open --host 127.0.0.1 --port 3399
```

两个容易踩的坑：

- `dsh --profile zhiban web ...` 会报 `too many arguments`；`--profile` 已经选定了应用，不要再传 `web`。
- `--host 0.0.0.0` 不被接受；只接受具体本机地址。需要给控制台访问时，绑定内网地址并用安全组/防火墙限制，不要对公网开放。

**profile 校验：**

```bash
dsh --profile zhiban --dump-config | grep -E 'zhiban-(hello|m0)'
```

本机输出能看到 `zhiban-hello` 和 `zhiban-m0` 两条 insert；`zhiban-m0` 的 `config` 也正确展开。

**健康检查（本机实测）：**

```json
{
  "ok": true,
  "plugin": "zhiban-m0",
  "node": "v24.13.0",
  "model": { "provider": "deepseek-official", "model": "deepseek-flash" },
  "plugins": 196,
  "cwd": "/tmp/zhiban-m0/workspace"
}
```

### 1.2 hello 插件与模型调用

[`plugins/zhiban-hello.js`](../experiments/m0-dsh-validation/plugins/zhiban-hello.js) 不依赖任何
`@deepseek-ai/*` 包，只注册一个 `hello` 工具：

```js
import { randomUUID } from 'node:crypto'

export const name = 'zhiban-hello'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'hello',
    description: '向指定的人问好，返回一句中文问候。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
    // output.schema + output.render 省略
    async execute(args) {
      const who = args?.name?.trim() || '世界'
      return { message: `你好，${who}。zhiban profile 的 hello 插件已加载。`, callId: randomUUID() }
    },
  })
  ctx.effect(() => dispose)
}
```

**本机实测（通过 DSH Web 服务的模型会话，不是浏览器 UI 手工点击）：**

```text
回合 1，completed，3250ms
模型回复：
已调用 `hello` 工具（参数 `name` = 「M0 验证」），工具返回的原话是：
> 你好，M0 验证。zhiban profile 的 hello 插件已加载。
```

这证明 profile 加载链路、工具注册和模型工具调用都通。

**⏳ 待真机：** 在 DSH Web 浏览器里手工新开会话，确认模型下拉框显示
`DeepSeek-V4.1-Flash`，并在 UI 里触发一次 hello 工具。本机是通过 HTTP/插件会话验证的，
不把“UI 手工复核”写成已通过。

### 1.3 插件打包形态建议（给 C 之后的包）

M0 验证了两种入口文件，DSH 都能按绝对路径直接加载：

| 形态 | 结果 | 说明 |
|---|---|---|
| `.js` ESM | ✅ | `zhiban-hello.js` / `zhiban-m0.js`，无构建步骤 |
| `.ts` ESM（含类型标注、相对 import 另一个 `.ts`） | ✅ 本机 Node 24.13 | 单独建了临时插件，`/ts-test/health` 返回 `{"ok":true,"plugin":"ts-test","message":"hello M0"}` |

**建议 P1 采用：**

- **每个领域插件一个目录/包**：`plugins/zhiban-wecom/`、`plugins/zhiban-patient/`、`plugins/zhiban-memory/` 等，
  入口 `index.ts`，`package.json` 声明 `"type": "module"`。不要把所有逻辑塞进一个插件。
- **直接用 TypeScript 源码，不做构建**：Node 24 的类型擦除可以直接运行 `.ts`；相对 import 写
  `./shared.ts` 这种带扩展名的形式。M0 已验证“入口 TS + 相对 import TS”可加载。
- **服务器固定 Node 24.x**（本机 24.13.0）。如果部署机只有 Node 22.6，类型擦除需要
  `--experimental-strip-types`，而 DSH 不一定替你传这个 flag；这种情况下改用 `.js` 入口或预编译。
- **共享代码放在仓库内的相对路径**，不要依赖 tsconfig 的 path alias；Node 解析不到。也不要把未编译的
  TypeScript 放进 `node_modules` 让 DSH 去加载（类型擦除默认不处理 `node_modules`）。
- **profile patch 的 `name` 用部署机绝对路径**（如 `/opt/zhiban/plugins/zhiban-wecom/index.ts`）或
  已安装的包 id；不要用相对路径。
- 插件导出形态保持 `export const name`、`export const inject`、`export function apply(ctx, config)`；
  需要配置时用 `Config` schema。M0 的两个插件就是最小模板。

**不推荐：** 在插件里自己起独立 HTTP 端口（除非 WebServer 路由确实不够）；M0 已证明
`ctx.webServer.register` 足够覆盖控制台 API 与 SSE，少一个监听面就少一处运维和安全负担。

### 1.4 看图摸底

**方法：** 5 张 Wikimedia Commons 公开授权餐食照片 + 1 张本地生成的虚构化验单。
5 张餐食照片不提交进仓库，运行 `scripts/fetch-images.sh` 下载到本地缓存；虚构化验单作为
固定 fixture 提交在 `assets/06-lab-report-synthetic.png`。再由 `scripts/vision-probe.py` 逐张发给
`deepseek-flash`（V4.1 Flash）。

**图片与耗时（完整草稿那一轮）：**

| 图片 | 来源 / 许可 | 耗时 | 识别内容（摘要） | 不确定点 |
|---|---|---:|---|---|
| 01 汤面 | Shisma / CC BY 4.0 | **60.9s** | 单人份深色清汤细面；半个溏心蛋、深褐纤维状配料、黑色木耳状片、浅米色片、葱圈；估算 350–550 kcal、碳水 45–60g、蛋白 18–28g、脂肪 11–18g | 深褐配料是笋干/卤肉/菌菇无法确定；面条总量被遮挡；汤底油量未知 |
| 02 凯撒沙拉 | Telluride / CC BY-SA 3.0 | **29.1s** | 煎/烤鸡胸、罗马生菜/苦苣/红叶生菜/芝麻菜、面包丁、黑橄榄、可能有帕玛森；估算 700–1050 kcal、碳水约 55g、蛋白约 47g、脂肪约 48g | 酱汁是蛋黄酱还是酸奶基；面包丁烤还是炸；是否有培根/坚果 |
| 03 玛格丽特披萨 | Shisma / CC BY 4.0 | **33.8s** | 两片薄底玛格丽特，番茄酱、马苏里拉、罗勒、豹纹焦斑；约合 30–35cm 披萨的 1/4–1/3；估算 600–720 kcal、碳水 68–82g、蛋白 25–32g、脂肪 22–30g | 红色圆片可能是番茄也可能萨拉米；奶酪用量和是否淋油；饼底厚度 |
| 04 寿司拼盘 | chidorian / CC BY-SA 2.0 | **58.0s** | 日式寿司拼盘，握寿司为主，金枪鱼/三文鱼/熟虾/章鱼/玉子烧/细卷/军舰；约 35–45 件，估算 1800–2200 kcal | 件数被叠压；白身鱼品种；右上角小菜；醋饭糖盐比例 |
| 05 泰式蒸点柜 | Alpha / CC BY-SA 2.0 | **89.2s** | 识别为泰国街头不锈钢蒸点展示柜，不是一份装盘餐食；四层：蒸包、虾饺、烧卖、绿皮点心、虾卷等；读出价目 25/20 泰铢；按每件给 40–70 kcal | 玻璃水汽/反光；最下层看不清；绿皮颜色来源；每碟实际件数 |
| 06 虚构化验单 | 本地生成，虚构数据 | **17.0s** | 8 项全部逐项转录正确（FPG 7.8、HbA1c 7.4%、TC 6.2、LDL-C 4.1、TG 2.5、UA 468、Cr 78、ALT 32），6 项偏高、2 项正常 | 无（图面清晰）；但模型主动给出疾病倾向判断 |

> 耗时是“要求把完整分析写进 reply_draft”的那一轮；同一批图第一次只要求摘要时耗时更低
> （约 12–70s）。同一模型、同一图片的延迟会在 **12–89 秒**之间波动，规划时按最慢值留余量。
> 单张图 token：输入 170–260，输出 257–426，cache read 约 1.7万–3.3万，总计约 2.1万–3.3万。

**看图结论：**

1. **餐食识别可以支撑“草稿”，不能直接当最终记录。** 主要食物、烹饪方式、结构判断基本可用；
   份量和热量是区间估算，模型自己也标了 ±25–30% 的不确定度。P1 应把“份量/热量”展示为
   估算区间，并允许顾问或患者修正。
2. **场景识别比单纯食物识别更有价值。** 第 5 张不是一盘菜，模型正确识别为“整柜售卖展示”，
   没有硬凑成一人份；这能避免把“一整柜”错记成一餐。
3. **化验单 OCR 质量好。** 8 项数值、单位、参考范围、异常箭头全部正确转录（对照虚构样本）。
4. **模型会主动解读化验指标，而且会给疾病倾向判断。** 第 6 张在“给一句总体解读”的要求下，
   主动归纳为“糖脂代谢紊乱合并高尿酸血症为主的代谢综合征样表现”，并建议内分泌科/心血管内科
   评估，`riskLevel` 自评 `medium`。这是产品需要的能力，也是合规风险点：**不能让它直接对患者
   下诊断或给治疗建议。**
5. **图片回合明显慢于文本。** 最慢 89 秒；P1 必须异步处理：先回执“正在识别”，用队列串行，
   超时上限至少 180 秒；上传前压缩到约 1280px，避免原图直传。
6. **本批图片不代表真实企微场景。** 都是公开图/合成图，光线好、无压缩、无手写报告、无多菜混合。
   真实场景（企微压缩、低光、手写、遮挡）必须另做小样本测试，不能把本批结果写成真机通过。

**给 #55 的提示词策略建议：**

- 角色写死：“健康管理助手，只做信息整理和风险提示，不做诊断、不开药、不替代医生。”
- 输出分两段：**逐项转录**（原文/数值/单位/参考范围/异常标记）和**总体说明**（只归纳异常项，
  建议咨询医生；禁止输出疾病确诊名、药物名、剂量）。
- 对化验单强制结构化输出：`items[]`、`abnormal[]`、`summary`、`followUpQuestions[]`；
  不要自由长文，控制输出长度和延迟。
- 对餐食强制区分“看到的”和“推测的”；份量/热量给区间；看不清时先问，不要编。
- 继续坚持“草稿给顾问、不自动发给客户”（F1）。

### 1.5 服务器 / systemd（⏳ 待真机）

本机没有 Ubuntu VM 权限，以下项目**未执行**，只提供了可执行步骤和 unit：

| 验收项 | 状态 | 说明 |
|---|---|---|
| `systemctl restart` 后恢复 | ⏳ | unit 与步骤见 [`deploy/README.md`](../experiments/m0-dsh-validation/deploy/README.md) |
| `dsh --profile zhiban --dump-config` 看到 hello | ✅ 本机 | 服务器上需用 `DSH_HOME=/var/lib/zhiban/dsh` 再跑一次 |
| Web UI 新开会话，模型为 V4.1 Flash，能调 hello | ⏳ UI 手工复核 | 本机已通过 Web 服务的模型会话验证模型与工具 |
| kill 主进程 10 秒内被 systemd 拉起 | ⏳ | 本机只验证了 SIGTERM 重启后会话/提醒恢复 |
| 仅监听内网/本机 | ✅ 本机 127.0.0.1；⏳ 服务器 | unit 默认 `127.0.0.1:3080`，不要改成 `0.0.0.0` |
| API Key 只在部署侧 | ✅ 文档约束 | 使用 `/etc/zhiban/dsh.env`（0600），不进 git/日志/PR |

systemd unit 在 [`deploy/dsh-zhiban.service`](../experiments/m0-dsh-validation/deploy/dsh-zhiban.service)，
关键配置：

```ini
User=zhiban
Environment=HOME=/var/lib/zhiban
Environment=DSH_HOME=/var/lib/zhiban/dsh
EnvironmentFile=-/etc/zhiban/dsh.env
ExecStart=/usr/local/bin/dsh --profile zhiban --no-open --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3
```

服务器验收命令（在 VM 上执行后把结果贴回 #28）：

```bash
sudo systemctl restart dsh-zhiban
curl -sS http://127.0.0.1:3080/zhiban-m0/health

PID=$(systemctl show -p MainPID --value dsh-zhiban)
sudo kill -9 "$PID"
sleep 10
systemctl is-active dsh-zhiban
systemctl show -p MainPID --value dsh-zhiban
```

---

## 2. #29：向指定长期会话注入消息并触发回合

### 2.1 结论

**可行，不需要回退方案。** 插件在没有客户端连接时，可以用两条公开路径注入：

| 路径 | 接口 | 适用场景 | source |
|---|---|---|---|
| A | `ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content }, signal)` | 患者入站消息；会话冷启动由它负责 | `user`（远端包装为 `{kind:'user', rpcId}`） |
| B | `ctx.sessionController.resolveAgent(sessionId)` → `agent.followup(UserMessage)` → `ctx.sessions.flush(agent.session)` | 主动提醒、定时任务、内部投递 | 自定义，如 `zhiban-patient` / `schedule` |

`reply_draft` 工具调用参数通过 `ctx.on('tools/result', (exec, result) => ...)` 捕获；
`exec.agent` 可用于关联会话，`exec.arguments` 就是模型提交的参数。

### 2.2 给 P1-R-03 的接口签名

下面是契约形状，不是完整可编译实现；`patientSessionStore`、`withTimeout` 等由 P1-R-03 实现。

```ts
export type AgentContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
      data: string            // base64，不带 data: 前缀
      name?: string
    }

export interface ReplyDraft {
  body: string
  riskLevel: 'low' | 'medium' | 'high'
  citedMemoryIds?: string[]
}

export interface TurnResult {
  patientId: string
  sessionId: string
  turn: number
  reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked' | 'unknown'
  assistantText: string
  drafts: ReplyDraft[]
  source: 'user' | 'zhiban-patient' | 'schedule' | 'unknown'
  durationMs: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
  }
}

/**
 * 患者入站消息：patientId 映射到长期 sessionId，注入一条用户消息并等待回合结束。
 * message 支持纯文本或文本+图片；P1 的文本入口直接传 string。
 */
export async function runAgentTurn(
  patientId: string,
  message: string | AgentContentPart[],
): Promise<TurnResult>
```

**实现步骤（P1-R-03 按此落地）：**

1. `sessionId = patientSessionStore.getOrCreate(patientId)`。
   - 首次：`await ctx.sessionController.create({ cwd, agentPreset })`，把返回的 `sessionId`
     持久化到我们自己的患者表；**不要把 patientId 当 sessionId**。
   - 之后：直接复用；DSH 重启后 sessionId 仍有效。
2. `agent = await ctx.sessionController.resolveAgent(sessionId)`；若返回 `error`，按错误码重建或告警。
3. 入站消息用路径 A：
   ```ts
   await ctx.sessionController.prompt({
     requestId: `wecom:${msgId}`,          // 稳定 id，便于重试/排查；去重语义需在 P1 验证
     sessionId,
     mode: 'queue',
     content: typeof message === 'string' ? [{ type: 'text', text: message }] : message,
   }, AbortSignal.timeout(185_000))
   ```
4. `await withTimeout(agent.whenIdle(), 180_000, 'turn')`；超时不能丢消息，转后台任务并记录告警。
5. `await ctx.sessions.flush(agent.session)`，确保重启后能恢复。
6. 从 `session/event` 收集 `turn/start`、`turn/end`、`assistant/message`；从 `tools/result`
   收集 `reply_draft` 参数；按 turn 聚合后返回 `TurnResult`。
7. 主动投递（提醒、随访）用路径 B：
   ```ts
   agent.followup({
     id: randomUUID(),
     role: 'user',
     content: [{ type: 'text', text }],
     source: { kind: 'zhiban-care' },
   })
   await agent.whenIdle()
   await ctx.sessions.flush(agent.session)
   ```

**注意：** `sessionController.prompt` 的 source 是 `user`；如果审计上必须区分“患者消息 / 主动随访 / 定时任务”，
主动投递走 `agent.followup` 并设置 `source.kind`。本机已验证自定义 `zhiban-patient` 会持久化到
`user/message` 事件中。

### 2.3 验证证据

**路径 A / B（同一会话，连续两轮）：**

| 测试 | turn | 耗时 | source | 捕获到的草稿 |
|---|---:|---:|---|---|
| A：`sessionController.prompt` | 1 | 2.9s | `user` + runtime/skill/time context | `路径A：sessionController.prompt` |
| B：`followup` | 2 | 2.4s | `zhiban-patient` | `路径B：followup` |

**连续注入 3 条（忙时会话）：**

```text
session = session-43cdb2d0-00a4-4ec8-920b-612c37e4150b
acceptedAt = [1794218232325, 1794218232326, 1794218232327]   # 3 条在 3ms 内全部 accepted
turnStarts = [1794218232322, 1794218234380, 1794218236883]
turnEnds   = [1794218234379, 1794218236883, 1794218239058]
turns      = [3, 4, 5]，全部 completed
drafts     = 排队A / 排队B / 排队C
总耗时     = 6.7s
```

结论：**同一会话忙时注入不会拒绝，消息按队列串行执行，没有丢消息。**
第一条 turn 的 `turn/start` 比 `acceptedAt` 早约 3ms，是事件时间和 HTTP 采样时刻的差；
后续回合严格一个结束后才开始下一个。

**重启恢复：**

- 一次重启前该会话到 turn 5；重启后同一 `sessionId` 继续出现 turn 6，`reason: completed`，
  草稿「重启后恢复成功」（约 2.0s），说明 sessionId 跨重启稳定。
- 另一次重启后，同一会话的 turn 12 由 schedule 投递触发，`user/message.source = schedule`，
  草稿「重启后提醒已投递」。
- 用脚本做 30 秒一次性提醒 + 重启：重启后 catalog 中记录仍为 `active`，
  到期后投递进原会话，turn 1 completed，草稿「重启后提醒已投递」；到期后约 **2.64 秒** 完成回合。
- 说明：**sessionId 跨重启稳定；`ctx.sessions.flush()` 必须每轮调用。**

**没有客户端连接：** 注入全部通过 HTTP/curl 完成，没有打开 DSH Web UI、没有浏览器会话参与；
只有 Connection Fetch 的 owner 探针用了本地 launch-token cookie（与消息注入无关，cookie 不入库）。

### 2.4 风险与实现边界

| 风险 | 说明 | P1 处理 |
|---|---|---|
| 队列无界 | DSH 接受忙时消息，但没有看到队列上限/背压 | 在 `runAgentTurn` 外层按 patientId 做串行队列 + 最大深度；满时回执“稍后处理” |
| 超时 | 图片回合最慢 89s，文本通常 2–3s | 回合超时 180s；超时后不丢消息，记录并重试 |
| `whenIdle` 语义 | 忙时注入多条时，`whenIdle` 可能在队列排空后才返回 | 用 turn/end 事件和 requestId 做精确关联，不只依赖 whenIdle |
| 幂等 | 未验证相同 `requestId` 是否去重 | 用企微 `msgid` 在上层去重；重试前查本地状态 |
| 正文存储 | DSH session 存储在 `DSH_HOME/sessions`，含患者消息正文 | 服务器磁盘权限、加密、保留期和备份策略在 P1 安全项处理；日志不打印正文 |
| 多患者公平性 | 单进程、196 插件；未做并发压测 | P1 上线前做 20–50 并发回合的容量测试 |

**P1-R-03 不需要调整验收项**：公开接口存在，按上面的签名实现即可。

---

## 3. #30：HTTP 路由、SSE、schedule、提醒投递、插件清单

### 3.1 五项结论

| # | 能力 | 结论 | 证据 / 边界 |
|---|---|---|---|
| 1 | 插件注册 Connection Fetch 路由，外部 curl GET/POST JSON | **可行，但 owner-only** | 未认证 GET → HTTP 401 `unauthorized`；带 DSH Web launch-token cookie 后 GET/POST 均 200，返回 JSON |
| 2 | 路由上 SSE 长连接 ≥60s | **WebServer 路由可行；Connection Fetch 未验证 SSE** | `GET /zhiban-m0/sse?seconds=60`：HTTP 200，持续 **60.002s**，hello=1、tick=11、done=1，正常关闭 |
| 3 | `ctx.schedule` 一次性 + cron 创建/列出/删除 | **可行** | 一次性 5s 提醒创建并投递；cron `*/5 * * * *` 创建、list 可见、delete 返回 `deleted:true` |
| 4 | 提醒到期投递进原会话并触发回合；Host 重启不丢 | **可行** | 投递后 `user/message.source = schedule`，回合 completed，捕获草稿；重启后记录仍 `active`，到期投递完成 |
| 5 | 插件读取 DSH 插件清单 | **可行** | `ctx.loader.entries()` 共 **196** 条；可见 `include:zhiban-hello`、`include:zhiban-m0`，fiber state `2` |

### 3.2 Connection Fetch：可用，但不是控制台 API

验证插件注册：

```js
ctx.connection.fetch.register({
  path: '/api/zhiban-m0/cfetch/ping',   // 必须 /api/ 前缀
  methods: ['GET', 'POST'],
  requestBody: 'buffered',
  async fetch(request) {
    const body = request.method === 'POST' ? await request.json() : null
    return new Response(JSON.stringify({ ok: true, method: request.method, body }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  },
})
```

本机结果：

```text
GET  /api/zhiban-m0/cfetch/ping          -> 401 unauthorized
GET  + launch-token cookie               -> 200 {"ok":true,"transport":"connection-fetch",...}
POST + launch-token cookie + JSON body   -> 200 {"ok":true,...,"body":{"hello":"cfetch"}}
```

**结论：** Connection Fetch 的 exact 路由要求 `/api/` 前缀，并且只对 owner Peer 开放。
它适合“浏览器已登录的 owner 调用”，**不适合控制台后端做 server-to-server 调用**。
如果确实要外部调用，必须走 DSH 的 owner 认证；不要试图绕过。

**替代方案（推荐）：** 控制台 API 用 `ctx.webServer.register`：

```js
ctx.webServer.register({
  kind: 'exact',              // 或 'prefix'
  path: '/zhiban/api/health',
  handler: async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
  },
})
```

WebServer 路由没有浏览器认证，handler 自己拥有 response（所以 SSE 可用）。生产必须自行加：
认证（会话/签名）、限流、来源限制（只允许控制台后端 IP）、请求体大小限制、审计日志（不记正文），
并只监听内网/本机。

### 3.3 SSE 长连接

本机实测：

```text
GET /zhiban-m0/sse?seconds=60
HTTP 200，time_total=60.002s
event: hello  x1
event: tick   x11   （每 5s 一次）
event: done   x1
连接正常关闭
```

实现要点：

```js
res.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
})
```

- 5 秒心跳足够穿过常见空闲超时；生产可加到 10–15 秒并配合代理 `proxy_read_timeout`。
- 客户端断开时清理 timer（本机插件监听 `req`/`res` 的 `close`）。
- **Connection Fetch 路由上未验证 SSE**；控制台 SSE 建议直接走 WebServer 路由。
- 未来上 Nginx 时，SSE location 需要关闭缓冲；这属于 P1-L-01，不在 M0。

### 3.4 `ctx.schedule`：一次性、cron、列出、删除

插件直接调用（注意 DSH 内部字段是 snake_case）：

```js
// 一次性：5 秒后
const oneShot = await ctx.schedule.create(sessionId, {
  prompt: '提醒内容',
  title: '一次性提醒',
  after_seconds: 5,
})

// cron：每 5 分钟；cron 必须是对象，含 expression + time_zone
const cron = await ctx.schedule.create(sessionId, {
  prompt: 'cron 提醒内容',
  title: 'cron 提醒',
  cron: { expression: '*/5 * * * *', time_zone: 'Asia/Shanghai' },
})

await ctx.schedule.list({ sessionId })
await ctx.schedule.delete({ sessionId, id: cron.id })
```

本机结果：

```text
一次性记录：kind=after，afterSeconds=5，scheduledAt=2026-11-09T10:01:46.951Z
cron 记录：  kind=cron，expression=*/5 * * * *，timeZone=Asia/Shanghai
list：      能看到刚创建的 cron 记录
delete：    {"id":"schedule-...","deleted":true}
```

**注意：** 这些是 `ctx.schedule` 的内部形状；M0 验证插件在自己的 HTTP 路由里把
`afterSeconds` / `everySeconds` / `cron` 转成 snake_case，业务代码不要照抄路由层。

### 3.5 提醒投递与跨重启持久化

**一次性提醒投递：**

```text
用户消息 source = schedule
回合 completed
捕获草稿：M0 一次性提醒已投递
```

**跨重启：**

```text
prepare：创建 30 秒后的一次性提醒
restart：停止 DSH → 重新启动
check：  catalog 中记录仍为 active
        到期后投递进原 session
        user/message.source = schedule
        回合 completed，草稿「重启后提醒已投递」
        到期后约 2.64s 完成
```

调度器由 DSH 自己持久化，不依赖插件进程内存。**P1 的主动计划可以直接用 `ctx.schedule`**；
如果业务需要更复杂的重试/补偿，再在插件层加自己的幂等键和告警。

### 3.6 插件清单

```js
for (const entry of ctx.loader.entries()) {
  // entry.id, entry.options?.name, entry.disabled, entry.fiber?.state
}
```

本机：196 条；验证插件对应：

```text
{ id: 'include:zhiban-hello', name: 'file:///.../zhiban-hello.js', disabled: false, fiber: '2' }
{ id: 'include:zhiban-m0',    name: 'file:///.../zhiban-m0.js',    disabled: false, fiber: '2' }
```

`fiber.state = 2` 表示已激活（与健康检查的 196 插件数一致）。技能市场需要展示插件清单时，
可以读这个接口；如果只需要 Remote 侧清单，DSH 自带
`@deepseek-ai/dsh-host-plugin-inventory` 的 `pluginInventory/list`（本机未单独调用）。

### 3.7 替代方案

五项都可行，没有必须回退的项；但有两个明确的替代/约束：

- **Connection Fetch 不能当控制台 API** → 用 `ctx.webServer.register` + 自建认证。
- **Connection Fetch 的 SSE 未验证** → 控制台 SSE 用 WebServer 路由。
- 如果未来 WebServer 路由管理成本太高，再评估“插件内独立 HTTP 监听端口”；M0 不需要。

---

## 4. 复现方式

### 4.1 本机

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.5

cd experiments/m0-dsh-validation
./scripts/setup-profile.sh
dsh --profile zhiban --no-open --host 127.0.0.1 --port 3399
```

另开终端：

```bash
cd experiments/m0-dsh-validation

./scripts/verify-29.sh
./scripts/verify-29-resume.sh <sessionId>        # 重启 DSH 后

./scripts/verify-30.sh
DSH_COOKIE_JAR=/path/to/owner-cookie.txt ./scripts/verify-30.sh   # 验证 Connection Fetch owner 200
./scripts/curl-sse.sh http://127.0.0.1:3399 60                   # 单独看 SSE 事件

./scripts/verify-30-persist.sh prepare http://127.0.0.1:3399 90
# 在 90 秒内重启 DSH
./scripts/verify-30-persist.sh check

./scripts/fetch-images.sh ./.cache/m0-images
python3 ./scripts/vision-probe.py --assets ./.cache/m0-images --out ./.cache/m0-results
```

结果写到 `experiments/m0-dsh-validation/.cache/m0-results/`，该目录已 gitignore。
cookie jar、API Key、launch token 都不入库。

### 4.2 服务器

见 [`deploy/README.md`](../experiments/m0-dsh-validation/deploy/README.md)：安装精确版本、建
`zhiban` 用户、`DSH_HOME=/var/lib/zhiban/dsh`、写 `/etc/zhiban/dsh.env`、安装 unit、执行
`systemctl restart` 与 `kill -9` 验收。

---

## 5. 待真机 / 未验证清单

| 项 | 状态 | 交给谁 |
|---|---|---|
| Ubuntu VM 上 systemd 常驻、开机自启、kill 10s 拉起 | ⏳ | 项目负责人在服务器执行，结果贴回 #28 |
| DSH Web UI 手工新开会话、模型下拉框、hello 工具点击验证 | ⏳ | 项目负责人 |
| 真实企微图片（压缩、低光、手写化验单、多菜混合）识别质量 | ⏳ | #55 / #64，需匿名化样本 |
| 20–50 并发回合容量、队列上限、内存增长 | ⏳ | P1-R-03 上线前压测 |
| Connection Fetch 上的 SSE | 未验证 | 不作为生产方案；控制台用 WebServer |
| 相同 `requestId` 的幂等语义 | 未验证 | P1 用企微 msgid 在上层去重 |
| 真实患者正文的磁盘加密/保留期/备份 | ⏳ | P1 安全与运维项 |

## 6. 相关文件

- 验证插件：[`plugins/zhiban-hello.js`](../experiments/m0-dsh-validation/plugins/zhiban-hello.js)、
  [`plugins/zhiban-m0.js`](../experiments/m0-dsh-validation/plugins/zhiban-m0.js)
- 脚本：[`scripts/`](../experiments/m0-dsh-validation/scripts/)
- 部署：[`deploy/README.md`](../experiments/m0-dsh-validation/deploy/README.md)、
  [`deploy/dsh-zhiban.service`](../experiments/m0-dsh-validation/deploy/dsh-zhiban.service)
- 图片许可：[`assets/sources.json`](../experiments/m0-dsh-validation/assets/sources.json)
- 启动脚本说明：[`experiments/m0-dsh-validation/README.md`](../experiments/m0-dsh-validation/README.md)
