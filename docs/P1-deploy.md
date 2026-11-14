# P1 生产部署手册（#52）

> 对应 issue：[#52 P1-L-01 生产部署](https://github.com/xrunda/WeCom-Agent-Lab/issues/52)
> 关联：[P1-environments.md](./P1-environments.md)（环境隔离）、[P1-console-backend.md](./P1-console-backend.md)（控制台后端）、[P1-data-security.md](./P1-data-security.md)（PDF 字体）
> 本文只把**本机已验证**的内容标 ✅；服务器、域名、证书、企微后台相关项一律标 ⏳ 待真机。

---

## 1. 范围与前置

| 交付物 | 位置 | 本地状态 |
|---|---|---|
| Nginx 站点（HTTPS、静态控制台、`/zhiban/api` 反代、SSE 不缓冲） | [`deploy/nginx/zhiban.conf`](../deploy/nginx/zhiban.conf) | ✅ 配置已写；⏳ `nginx -t` 与真实访问待服务器 |
| 侧边栏站点（`/sidebar/` 静态 + `/zhiban/sidebar/` 反代，#145） | [`deploy/nginx/zhiban-sidebar.conf`](../deploy/nginx/zhiban-sidebar.conf) | ✅ 配置与构建已写（gzip 3.2 KB）；⏳ 域名、证书与企微后台待真机 |
| DSH Host systemd unit | [`deploy/systemd/dsh-zhiban.service`](../deploy/systemd/dsh-zhiban.service) | ✅ 已写；⏳ 服务器启停待真机（#28 已验证同类 unit） |
| 每日备份 + 保留 14 天 | [`deploy/scripts/backup.sh`](../deploy/scripts/backup.sh) | ✅ 本地演练通过 |
| 恢复脚本 | [`deploy/scripts/restore.sh`](../deploy/scripts/restore.sh) | ✅ 本地演练通过 |
| 备份/恢复演练 | [`deploy/scripts/drill-backup-restore.sh`](../deploy/scripts/drill-backup-restore.sh) | ✅ 本机 `RESULT: PASS` |
| 断档看门狗（5 分钟检查、10 分钟升级、恢复通知） | [`src/ops/watchdog.ts`](../src/ops/watchdog.ts) + systemd timer | ✅ 状态机/探针单测；⏳ 真实状态源与企微通知待部署 |
| 模型费用日报 | [`src/ops/daily-report.ts`](../src/ops/daily-report.ts) + systemd timer | ✅ 单测；⏳ 真实统计源待部署 |
| 部署手册 | 本文 | ✅ |

前置条件（需要项目负责人/运维完成）：

- 已备案域名的一个子域名（下文用 `<console-domain>` 占位）。
- 腾讯云 Ubuntu 24.04 服务器、安全组只开放 80/443（SSH 按需限制来源）。
- #28 的 DSH 安装与 profile 已就绪；真实凭据只放服务器 `/etc/zhiban/*.env`（`0600`），**不进仓库**。
- 企微后台：演示机器人、会话存档席位与可信 IP、主管/运维接收人。
- 侧边栏另需一个子域名（下文 `<sidebar-domain>`）与企微应用配置，见 §13。

## 2. 目录布局

| 路径 | 用途 |
|---|---|
| `/opt/zhiban/app` | 本仓库部署副本（只读运行） |
| `/opt/zhiban/bin/archive_dump` | 存档拉取工具（#54） |
| `/var/lib/zhiban/dsh-demo` | `DSH_HOME`（profiles、sessions、storages、media） |
| `/var/lib/zhiban/state` | 看门狗状态（仅 `zhiban` 可写） |
| `/var/lib/zhiban/status` | 运维状态文件（存档/机器人/模型，只读给看门狗） |
| `/var/www/zhiban/console` | 控制台静态文件（`console/dist`） |
| `/var/www/zhiban/sidebar` | 侧边栏静态文件（`console/dist-sidebar`，#145） |
| `/var/backups/zhiban` | 每日备份（`0700`，文件 `0600`） |
| `/etc/zhiban/*.env` | 部署凭据（`0600 root:root`，不进 git） |
| `/etc/nginx/sites-enabled/zhiban.conf` | Nginx 站点（控制台） |
| `/etc/nginx/sites-enabled/zhiban-sidebar.conf` | Nginx 站点（侧边栏，#145） |
| `/etc/letsencrypt/live/<console-domain>/` | 证书（certbot 管理） |

> 环境隔离按 [P1-environments.md](./P1-environments.md)：服务器跑 demo，另一套 `dsh-dev` 不与 demo 共用机器人或数据目录。

## 3. HTTPS 证书

```bash
sudo apt-get install -y certbot python3-certbot-nginx nginx
sudo install -d -o root -g root -m 0755 /var/www/certbot

# 首次签发（先让 80 端口的 acme-challenge 可用；也可用 --nginx）
sudo certbot certonly --webroot -w /var/www/certbot \
  -d <console-domain> --email <ops-email> --agree-tos --no-eff-email

# 自动续期由 certbot.timer 负责；确认：
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

⏳ 待真机：证书链有效、`https://<console-domain>` 登录页正常、续期演练通过。

## 4. 构建并部署控制台

```bash
cd /opt/zhiban/app/console
npm ci
npm run build

sudo install -d -o root -g root -m 0755 /var/www/zhiban/console
sudo rsync -a --delete dist/ /var/www/zhiban/console/
```

发布后 `index.html` 为 `no-store`，`/assets/*` 为长缓存；回滚时把上一版 `dist` 同步回来即可。

## 5. Nginx

```bash
sudo cp /opt/zhiban/app/deploy/nginx/zhiban.conf /etc/nginx/sites-available/zhiban.conf
sudo sed -i 's/<console-domain>/<实际域名>/g' /etc/nginx/sites-available/zhiban.conf
sudo ln -sf /etc/nginx/sites-available/zhiban.conf /etc/nginx/sites-enabled/zhiban.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

关键行为：

- 只反代 `/zhiban/api/` 到 `127.0.0.1:3080`；DSH Web 本体不对公网 expose。`/dsh/` 明确 404。
- SSE 路径关闭 `proxy_buffering` / 缓存，读超时 3600 秒；否则 `/stream` 会被缓冲或断开。
- `client_max_body_size 12m` 覆盖沙盒图片上传（单张上限 10 MB）。
- 安全头：HSTS、`X-Content-Type-Options`、`X-Frame-Options: DENY`、Referrer-Policy。

⏳ 待真机：公网访问控制台正常、`curl https://<domain>/dsh/` 返回 404、SSE 心跳 15 秒可见、`Cookie` 带 `Secure`。

## 6. DSH Host（systemd）

```bash
sudo cp /opt/zhiban/app/deploy/systemd/dsh-zhiban.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-zhiban
systemctl status dsh-zhiban --no-pager
curl -fsS http://127.0.0.1:3080/ >/dev/null && echo alive
```

- unit 默认 `DSH_HOME=/var/lib/zhiban/dsh-demo`、profile `zhiban-demo`、监听 `127.0.0.1:3080`；与实际安装路径不一致时只改 unit，不动代码。
- 凭据通过 `EnvironmentFile=-/etc/zhiban/dsh.env`、`/etc/zhiban/demo.env` 注入；文件 `0600 root:root`，`zhiban` 用户无需读权限。
- 进程只监听本机；**不要**改成 `0.0.0.0`，也不要让 Nginx 反代 DSH Web 根路径。
- `ProtectSystem=strict` + `ReadWritePaths=/var/lib/zhiban`：DSH 只能写数据目录。

⏳ 待真机：`systemctl restart` 恢复、kill 后自动拉起、日志无正文/密钥（#28 已在服务器验证同类 unit，本次 unit 仍需按实际路径复核）。

## 7. 备份与恢复

### 7.1 每日备份

```bash
sudo install -d -o root -g root -m 0700 /var/backups/zhiban
sudo cp /opt/zhiban/app/deploy/systemd/zhiban-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zhiban-backup.timer
sudo systemctl start zhiban-backup.service   # 立即跑一次
sudo systemctl list-timers | grep zhiban-backup
```

备份内容与规则：

- `DSH_HOME` 全量（profiles、sessions、storages、media），排除 `*.log`、`tmp/*`、`node_modules/*`。
- 媒体目录在 `DSH_HOME` 之外时（如独立 `.../media`）一并打包。
- 文件 `zhiban-<UTC时间>.tar.gz` + 同名 `.sha256`；目录 `0700`、文件 `0600`。
- 保留最近 14 天（按 mtime 清理）。
- **备份包含凭据与患者数据**：不要放到 Web 可访问目录；异地/对象存储必须加密，并限制访问人。

### 7.2 恢复演练

```bash
sudo /opt/zhiban/app/deploy/scripts/drill-backup-restore.sh
# 期望：RESULT: PASS
```

本机已执行通过（虚构数据）：

```text
RESULT: PASS 备份与恢复演练通过（zhiban-20261109T174934Z.tar.gz）
```

真实恢复（不会覆盖运行中的数据）：

```bash
sudo systemctl stop dsh-zhiban
sudo /opt/zhiban/app/deploy/scripts/restore.sh /var/backups/zhiban/<file>.tar.gz /var/lib/zhiban/restore-$(date +%F)
# 核对 profiles/storages/media 与审计/草稿后，再切换 DSH_HOME 并启动
```

⏳ 待真机：从备份恢复到一个新目录后，草稿、审计、会话、存档 seq、媒体文件完整；服务用恢复目录启动成功。

## 8. 断档看门狗（F4）

> 会话存档只保留 5 天，停机超过 5 天的消息永久丢失，因此异常必须尽早通知。

看门狗每 5 分钟运行一次（systemd timer），检查四项；单项连续异常达到 10 分钟通知运维，恢复后再通知一次。通知只含检查项、时长与原因，不含消息正文。

| 检查项 | 数据来源 | 本地可验证 |
|---|---|---|
| DSH Host | HTTP 请求 `ZHIBAN_WATCHDOG_HOST_URL`（默认 `http://127.0.0.1:3080/`），响应 < 500 视为存活 | ✅ 单测（假 fetch） |
| 存档拉取 | `/var/lib/zhiban/status/archive-status.json` 的 `lastPolledAt`，超过 10 分钟未更新视为异常 | ✅ 单测 |
| 机器人长连接 | `/var/lib/zhiban/status/bot-status.json` 的 `connected` | ✅ 单测 |
| 模型可用性 | `/var/lib/zhiban/status/model-status.json` 的 `ok` 与 `checkedAt` | ✅ 单测 |

状态文件契约（由运维侧状态采集器写入，UTF-8 JSON）：

```json
// archive-status.json
{ "lastPolledAt": 1762700000000 }
// bot-status.json
{ "connected": true }
// model-status.json
{ "ok": true, "checkedAt": 1762700000000, "model": "deepseek-v4.1-flash",
  "callsToday": 142, "estimatedCostYuanToday": 0.86, "fallbackCount": 3 }
```

安装：

```bash
sudo install -d -o zhiban -g zhiban -m 0750 /var/lib/zhiban/status /var/lib/zhiban/state
sudo install -m 0600 -o root -g root /dev/null /etc/zhiban/watchdog.env
sudoedit /etc/zhiban/watchdog.env
```

```dotenv
# 企微群机器人 webhook 或运维通知命令（二选一；URL 含 key，禁止进 git/日志/PR）
ZHIBAN_WATCHDOG_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
# 或：通知内容从 stdin 传入
# ZHIBAN_WATCHDOG_NOTIFY_CMD=/opt/zhiban/bin/notify-ops.sh
ZHIBAN_WATCHDOG_STATUS_DIR=/var/lib/zhiban/status
ZHIBAN_WATCHDOG_STATE_FILE=/var/lib/zhiban/state/watchdog.json
ZHIBAN_WATCHDOG_FAIL_AFTER_MS=600000
ZHIBAN_WATCHDOG_STATUS_STALE_MS=600000
```

```bash
sudo cp /opt/zhiban/app/deploy/systemd/zhiban-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zhiban-watchdog.timer
sudo systemctl start zhiban-watchdog.service    # 立即跑一次
journalctl -u zhiban-watchdog -n 20 --no-pager
```

### 8.1 已知依赖（未完成部分）

`archive-status.json` / `bot-status.json` / `model-status.json` 目前**没有现成的生产者**：控制台契约里的 `GET /settings/wecom/status` 与 `GET /settings/model` 尚未在 main 实现（#51 的页面目前走 mock），`zhiban-wecom` 也没有对外暴露运行时状态。因此：

- DSH Host 检查开箱即用。
- 其余三项在状态文件缺失时会判定异常并在 10 分钟后告警——这是**保守且诚实**的行为，但会产生误报。
- 需要在 #51 / #39 或运维侧补一个状态采集器（每 1–5 分钟写入上述三个文件），或在 `zhiban-wecom` 增加只读 `getRuntimeStatus()` 后在采集器里调用。该改动属于其他工作包目录，本 PR 未越界修改。

⏳ 待真机：人为停掉存档拉取，10 分钟内运维收到告警；恢复后收到恢复通知；正常运行时 24 小时无误报。

## 9. 模型费用日报

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/zhiban/report.env
sudoedit /etc/zhiban/report.env
```

```dotenv
ZHIBAN_REPORT_STATUS_DIR=/var/lib/zhiban/status
ZHIBAN_REPORT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
```

```bash
sudo cp /opt/zhiban/app/deploy/systemd/zhiban-report.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zhiban-report.timer
ZHIBAN_REPORT_STATUS_DIR=/var/lib/zhiban/status ZHIBAN_REPORT_DRY_RUN=1 \
  node --experimental-strip-types /opt/zhiban/app/src/ops/daily-report.ts
```

- 每天 09:00 读取 `model-status.json`，推送调用次数、估算费用、模型与降级次数。
- 读不到状态文件时**报错退出**，不编造数字；systemd 里表现为 failed，可在 `journalctl` 看到原因（不含凭据）。
- 真实调用量与费用统计同样依赖上面的状态采集器。

## 10. 验收对照（#52）

| 验收标准 | 结果 |
|---|---|
| 公网 HTTPS 访问控制台登录页正常，证书有效 | ⏳ 待真机（步骤：§3、§4、§5；预期：证书有效、登录成功） |
| 公网访问 DSH Web 端口被拒绝 | ⏳ 待真机（预期：`curl https://<domain>/dsh/` 404；3080 不对公网开放） |
| 从备份恢复到新目录后数据完整 | ✅ 本地演练通过（虚构数据）；⏳ 真实数据待服务器 |
| 人为停掉存档拉取 10 分钟内，运维企微收到告警；恢复后收到恢复通知 | ⏳ 待真机（依赖 §8.1 状态采集器；步骤见 §8） |

本地已执行：

```bash
bash deploy/scripts/drill-backup-restore.sh   # RESULT: PASS
npx tsc --noEmit                              # 通过
npm test                                      # 251/251 通过（含 9 个看门狗/日报测试）
```

## 11. 回滚

```bash
# 控制台：同步回上一版 dist
sudo rsync -a --delete /var/www/zhiban/console.previous/ /var/www/zhiban/console/

# DSH：恢复 unit 与数据目录后重启
sudo systemctl stop dsh-zhiban
sudo mv /var/lib/zhiban/dsh-demo /var/lib/zhiban/dsh-demo.broken
sudo mv /var/lib/zhiban/restore-<date>/dsh-demo /var/lib/zhiban/dsh-demo
sudo chown -R zhiban:zhiban /var/lib/zhiban/dsh-demo
sudo systemctl start dsh-zhiban

# 看门狗/日报：停 timer，不改动数据
sudo systemctl disable --now zhiban-watchdog.timer zhiban-report.timer
```

证书回滚：certbot 保留 `/etc/letsencrypt/archive/` 历史版本，必要时把 `live` 软链指回上一版。

## 12. 安全与运维注意

- **F4**：存档仅 5 天。看门狗是最后一道提醒，值班人必须能在 10 分钟内响应；停机超过 5 天的消息不可恢复。
- 备份含 API Key、企微 Secret、会话存档私钥与患者数据：`0600`、异地加密、访问人最小化；**不要**上传到公开对象存储或聊天工具。
- 日志不打印消息正文与凭据；`journalctl -u dsh-zhiban` 抽查不得出现 Key、Secret、Token 或聊天内容。
- 不要用同一套机器人凭据启动第二个实例（F14）；dev 使用独立机器人与 `ZHIBAN_ENV=dev`。
- PDF 导出需要中文字体：`apt-get install -y fonts-noto-cjk`，或配置 `pdf.fontPath` / `pdf.fontFamily`（见 [P1-data-security.md](./P1-data-security.md)）。
- 新增依赖：本包未新增 npm 依赖；脚本只使用 `bash`、`tar`、`gzip`、`sha256sum`/`shasum`。
- 仓库与本文不含任何真实域名、Key、Secret、Token；`<...>` 均为占位符。

## 13. 侧边栏站点（#145）

侧边栏是企微聊天工具栏里的 H5，与控制台分开构建、分开域名、分开会话，**不进控制台路由**。

### 13.1 构建

```bash
cd console
npm ci
npm run build:sidebar     # tsc --noEmit && vite build --config vite.sidebar.config.ts
# 产物：console/dist-sidebar/index.html + assets/（gzip 后 JS 约 3 KB）
```

本机构建，不在 2 GB 的 VM 上跑；上传：

```bash
rsync -a -B en0 --delete console/dist-sidebar/ ubuntu@43.167.159.74:/tmp/zhiban-sidebar/
# 服务器上（先备份旧版本）
sudo cp -a /var/www/zhiban/sidebar /var/www/zhiban/sidebar.bak-$(date +%Y%m%d%H%M)
sudo rsync -a --delete /tmp/zhiban-sidebar/ /var/www/zhiban/sidebar/
sudo chown -R www-data:www-data /var/www/zhiban/sidebar
```

### 13.2 Nginx

```bash
sudo cp /opt/zhiban/app/deploy/nginx/zhiban-sidebar.conf /etc/nginx/sites-available/
sudo sed -i 's/<sidebar-domain>/<实际域名>/g' /etc/nginx/sites-available/zhiban-sidebar.conf
sudo ln -sf /etc/nginx/sites-available/zhiban-sidebar.conf /etc/nginx/sites-enabled/zhiban-sidebar.conf
sudo nginx -t && sudo systemctl reload nginx
```

只开放 `/sidebar/` 与 `/zhiban/sidebar/`，其余路径 404；控制台的 `/zhiban/api` 不在这个域名下。

### 13.3 插件配置

`zhiban-sidebar` 的 profile 配置需增加（Secret 只放服务器，不进仓库）：

| 字段 | 说明 |
|---|---|
| `sessionSecret` | 会话 Cookie 签名密钥；未配置时所有接口 401 |
| `corpId` / `agentId` / `agentSecret` | 自建应用凭据，用于 OAuth 与 jsapi_ticket |
| `publicBaseUrl` | `https://<sidebar-domain>`，用于拼回调地址与限制签名 URL |
| `botUserIds` | 机器人 userid，其发言不算顾问已回复 |

三项企微凭据与 `publicBaseUrl` 缺任意一项时，侧边栏登录页显示「侧边栏未配置」，不会裸跳授权。

### 13.4 企微后台 checklist（需要项目方操作）

- [ ] DNS：`<sidebar-domain>` → `43.167.159.74`（`www.xruns.cn` 指向官网，不能复用）
- [ ] 应用「网页授权及 JS-SDK」可信域名 = `<sidebar-domain>`
- [ ] 「企业微信授权登录」回调域 = `<sidebar-domain>`
- [ ] 应用可见范围加入试点顾问
- [ ] 聊天工具栏页面地址改为 `https://<sidebar-domain>/sidebar/`
- [ ] 确认顾问在患者域名册中状态为 `active`（否则回调返回 403）

### 13.5 自查

```bash
curl -s https://<sidebar-domain>/zhiban/sidebar/health          # {"ok":true,...}
curl -si https://<sidebar-domain>/zhiban/sidebar/context?chatId=x | head -1   # 401
curl -si https://<sidebar-domain>/dsh/ | head -1                # 404
```

⏳ 真机验收见 #150：外部群、外部单聊、内部群兜底、未授权顾问 401/403、弱网首屏。
