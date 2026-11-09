# DSH `zhiban` 服务部署（Ubuntu VM）

本文是 #28 的服务器部分。**本机（macOS）只验证了 profile、插件链路、模型调用、看图；
systemd、开机自启、kill 后拉起没有在 Ubuntu VM 上执行，PR 中按「⏳ 待真机」处理。**

## 目录布局

| 路径 | 用途 |
|---|---|
| `/usr/local/bin/dsh` | 全局安装的 DSH CLI（`@deepseek-ai/dsh@0.2.1-rc.5`） |
| `/var/lib/zhiban` | 服务用户 home；systemd 的 `HOME` |
| `/var/lib/zhiban/dsh` | `DSH_HOME` |
| `/var/lib/zhiban/dsh/profiles/zhiban` | `zhiban` profile |
| `/var/lib/zhiban/workspaces/zhiban-m0` | M0 验证插件的工作目录 |
| `/opt/zhiban/plugins` | 插件文件（`zhiban-hello.js`、`zhiban-m0.js`） |
| `/etc/zhiban/dsh.env` | 部署侧环境文件，权限 `root:root 0600`；**不进 git** |

`dsh` 默认把 profile 放在 `$DSH_HOME/profiles/<name>`。本服务显式设置
`DSH_HOME=/var/lib/zhiban/dsh`，因此不要用 root 的 `~/.dsh`。

## 1. 安装 Node.js 与 DSH（精确版本）

Ubuntu 22.04/24.04 自带的 Node 通常低于 DSH 要求的 22.6。用 NodeSource 安装 Node 24：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # 需要 >= v22.6
npm --version

sudo npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version    # 必须输出 0.2.1-rc.5
```

如果 `which dsh` 不是 `/usr/local/bin/dsh`，修改 unit 的 `ExecStart` 为实际路径。

## 2. 建服务用户和目录

```bash
sudo useradd --system --home /var/lib/zhiban --shell /usr/sbin/nologin zhiban 2>/dev/null || true
sudo install -d -o zhiban -g zhiban -m 0750 /var/lib/zhiban /var/lib/zhiban/dsh /var/lib/zhiban/workspaces /var/lib/zhiban/workspaces/zhiban-m0
sudo install -d -o root -g root -m 0755 /opt/zhiban /opt/zhiban/plugins

# 把本仓库的两个验证插件拷到部署目录
sudo install -o root -g root -m 0644 \
  experiments/m0-dsh-validation/plugins/zhiban-hello.js \
  experiments/m0-dsh-validation/plugins/zhiban-m0.js \
  /opt/zhiban/plugins/
```

## 3. 创建 `zhiban` profile

以 `zhiban` 用户执行（脚本会从官方 `web` 模板创建 profile，并写入插件 patch）：

```bash
sudo -u zhiban env \
  DSH_HOME=/var/lib/zhiban/dsh \
  PLUGIN_DIR=/opt/zhiban/plugins \
  WORKSPACE_DIR=/var/lib/zhiban/workspaces/zhiban-m0 \
  bash experiments/m0-dsh-validation/scripts/setup-profile.sh
```

脚本最后会执行 `dsh --profile zhiban --dump-config` 并检查 `zhiban-hello` / `zhiban-m0`。
手动复核：

```bash
sudo -u zhiban env DSH_HOME=/var/lib/zhiban/dsh \
  dsh --profile zhiban --dump-config | grep -E 'zhiban-(hello|m0)'
```

## 4. 配置 DeepSeek API Key（部署侧）

**不要把 Key 写进 unit、profile、脚本、git、日志或 PR。** 用 systemd 的环境文件：

```bash
sudo install -d -o root -g root -m 0750 /etc/zhiban
sudo install -m 0600 -o root -g root /dev/null /etc/zhiban/dsh.env
sudoedit /etc/zhiban/dsh.env
```

文件内容（等号后替换为真实值）：

```dotenv
DEEPSEEK_API_KEY=...
```

说明：

- DSH 的 `dsh-credentials-local` 读取顺序是：已保存的凭据文件 > 启动环境 > 项目 `.env` > harness home `.env`；`DEEPSEEK_API_KEY` 是默认环境变量名。
- 本项目用 **启动环境**（systemd `EnvironmentFile`）即可；不要把 Key 存进仓库。
- `dsh.env` 由 systemd 以 root 读取后注入进程，服务用户 `zhiban` 不需要有读权限。

## 5. 安装 systemd unit

```bash
sudo cp experiments/m0-dsh-validation/deploy/dsh-zhiban.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-zhiban
sudo systemctl status dsh-zhiban --no-pager
```

服务只监听 `127.0.0.1:3080`，不对公网暴露。健康检查：

```bash
curl -sS http://127.0.0.1:3080/zhiban-m0/health
```

如果控制台后端不在同一台机器，**不要**改成 `0.0.0.0`；改为绑定内网地址并用安全组/防火墙限定来源。
DSH Web 的 `--host` 只接受具体地址，不接受通配地址。

## 6. 验收（服务器上执行，结果写回 #28）

```bash
# a) dump-config 能看到 hello 插件
sudo -u zhiban env DSH_HOME=/var/lib/zhiban/dsh \
  dsh --profile zhiban --dump-config | grep zhiban-hello

# b) 重启后健康检查恢复
sudo systemctl restart dsh-zhiban
sleep 5
curl -sS http://127.0.0.1:3080/zhiban-m0/health

# c) kill 主进程，10 秒内被 systemd 拉起
PID=$(systemctl show -p MainPID --value dsh-zhiban)
sudo kill -9 "$PID"
sleep 10
systemctl is-active dsh-zhiban
systemctl show -p MainPID --value dsh-zhiban   # 应不同于旧 PID

# d) Web 里新开会话，确认模型为 DeepSeek-V4.1-Flash，并能调用 hello 工具
```

c) 结束后检查 `journalctl -u dsh-zhiban -n 50 --no-pager`。日志不应出现消息正文或 API Key。

## 7. 回滚 / 清理

```bash
sudo systemctl disable --now dsh-zhiban
sudo rm -f /etc/systemd/system/dsh-zhiban.service
sudo systemctl daemon-reload
# 确认不再需要后再删除 /var/lib/zhiban 和 /opt/zhiban
```

`/etc/zhiban/dsh.env` 含凭据，删除前确认没有其他服务使用。
