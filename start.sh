#!/usr/bin/env bash
# 知伴健康 Agent · 本地一键启动
#
#   ./start.sh                          控制台（真实接口，默认；代理到 127.0.0.1:3080）
#   ./start.sh mock                     控制台（mock 示例数据，无需后端）
#   ./start.sh http://127.0.0.1:18081   控制台（真实接口，代理到指定后端，例如 VM 隧道）
#   ./start.sh sidebar                  侧边栏 H5 开发服务（5174）
#   ./start.sh --bg <模式>               后台启动，PID 与日志写到 .run/
#
# 本仓库有两个前端入口，构建与部署口径不同：
#   console/      控制台 SPA（npm run build → dist/）
#   console/src/sidebar  企微侧边栏 H5，独立打包（npm run build:sidebar → dist-sidebar/，
#                        由 nginx 以 /sidebar/ 对外提供）
# 真实接口模式需要另有一个 DSH 后端可达；mock 模式完全离线。
#
# 停止用 ./stop.sh：既包括 --bg 启动的服务，也包括手工 npm run dev 起的
# 本仓库 vite（按 5173/5174 端口识别）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$ROOT/console"
RUN_DIR="$ROOT/.run"

CONSOLE_PORT="${PORT:-5173}"
SIDEBAR_PORT="${SIDEBAR_PORT:-5174}"

usage() {
  cat <<'EOF'
用法：
  ./start.sh                  以真实接口模式启动控制台（默认，代理到 127.0.0.1:3080）
  ./start.sh <后端地址>        以真实接口模式启动控制台，代理到指定地址
                              （例：./start.sh http://127.0.0.1:18081）
  ./start.sh real [地址]       同上，显式声明真实接口
  ./start.sh mock             以 mock 模式启动控制台（示例数据，无需后端）
  ./start.sh sidebar          以真实接口启动侧边栏 H5 开发服务
  ./start.sh --help           显示本帮助

选项：
  -d, --bg                    后台启动：日志 .run/<应用>.log，PID .run/<应用>.pid

环境变量：
  VITE_PROXY_TARGET  真实模式下 API 的代理目标（地址参数会覆盖它）
  PORT               控制台端口，默认 5173
  SIDEBAR_PORT       侧边栏端口，默认 5174

真实数据需要 DSH 后端可达；常用做法是先建隧道：
  ssh -N -L 3080:127.0.0.1:3080 <部署机账号>@<部署机地址>
mock 模式登录：admin / zhiban-demo（登录页已预填）
侧边栏本地调试需要企微 OAuth 会话：浏览器直接打开只会显示「登录已失效」，
适合调样式与结构，接口数据请在企微客户端内验证。
停止后台服务：./stop.sh
EOF
}

die() {
  echo "$1" >&2
  exit 1
}

# —— 参数解析：先摘选项，剩下的按位置解释 ——
BACKGROUND=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    -d | --bg | --background) BACKGROUND=1 ;;
    -h | --help | help)
      usage
      exit 0
      ;;
    *)
      POSITIONAL+=("$arg")
      ;;
  esac
done

MODE="real"
PROXY_TARGET=""
case "${POSITIONAL[0]:-}" in
  "")
    ;;
  mock)
    [ "${#POSITIONAL[@]}" -eq 1 ] || die "mock 模式不接受地址参数。"
    MODE="mock"
    ;;
  real)
    [ "${#POSITIONAL[@]}" -le 2 ] || die "real 模式最多接受一个地址参数。"
    PROXY_TARGET="${POSITIONAL[1]:-}"
    ;;
  sidebar)
    [ "${#POSITIONAL[@]}" -eq 1 ] || die "sidebar 模式不接受其他参数。"
    MODE="sidebar"
    ;;
  http://* | https://*)
    [ "${#POSITIONAL[@]}" -eq 1 ] || die "最多接受一个地址参数。"
    PROXY_TARGET="${POSITIONAL[0]}"
    ;;
  *)
    echo "未知参数：$arg" >&2
    usage >&2
    exit 1
    ;;
esac

# —— 运行环境 ——
if ! command -v node >/dev/null 2>&1; then
  die "未找到 node，请先安装 Node.js 22.6 或更高版本。"
