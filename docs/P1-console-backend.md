# P1 控制台后端（WP-H）实现说明

> 归属工作包：WP-H（#41 控制台框架 / #39 告警中心 / #40 体验沙盒）
> 契约依据：[P1-api.md](./P1-api.md) · 数据模型：[P1-data-model.md](./P1-data-model.md)
> 本文只描述**已实现范围**与**本地验收**；需要真实主机、企微后台或模型服务的验收项单独标「⏳ 待真机」。

---

## 1. 范围

| Issue | 已实现 |
|---|---|
| #41 | 账号密码登录、HttpOnly Cookie 会话（7 天）、登录限流、角色 `admin / supervisor / viewer / platform`、逐接口鉴权、`/zhiban/api` 前缀注册、租户读取/修改（保存即生效）、SSE 事件转发、审计查询与 CSV 导出、账号管理、平台账号对租户接口一律 404 |
| #39 | `alert.created` 入库（九种告警）、列表/未解决计数/详情、备注后解决、释放串行队列、恢复被暂停顾问、全操作审计、60 分钟超时升级（C2 串行队列产生 `ESCALATED` 并按配置 1:1 推送主管，控制台消费并展示） |
| #40 | 每账号一个沙盒患者与会话、真 Agent/插件回合、四种动作（verified / edit_sent / misroute / unverified）、草稿不进入 C2、SSE 逐步推送、每账号每天 100 轮、重置、图片上传与读取 |

未包含（由其他工作包负责）：患者/群/知识库/看板等其余 P1 接口、前端页面、企微真实通道的联调。

## 2. 代码位置

```text
plugins/zhiban-console/
  index.ts       插件装配、路由、SSE 订阅、审计导出
  auth.ts        登录 / 会话 / 账号管理
  config.ts      部署配置解析（口令只来自部署环境）
  domain.ts      DSH 领域存储（zhiban_console）
  http.ts        极简路由、Cookie、错误体、幂等缓存
  sse.ts         SSE 客户端与 5 分钟补发缓冲
  tenant.ts      租户参数校验与合并
src/p1/
  console-types.ts   角色权限、租户、账号、审计、告警、沙盒类型
  console-auth.ts    口令哈希、登录/业务限流、Origin 判断
  console-store.ts   内存镜像 + 串行落盘
  console-alerts.ts  告警服务
  console-error.ts   统一错误码
  sandbox.ts         沙盒服务（实现 SandboxSinkPort）
```

跨包增量（均为新增，不改变既有行为）：

- `zhiban-wecom` 新增 `zhibanWecomAdmin`：`releaseQueue` / `restoreAdvisor` / `getDraft` / `getAdvisor`。
- C2 草稿状态新增终态 `RELEASED`（`PUSHED → RELEASED`，释放串行队列）。
- `zhiban-patient` 新增沙盒接口：`sandboxEnsure` / `sandboxReset` / `sandboxTurn` / `sandboxInjectContext` / `applySettings`。
- 患者运行时新增 `runSandboxTurn`：走真实 Agent 会话，草稿交给 `zhibanSandboxSink`，不计统计、不进 C2。

## 3. 部署配置

插件配置由 DSH profile（部署机）注入。**仓库里不写任何真实口令、CorpID、Token**；示例中的口令一律为占位符。

```json
{
  "tenantId": "tn_<tenant>",
  "tenant": {
    "name": "机构名称",
    "agentName": "小安",
    "patientTerm": "患者",
    "tone": "亲切、专业、简洁",
    "timezone": "Asia/Shanghai"
  },
  "admin": {
    "username": "admin",
    "displayName": "机构管理员",
    "password": "<从部署环境注入>"
  },
  "platform": {
    "username": "platform",
    "displayName": "平台运营",
    "password": "<从部署环境注入>"
  },
  "cookieSecure": true,
  "allowedOrigins": ["https://<控制台域名>"],
  "sessionTtlMs": 604800000,
  "sandbox": {
    "mediaRootDir": "/var/lib/zhiban/console-media",
    "dailyLimit": 100
  }
}
```

说明：

- `cookieSecure` 默认 `true`；仅本地 HTTP 调试可设 `false`。生产必须 HTTPS。
- `admin` / `platform` 只在启动时补齐：账号已存在则不覆盖，改初始密码请走控制台或运维脚本。
- `allowedOrigins` 为空时只接受与 `Host` 同源、或无 `Origin` 的请求（curl / 服务端调用）。
- 沙盒图片默认写到工作目录 `.zhiban-console-media/`（已加入 `.gitignore`），生产建议显式配置 `mediaRootDir` 到持久盘。
- 沙盒每日上限以租户时区的自然日计算；`PATCH /tenant` 修改 `timezone` 后立即切换。
- `zhiban-wecom` 插件配置另有可选项 `supervisorChatIds: ["<主管企微 userid>"]`，用于 60 分钟升级时 1:1 推送；不配置则只产生告警。

## 4. 关键链路的实现口径

### 4.1 登录与会话

