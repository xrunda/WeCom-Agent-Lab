#!/usr/bin/env bash
# 知伴健康 Agent · 本地一键启动
#
#   ./start.sh                              控制台（mock 示例数据，无需后端）
#   ./start.sh real                         控制台（真实接口，代理到 127.0.0.1:3080）
#   ./start.sh real http://127.0.0.1:18081  代理到指定后端（例如 VM 隧道）
#
# 本仓库可运行的界面是 console（React + Vite）。mock 模式完全离线；
# 真实接口模式需要另有一个 DSH 后端在运行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$ROOT/console"
MODE="${1:-mock}"
PROXY_TARGET="${2:-}"

usage() {
  cat <<'EOF'
用法：
  ./start.sh                 以 mock 模式启动控制台（默认，示例数据）
  ./start.sh real [地址]      以真实接口模式启动；地址默认 http://127.0.0.1:3080
  ./start.sh --help          显示本帮助

环境变量：
  VITE_PROXY_TARGET  真实模式下 /zhiban/api 的代理目标（第二个参数会覆盖它）

mock 模式登录：admin / zhiban-demo（登录页已预填）
EOF
}

case "$MODE" in
  mock | real) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    echo "未知模式：$MODE" >&2
    usage >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js 22.6 或更高版本。" >&2
  exit 1
fi

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`当前 Node ${process.versions.node}，需要 >= 22.6`);
  process.exit(1);
}' || exit 1

if [ ! -d "$CONSOLE_DIR/node_modules" ]; then
  echo "首次启动：安装控制台依赖（npm ci）…"
  (cd "$CONSOLE_DIR" && npm ci --no-audit --no-fund)
fi

if [ "$MODE" = "mock" ]; then
  # 避免外部残留的 VITE_API_MODE=real 干扰 mock 模式
  unset VITE_API_MODE
else
  export VITE_API_MODE=real
  if [ -n "$PROXY_TARGET" ]; then
    export VITE_PROXY_TARGET="$PROXY_TARGET"
  fi
  TARGET="${VITE_PROXY_TARGET:-http://127.0.0.1:3080}"
  echo "真实接口模式：/zhiban/api → $TARGET"
  echo "请确认该后端已启动；未登录接口应返回 401。"
fi

echo ""
echo "知伴健康 Agent 控制台"
echo "  模式：$MODE"
echo "  地址：http://127.0.0.1:5173（端口被占用时 Vite 会自动换一个）"
if [ "$MODE" = "mock" ]; then
  echo "  登录：admin / zhiban-demo（登录页已预填）"
fi
echo "  停止：Ctrl+C"
echo ""

cd "$CONSOLE_DIR"
exec npm run dev -- --host 127.0.0.1
