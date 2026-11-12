#!/usr/bin/env bash
# 知伴健康 Agent · 本地一键启动
#
#   ./start.sh                              控制台（真实接口，默认；代理到 127.0.0.1:3080）
#   ./start.sh http://127.0.0.1:18081       控制台（真实接口，代理到指定后端，例如 VM 隧道）
#   ./start.sh real [地址]                   同上，显式声明真实接口
#   ./start.sh mock                         控制台（mock 示例数据，无需后端）
#
# 本仓库可运行的界面是 console（React + Vite）。真实接口模式需要另有一个
# DSH 后端可达；mock 模式完全离线。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$ROOT/console"

usage() {
  cat <<'EOF'
用法：
  ./start.sh                  以真实接口模式启动（默认，代理到 127.0.0.1:3080）
  ./start.sh <后端地址>        以真实接口模式启动，代理到指定地址
                              （例：./start.sh http://127.0.0.1:18081）
  ./start.sh real [地址]       同上，显式声明真实接口
  ./start.sh mock             以 mock 模式启动（示例数据，无需后端）
  ./start.sh --help           显示本帮助

环境变量：
  VITE_PROXY_TARGET  真实模式下 /zhiban/api 的代理目标（参数会覆盖它）

真实数据需要 DSH 后端可达；常用做法是先建隧道：
  ssh -N -L 3080:127.0.0.1:3080 <部署机账号>@<部署机地址>
mock 模式登录：admin / zhiban-demo（登录页已预填）
EOF
}

MODE="real"
PROXY_TARGET=""
case "${1:-}" in
  "")
    ;;
  mock)
    if [ -n "${2:-}" ]; then
      echo "mock 模式不接受地址参数。" >&2
      exit 1
    fi
    MODE="mock"
    ;;
  real)
    PROXY_TARGET="${2:-}"
    ;;
  http://* | https://*)
    PROXY_TARGET="$1"
    ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    echo "未知参数：$1" >&2
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
  TARGET="${PROXY_TARGET:-${VITE_PROXY_TARGET:-http://127.0.0.1:3080}}"
  TARGET="${TARGET%/}"
  export VITE_PROXY_TARGET="$TARGET"
  echo "真实接口模式：/zhiban/api → $TARGET"
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$TARGET/zhiban/api/auth/session" || true)"
    if [ "$code" = "000" ] || [ -z "$code" ]; then
      echo "  ⚠ 连不上后端：先确认隧道已建立，或改用 ./start.sh mock 看示例数据。"
    else
      echo "  后端连通：HTTP $code（401 表示正常，未登录）"
    fi
  fi
fi

echo ""
echo "知伴健康 Agent 控制台"
if [ "$MODE" = "mock" ]; then
  echo "  模式：mock（示例数据，不连接真实后端）"
else
  echo "  模式：real（真实接口）"
fi
echo "  地址：http://127.0.0.1:5173（端口被占用时 Vite 会自动换一个）"
if [ "$MODE" = "mock" ]; then
  echo "  登录：admin / zhiban-demo（登录页已预填）"
else
  echo "  登录：使用部署机上的真实账号"
fi
echo "  停止：Ctrl+C"
echo ""

cd "$CONSOLE_DIR"
exec npm run dev -- --host 127.0.0.1