- 密码：`scrypt(N=16384,r=8,p=1)`，格式 `scrypt$N$r$p$salt$hash`；接口响应与审计都不带哈希。
- 会话：随机 32 字节 token，服务端只存 SHA-256；Cookie `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`。
- 登录失败：同 IP + 用户名 15 分钟 5 次，第 6 次即使密码正确也返回 `429 RATE_LIMITED`。
- 登出、改密、停用、删除、重置密码都会撤销对应服务端会话；改密保留当前会话。
- 登录失败审计中的 IP 已脱敏（如 `203.0.113.*`）。

### 4.2 鉴权与隔离

- `platform` 账号可登录，但访问任何租户接口统一 `404 NOT_FOUND`（不在界面上暴露租户数据是否存在）。
- 其他角色按 `P1-api.md §1.6` 权限矩阵；后端逐接口校验，前端隐藏按钮不作为安全边界。
- `admin` 是唯一可管理账号的角色；不能停用、降级或删除自己；平台账号不出现在租户账号列表。

### 4.3 租户修改即时生效

`PATCH /tenant` 保存后：

1. 更新租户记录与沙盒时区；
2. 调用 `zhibanPatient.applySettings({ agentName, patientTerm, tone })`；
3. 写 `tenant.update` 审计。

已存在的 DSH 会话不重建系统提示词；患者插件在下一轮注入一条设置更新上下文（`sandboxInjectContext` / 正式回合同路径），因此**下一轮**即使用新人设。

### 4.4 告警

- 订阅平台 `alert.created`，兼容 C2 大写类型（`MISROUTE` / `UNVERIFIED` / `DEAD_LETTER` / `ADVISOR_PAUSED` / `ESCALATED` / `PUSH_FAILED` / `NO_CHATID` / `DOWNTIME` / `BOT_DISCONNECTED` / `PERSIST_FAILED`）与 P1 小写实体。
- 带 `id` 的事件幂等；`sandbox=true` 的事件不入告警中心。
- 正文不进入日志；入库时防御性截断到 200 字，审计只记录备注长度。
- `resolve` 备注必填（≤ 200 字），处理后不可重复；`release-queue` / `restore-advisor` 需要 `advisor.operate`。
- 队列释放与顾问恢复经 `zhibanWecomAdmin`：未安装企微插件返回 `502 UPSTREAM_UNAVAILABLE`，`NO_ACTIVE_DRAFT` 等映射为 `409` / `404`。
- 60 分钟升级阈值仍由 C2 串行队列配置；到点后 C2 产生 `ESCALATED` 告警，并按 `zhiban-wecom` 配置的 `supervisorChatIds`（企微 userid，可多个）1:1 推送主管，推送文案只含群名与客户名、不含正文。控制台只展示与处理 `ESCALATED`。
- `supervisorChatIds` 为空时只产生告警、不推送；主管需先与机器人建立 1:1 会话（`chatId` 可用 userid），否则企微侧发送会失败，但不影响队列状态。

### 4.5 沙盒

- 每个账号一个沙盒患者 `pat_sandbox_<account>` 与一个 DSH 会话；`reset` 换新会话并清空消息/草稿/核验/事件/记忆，**保留当日轮次**。
- 消息经 `zhibanPatient.sandboxTurn` 进入真实 Agent；Agent 调 `reply_draft` 时草稿交给 `zhibanSandboxSink`，不经过 C2、不推顾问、不计患者域统计。
- 四种动作与结果：

| action | outcome | 草稿终态 | 说明 |
|---|---|---|---|
| `send_original` | `verified` | `VERIFIED` | 目标群找到完全相同的正文 |
| `send_edited` | `edit_sent` | `EDIT_SENT` | 正文有改动，版本 +1 |
| `send_wrong_group` | `misroute` | `MISROUTE_ALERT` | 回复出现在另一个客户群 |
| `ack_only` | `unverified` | `UNVERIFIED` | 只点「已发送」，没有可核验的发送 |

- 沙盒数据全部 `sandbox=true`，统计与告警默认过滤；图片消息只引用当前账号上传的沙盒图片。
- 图片消息只入库、不触发 Agent 回合（P1 的模拟通道只处理文本回合）；如需「看图」能力在 P1 之后单独评估。

### 4.6 SSE

- `GET /stream`，15 秒 `: ping` 注释心跳；`Last-Event-ID` 在 5 分钟缓冲内补发。
- `types` 支持 `draft.*` / `alert.*` / `sandbox.*` 前缀；未知事件不订阅。
- 事件信封含 `id / type / at / tenantId / sandbox / data`；不是事实来源，前端重连后仍需 REST 拉一次状态。

## 5. 本地验收（已执行）

环境：Node ≥ 22.6，本机离线；未连接企微、未调用真实模型。

```bash
npx tsc --noEmit
npm test
```

