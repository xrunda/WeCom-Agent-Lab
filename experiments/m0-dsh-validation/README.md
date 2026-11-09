# M0 DSH 底座验证（WP-B）

对应 P1 工作包 B：#28、#29、#30。目标是确认「一位患者 = 一条长期会话」和
「控制台 API / 主动计划」在 DSH 0.2.1-rc.5 上成立。

- 结论、证据和看图摸底结果：[`docs/P1-M0-dsh-validation.md`](../../docs/P1-M0-dsh-validation.md)
- 服务器部署：[`deploy/README.md`](deploy/README.md)
- 许可与图片来源：[`assets/sources.json`](assets/sources.json)

## 目录

```text
experiments/m0-dsh-validation/
├── plugins/
│   ├── zhiban-hello.js          # 最小 hello 插件（只注册一个工具）
│   └── zhiban-m0.js             # 注入 / 路由 / SSE / schedule / inventory 验证插件
├── scripts/
│   ├── setup-profile.sh         # 创建 zhiban profile 并写入插件 patch
│   ├── fetch-images.sh          # 下载 5 张公开授权餐食照片
│   ├── vision-probe.py          # 发图给 DeepSeek V4.1 Flash，记录识别与耗时
│   ├── verify-29.sh             # 注入、排队、捕获 reply_draft
│   ├── verify-29-resume.sh      # 重启后用同一 session 继续注入
│   ├── verify-30.sh             # Connection Fetch / SSE / schedule / inventory
│   ├── verify-30-persist.sh     # 提醒跨重启持久化（prepare / check）
│   └── curl-sse.sh              # 单独验证 SSE 长连接
├── deploy/
│   ├── dsh-zhiban.service       # systemd unit（不含密钥）
│   └── README.md                # Ubuntu VM 安装、密钥、验收步骤
└── assets/
    ├── 06-lab-report-synthetic.png  # 虚构化验单，仅用于识图测试
    └── sources.json                 # 图片来源、作者、许可
```

餐食照片不提交进仓库，用 `fetch-images.sh` 下载到本地缓存目录。

## 本机快速开始

要求：Node.js >= 22.6，DSH 0.2.1-rc.5。

```bash
# 1. 安装精确版本的 DSH
npm install -g @deepseek-ai/dsh@0.2.1-rc.5

# 2. 创建/复用 zhiban profile（默认 ~/.dsh）
./scripts/setup-profile.sh

# 3. 前台启动，仅本机监听
dsh --profile zhiban --no-open --host 127.0.0.1 --port 3399

# 4. 另开一个终端，跑验证
./scripts/verify-29.sh
./scripts/verify-30.sh
```

DeepSeek API Key 由本机 DSH 的凭据配置或启动环境提供；本目录任何文件都不应包含 Key。
没有 Key 时，健康检查与插件加载仍能通过，但模型回合会失败。

### 看图摸底

```bash
./scripts/fetch-images.sh ./.cache/m0-images
python3 ./scripts/vision-probe.py \
  --assets ./.cache/m0-images \
  --out ./.cache/m0-results
```

每张图单独建会话。结果 JSON 里保留完整 `reply_draft` 参数、回合状态、耗时和 token usage；
`.cache/` 不提交进 git。

### 重启持久化

```bash
# 终端 1：创建 90 秒后触发的一次性提醒
./scripts/verify-30-persist.sh prepare http://127.0.0.1:3399 90

# 在 90 秒内重启 DSH
# 终端 2：确认提醒仍在，并等待它投递进原会话
./scripts/verify-30-persist.sh check
```

服务器上把「重启 DSH」换成 `sudo systemctl restart dsh-zhiban`。

## 说明与边界

- 本目录是**验证代码**，不是 P1 业务实现；`zhiban-m0.js` 的 HTTP 路由没有鉴权，不能直接
  搬到生产。P1 的控制台 API 应使用同一 `ctx.webServer.register` 机制，并自行加认证、
  限流和来源限制。
- `reply_draft` 只是 M0 用来捕获工具调用参数的假工具，不是生产草稿模型。
- 所有消息正文只存在内存和 HTTP 响应中，插件不打印正文。
- 验证数据全部是虚构的；餐食照片来自 Wikimedia Commons，许可见 `assets/sources.json`。
- 不要把本目录的 profile patch 直接当成生产配置：生产环境应把插件路径固定到
  `/opt/zhiban/plugins`，并按 `deploy/README.md` 的步骤创建。