fi

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`当前 Node ${process.versions.node}，需要 >= 22.6`);
  process.exit(1);
}' || exit 1

# 依赖：首次安装；package-lock.json 比安装标记新时同步，避免改依赖后仍跑旧版本
LOCK="$CONSOLE_DIR/package-lock.json"
MARKER="$CONSOLE_DIR/node_modules/.package-lock.json"
if [ ! -d "$CONSOLE_DIR/node_modules" ] || [ ! -x "$CONSOLE_DIR/node_modules/.bin/vite" ]; then
  echo "首次启动：安装控制台依赖（npm ci）…"
  (cd "$CONSOLE_DIR" && npm ci --no-audit --no-fund)
elif [ "$LOCK" -nt "$MARKER" ]; then
  echo "package-lock.json 有更新：同步控制台依赖（npm ci）…"
  (cd "$CONSOLE_DIR" && npm ci --no-audit --no-fund)
fi

# —— 每个入口的启动参数 ——
if [ "$MODE" = "sidebar" ]; then
  APP="sidebar"
  APP_LABEL="侧边栏 H5"
  PORT="$SIDEBAR_PORT"
  VITE_ARGS=(--config vite.sidebar.config.ts)
else
  APP="console"
  APP_LABEL="控制台"
  PORT="$CONSOLE_PORT"
  VITE_ARGS=()
fi

if [ "$MODE" = "mock" ]; then
  # 避免外部残留的 VITE_API_MODE=real 干扰 mock 模式
  unset VITE_API_MODE
  unset VITE_PROXY_TARGET
else
  export VITE_API_MODE=real
  TARGET="${PROXY_TARGET:-${VITE_PROXY_TARGET:-http://127.0.0.1:3080}}"
  TARGET="${TARGET%/}"
  export VITE_PROXY_TARGET="$TARGET"
fi

# 端口固定：后台/前台都走 strictPort，端口被占直接失败，不静默换端口
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "端口 $PORT 已被占用：可能是上次后台启动的服务（./stop.sh），或其他 dev server。"
fi

print_banner() {
  echo ""
  echo "知伴健康 Agent · ${APP_LABEL}（${1}）"
  if [ "$MODE" = "mock" ]; then
    echo "  模式：mock（示例数据，不连接真实后端）"
  else
    echo "  模式：real（真实接口）→ $TARGET"
  fi
  echo "  地址：http://127.0.0.1:$PORT"
  if [ "$MODE" = "mock" ]; then
    echo "  登录：admin / zhiban-demo（登录页已预填）"
  elif [ "$MODE" = "sidebar" ]; then
    echo "  登录：需企微 OAuth 会话；浏览器直开会显示「登录已失效」"
  else
    echo "  登录：使用部署机上的真实账号"
  fi
  echo ""
}

start_background() {
  local name="$1"
  shift
  mkdir -p "$RUN_DIR"
  local pidfile="$RUN_DIR/$name.pid"
  local logfile="$RUN_DIR/$name.log"

  if [ -f "$pidfile" ]; then
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      echo "$name 已在后台运行（PID ${old}）；需要重启请先 ./stop.sh" >&2
      return 1
    fi
    rm -f "$pidfile"
  fi

  (cd "$CONSOLE_DIR" && exec ./node_modules/.bin/vite ${VITE_ARGS[@]+"${VITE_ARGS[@]}"} --host 127.0.0.1 --port "$PORT" --strictPort) \
    >"$logfile" 2>&1 &
  local pid=$!
  echo "$pid" >"$pidfile"

  # 端口占用等错误会让 vite 立刻退出，等一拍再确认
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "启动失败，最近日志：" >&2
    tail -n 20 "$logfile" >&2 || true
    rm -f "$pidfile"
    return 1
  fi

  echo "已在后台启动：${name}（PID ${pid}）"
  echo "  日志：$logfile"
  echo "  停止：./stop.sh"
}

if [ "$BACKGROUND" = 1 ]; then
  print_banner "后台"
  start_background "$APP"
  exit 0
fi

print_banner "$MODE"
echo "  停止：Ctrl+C"
echo ""

cd "$CONSOLE_DIR"
exec ./node_modules/.bin/vite ${VITE_ARGS[@]+"${VITE_ARGS[@]}"} --host 127.0.0.1 --port "$PORT" --strictPort