| 验收点 | 覆盖测试 | 结果 |
|---|---|---|
| 口令哈希 / 规则 / 登录限流 / 业务限流 | `tests/console-auth.test.ts` | ✅ |
| 登录、Cookie、会话过期、登出、改密撤销其它会话 | `tests/console-auth.test.ts` | ✅ |
| 账号创建/停用/删除、自助保护、平台账号隐藏 | `tests/console-auth.test.ts` | ✅ |
| 路由前缀、401/403/404/405、错误体、Origin、幂等缓存 | `tests/console-http.test.ts` | ✅ |
| 租户字段校验、`modelName` 只读、设置合并 | `tests/console-tenant.test.ts` | ✅ |
| 告警入库/去重/列表/计数/解决/释放/恢复/错误映射 | `tests/console-alerts.test.ts` | ✅ |
| 60 分钟升级按配置 1:1 推送主管、去重、不带正文 | `tests/queue.test.ts`、`tests/wecom-plugin-config.test.ts` | ✅ |
| C2 释放队列推下一条、恢复顾问、`RELEASED` 终态 | `tests/console-admin-ops.test.ts` | ✅ |
| 沙盒会话/配额/四动作/重置/记忆/图片 | `tests/sandbox.test.ts` | ✅ |
| 沙盒回合走真运行时、草稿进 sink、不计统计、设置即时生效 | `tests/sandbox-runtime.test.ts` | ✅ |
| SSE 格式、租户隔离、types 过滤、补发、关闭 | `tests/console-sse.test.ts` | ✅ |
| 插件端到端：登录→会话→租户→告警→沙盒→审计导出 | `tests/console-plugin.test.ts` | ✅ |

当前结果：`npx tsc --noEmit` 无错误；`npm test` **239/239 通过**（2026-11-10，本地）。

## 6. ⏳ 待真机验收

> 以下项目未在本机执行，**不能视为已通过**。请在部署环境按步骤验证并把结果补回 PR/Issue。

| # | 项目 | 步骤 | 期望 |
|---|---|---|---|
| R1 | 插件装载顺序 | 在 DSH profile 同时启用 `zhiban-patient`、`zhiban-wecom`、`zhiban-console`，任一顺序启动 | 控制台日志出现「已就绪」；`ctx.get('zhibanPatient')` / `zhibanWecomAdmin` 可用；无循环依赖报错 |
| R2 | Nginx 反代与 Cookie | 将 `/zhiban/api` 反代到 DSH；HTTPS 下用浏览器登录 | 登录后 `Set-Cookie` 带 `Secure; HttpOnly; SameSite=Lax`；刷新保持会话；`PATCH` 不被 Origin 拒绝 |
| R3 | SSE 穿透代理 | 保持浏览器控制在 `/stream` 页面，等待 ≥ 1 分钟；断网 10 秒再恢复 | 每 15 秒收到 `: ping`；恢复后带 `Last-Event-ID` 补发断线期间事件；代理未缓冲整段响应 |
| R4 | 真实 Agent 沙盒回合 | 体验中心新建会话，发送「我对海鲜过敏」，再问「晚上吃什么」 | 两轮均进入真实模型；草稿出现在沙盒面板；`GET /sandbox/state` 与 SSE 一致 |
| R5 | 沙盒四种动作 | 依次点「照发 / 改写后发 / 发到别的群 / 只点已发送」 | 结果分别为 `verified / edit_sent / misroute / unverified`；重复点击返回 409；无正式草稿进入 C2 |
| R6 | 每日 100 轮 | 用测试账号连续发起至第 101 轮（或把 `sandbox.dailyLimit` 临时调小） | 第 101 次返回 `429 LIMIT_EXCEEDED`；次日按租户时区自动恢复 |
| R7 | 队列释放 / 恢复顾问 | 造一条阻塞的 `PUSHED` 草稿与一条暂停顾问告警，分别调用 `release-queue`、`restore-advisor` | 原草稿变 `RELEASED`，下一条被推送；顾问恢复 `active` 且连续错群计数清零；审计有记录 |
| R8 | 告警升级 | 配置 `supervisorChatIds`，让草稿超过 C2 配置的升级阈值 | 60 分钟（或测试配置）后主管企微收到 1:1 升级消息（不含正文）；控制台出现升级告警，可备注解决 |
| R9 | 账号与权限 | 用 `viewer` 登录，逐个点击写操作 | 后端返回 403；只读接口正常；平台账号看不到租户与告警数据 |
| R10 | 媒体持久化 | 上传 JPG/PNG，重启 DSH 后再次读取 | 文件仍在 `mediaRootDir`；`GET /media/:id` 正常；非本账号无法读取他人沙盒图片 |
| R11 | 数据重启恢复 | 登录、处理告警、创建沙盒会话后重启 DSH | 账号/会话（未过期）/告警/审计/沙盒配额仍在；`dailyLimit` 剩余数不重置 |

## 7. 安全与合规自查

- 新代码、测试、文档中无真实 CorpID / Secret / Token / 私钥；示例口令均为虚构。
- 日志只记录状态与错误码，不打印消息正文、密码或哈希。
- 测试数据全部虚构；`grep -ri 七通` 在本次新增文件中无命中。
- 平台账号与租户数据隔离；跨租户读取按 `NOT_FOUND` 处理。
