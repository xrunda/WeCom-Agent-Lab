# P1 环境隔离：演示（demo）与开发（dev）

> 对应 issue #65（P1-L-04）与平台约束 F14：**同一机器人只允许一个长连接**。
> 任何实例用同一套机器人凭据启动，都会把另一个实例挤下线。演示期间出现这种情况，
> 客户侧的卡片 / 正文会直接中断，所以两个环境必须使用**不同的机器人**，并在启动时互相隔离。

## 1. 两套环境

| | demo（演示） | dev（开发 / 测试） |
|---|---|---|
| 用途 | 演示患者播种、走查、对外演示 | 本地开发、联调、回归 |
| 企微机器人 | 「知伴」 | 「知伴-开发」（需在企微后台新建） |
| `BOT_ID` / `SECRET` | 演示机器人凭据 | 开发机器人凭据，**禁止复用 demo 凭据** |
| `ZHIBAN_ENV` | `demo` | `dev` |
| DSH profile | `zhiban-demo` | `zhiban-dev` |
| `DSH_HOME` | `/var/lib/zhiban/dsh-demo` | `/var/lib/zhiban/dsh-dev`（本机可 `~/.dsh-dev`） |
| 端口（示例） | `3080` | `3399` |
| 媒体目录 | `.../zhiban-demo/media` | `.../zhiban-dev/media` |
| 存档群 | 演示客户群 | **仅 dev 测试群白名单** |
| 草稿接收人 | 演示顾问 | 开发 / 测试顾问 |

两套环境**共用同一个会话存档席位**（同一个 corpid + 会话存档 Secret + RSA 私钥）。
存档是只读的，两个实例各自维护 `seq`，可以同时拉取；隔离靠**群白名单**：
`zhiban-wecom` 的 `serviceGroupRoomIds` 只包含本环境允许处理的群，
非白名单群的记录只计数、不落正文、不下载图片、不生成草稿。

`serviceGroupRoomIds` 现在是**初始种子**：控制台「开始服务 / 移出服务」会在运行时增删白名单，
并持久化到本环境 `DSH_HOME` 下的 `zhiban_wecom` 元数据 `service_roster`（两套环境各自独立），
不需要重启。客户群自动发现（#106）也按环境配置群主过滤：
`serviceGroupDiscovery.ownerUserIds` 只登记本环境顾问名下的群，
否则共用 corpid 时 demo 会把 dev 的客户群也登记进自己的控制台。

## 2. 凭据归属与存放

| 凭据 | 谁能持有 | 存放位置 |
|---|---|---|
| demo 机器人 `BOT_ID` / `SECRET` | 项目负责人、演示值班 | 服务器 `/etc/zhiban/demo.env`（`0600`，属主 `zhiban`） |
| dev 机器人 `BOT_ID` / `SECRET` | 开发人员 | 各自机器的环境文件，或服务器 `/etc/zhiban/dev.env` |
| 存档 corpid / Secret | 项目负责人 | `/etc/zhiban/archive.env`（`0600`） |
| 存档 RSA 私钥 | 项目负责人 | `/etc/zhiban/private_key.pem`（`0600`） |

规则：

- **不进仓库、不进日志、不进 PR / issue 评论**。仓库根目录 `.env.local` 是真实凭据，只允许本机脚本通过环境变量读取。
- DSH profile 的 `cordis.patch.yml` 只写路径与普通配置；Secret 由部署脚本从环境文件注入，不要把明文贴进 profile。
- 对外截图、录屏前先确认画面里没有 Secret / Token / 完整 `BOT_ID`。
- 插件按**仓库内的相对路径**部署（`plugins/zhiban-wecom/index.ts` 依赖 `src/c2/**` 与仓库 `node_modules`），不要只拷贝插件目录到别处。

## 3. 插件配置示例

两套 profile 使用同一个插件，只有配置不同（`<...>` 为占位符，实际值由部署脚本替换）：

```yaml
- insert:
    - id: zhiban-wecom
      name: /opt/zhiban/plugins/zhiban-wecom/index.ts
      config:
        environment: demo                # dev 环境改为 dev
        demoBotId: <demo-bot-id>         # 固定填演示机器人的 id，用于启动保护
        botId: <this-env-bot-id>
        botSecret: <this-env-bot-secret>
        archive:
          binaryPath: /opt/zhiban/bin/archive_dump
          privateKeyPath: /etc/zhiban/private_key.pem
          configPath: /etc/zhiban/config.txt
        serviceGroupRoomIds:            # 初始种子；控制台改状态后以 service_roster 为准
          - <本环境允许处理的群 roomid>
        serviceGroupDiscovery:          # #106 客户群自动发现
          enabled: true
          intervalMs: 300000            # 5 分钟；最小 60000
          maxPerScan: 50
          ownerUserIds:                 # 必填：本环境群主的企微 userid，隔离另一个环境
            - <本环境顾问 userid>
        advisorId: <本环境顾问 userid>
        advisorName: <本环境顾问姓名>
        advisorChatId: <本环境顾问 userid>
        groupName: <本环境测试群名>
        mediaRootDir: /var/lib/zhiban/dsh-demo/zhiban/media
        pollIntervalMs: 5000
        tickIntervalMs: 5000
        downtimeThresholdMs: 600000
```

