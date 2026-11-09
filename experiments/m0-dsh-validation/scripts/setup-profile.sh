#!/usr/bin/env bash
#
# 创建（或复用）DSH 的 `zhiban` profile，并把 M0 验证插件写进 profile patch。
#
# 不包含任何密钥。DeepSeek API Key 由部署环境提供（见 deploy/README.md）。
#
# 用法：
#   ./scripts/setup-profile.sh
#   DSH_HOME=/var/lib/zhiban/dsh PLUGIN_DIR=/opt/zhiban/plugins ./scripts/setup-profile.sh
#
# 环境变量：
#   DSH_HOME     默认 ~/.dsh；服务器上建议 /var/lib/zhiban/dsh
#   PROFILE      默认 zhiban
#   PLUGIN_DIR   默认本仓库的 experiments/m0-dsh-validation/plugins
#   WORKSPACE_DIR 默认 $DSH_HOME/workspaces/zhiban-m0
#   DSH_VERSION  默认 0.2.1-rc.5（精确锁定）
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.2.1-rc.5}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-zhiban}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/plugins}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$DSH_HOME/workspaces/zhiban-m0}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "找不到 node；DSH 需要 Node.js >= 22.6"
command -v npm >/dev/null 2>&1 || fail "找不到 npm"
command -v dsh >/dev/null 2>&1 || fail "找不到 dsh；先执行 npm install -g @deepseek-ai/dsh@$DSH_VERSION"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  fail "Node.js 版本过低：$(node --version)，需要 >= 22.6"
fi

INSTALLED="$(dsh --version 2>/dev/null | head -n 1 | tr -d '[:space:]')"
[ "$INSTALLED" = "$DSH_VERSION" ] || fail "dsh 版本不匹配：期望 $DSH_VERSION，实际 $INSTALLED"

for plugin in zhiban-hello.js zhiban-m0.js; do
  [ -f "$PLUGIN_DIR/$plugin" ] || fail "缺少插件文件：$PLUGIN_DIR/$plugin"
done

mkdir -p "$DSH_HOME" "$WORKSPACE_DIR"

# 只在 profile 不存在时从官方 web 模板创建；已有 profile 不覆盖，避免抹掉部署侧改动。
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  printf '创建 profile：%s\n' "$PROFILE_DIR"
  DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
else
  printf '复用已有 profile：%s\n' "$PROFILE_DIR"
fi

json_quote() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ]; then
  BACKUP="$PATCH.bak.$(date '+%Y%m%d-%H%M%S')"
  cp "$PATCH" "$BACKUP"
  printf '已备份原 patch：%s\n' "$BACKUP"
fi

cat >"$PATCH" <<YAML
# zhiban profile：M0 验证插件。由 experiments/m0-dsh-validation/scripts/setup-profile.sh 生成。
# 注意：这里的 name 是部署机上的绝对路径；换机器后重新执行本脚本。
- insert:
    - id: zhiban-hello
      name: $(json_quote "$PLUGIN_DIR/zhiban-hello.js")
    - id: zhiban-m0
      name: $(json_quote "$PLUGIN_DIR/zhiban-m0.js")
      config:
        cwd: $(json_quote "$WORKSPACE_DIR")
        sseSeconds: 60
        turnTimeoutMs: 180000
YAML

printf '校验 profile 组合结果...\n'
DUMP="$(DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --dump-config)"
printf '%s\n' "$DUMP" | grep -q 'zhiban-hello' || fail "dump-config 中看不到 zhiban-hello"
printf '%s\n' "$DUMP" | grep -q 'zhiban-m0' || fail "dump-config 中看不到 zhiban-m0"

cat <<EOF

完成。

  DSH_HOME      $DSH_HOME
  profile       $PROFILE_DIR
  plugins       $PLUGIN_DIR
  workspace     $WORKSPACE_DIR

启动（前台，仅供本机验证）：
  DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --no-open --host 127.0.0.1 --port 3399

服务器长期运行请用 deploy/dsh-zhiban.service，见 deploy/README.md。
DeepSeek API Key 只放在部署环境，不要写进本脚本或 profile。
EOF