### 存储后端

DSH 0.2.1-rc.5 随包提供 `dsh-storage-json` 与 `dsh-storage-domain`，**没有 `storage-sqlite`**。
因此 #32 原计划的 `SqliteStore` 改为 `DomainStore`（`plugins/zhiban-wecom/domain.ts`）：
读取走同步内存镜像，写入通过 `storage-domain` 串行落盘，C2 的同步 `Store` 接口不变。

profile 中需要给 `storage-domain` 配置默认 backend（例如 `backend: json`），并确保
`zhiban_wecom` 没有被路由到未注册的后端；否则插件启动时 `open()` 会报 `backend-not-found`。

## 4. 启动保护与告警

实现位置：`plugins/zhiban-wecom/config.ts`、`plugins/zhiban-wecom/index.ts`。

1. **环境一致性**：进程环境 `ZHIBAN_ENV` 必须与插件配置 `environment` 一致，否则拒绝启动（`ENV_MISMATCH`）。
2. **F14 启动保护**：`environment: dev` 且 `botId === demoBotId` 时拒绝启动，报
   `ENV_BOT_CONFLICT`，提示创建「知伴-开发」机器人。
3. **长连接断开告警**：demo 实例的长连接被服务端关闭时，插件发出
   `alert.created`（`kind: BOT_DISCONNECTED`）并写领域存储；dev 实例只记日志。
   运维侧的通知通道（企业微信机器人 / 短信）属于部署项，见 §6 的待办。
4. **停机判定**：启动时读取 `last_run_at`，与当前时间相差超过 `downtimeThresholdMs`（默认 10 分钟）
   就发出 `DOWNTIME` 告警并写审计；停机期间的消息不生成草稿。

## 5. 切换方法

```bash
# demo（服务器）
DSH_HOME=/var/lib/zhiban/dsh-demo ZHIBAN_ENV=demo \
  dsh --profile zhiban-demo --no-open --host 127.0.0.1 --port 3080

# dev（本机或另一套目录）
DSH_HOME=~/.dsh-dev ZHIBAN_ENV=dev \
  dsh --profile zhiban-dev --no-open --host 127.0.0.1 --port 3399
```

启动前自检：

```bash
dsh --profile zhiban-dev --dump-config | grep -A 20 zhiban-wecom
```

确认 `environment`、`botId`、`serviceGroupRoomIds`、`serviceGroupDiscovery.ownerUserIds`
都属于 dev；**不要**把 dev 进程指向演示群。`ownerUserIds` 留空会退化为「发现全部企业客户群」，
共用 corpid 时两个环境会互相看到对方的群，因此两套 profile 都必须配置。

## 6. 验收对照

| 验收项 | 本地可验证 | 说明 |
|---|---|---|
| 用 demo 凭据启动 dev 实例被拒绝 | ✅ 单测 | `tests/wecom-plugin-config.test.ts`：`ENV_BOT_CONFLICT` |
| `ZHIBAN_ENV` 与配置不一致被拒绝 | ✅ 单测 | `ENV_MISMATCH` |
| 群白名单隔离 | ✅ 单测 | `tests/wecom-archive-media.test.ts`：非服务群不落正文、不下载图片 |
| 自动发现按群主隔离 | ✅ 单测 | `tests/wecom-group-discovery.test.ts`：只登记 `ownerUserIds` 内的群 |
| dev / demo 同时运行 30 分钟不断线 | ⏳ 待真机 | 需要两个真实机器人 + 两套 profile |
| dev 群消息只进 dev、演示群只进 demo | ⏳ 待真机 | 需要企微后台建群、发消息 |
| 踢掉 demo 长连接后 1 分钟内告警 | ⏳ 待真机 | 插件已发 `BOT_DISCONNECTED`；运维通知通道待接 |

## 7. 运维待办

- 企微后台新建「知伴-开发」机器人，并把凭据交给开发负责人。
- 接入 `BOT_DISCONNECTED` / `DOWNTIME` / `PERSIST_FAILED` 的外发通知（企业微信机器人 webhook），
  确保演示期间 1 分钟内可达值班人。
- 两个 profile 的 `DSH_HOME`、端口、媒体目录不要复用；升级时分别重启、分别验证。
