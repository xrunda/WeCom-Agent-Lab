#!/usr/bin/env bash
# 知伴健康 Agent · 本地停止
#
#   ./stop.sh            停止后台启动的服务，并清理占用 5173/5174 的本仓库 vite
#   ./stop.sh --all      与默认行为相同（保留给习惯写法）
#   ./stop.sh --force    直接 SIGKILL，不等待优雅退出
#
# 两种来源都覆盖：./start.sh --bg 写的 .run/*.pid，以及手工 npm run dev 起的
# 进程。只停本仓库的控制台/侧边栏 vite 进程：PID 属于别的程序时拒绝并提示，
# 避免误杀同机上其他项目的 dev server。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
CONSOLE_PORT="${PORT:-5173}"
SIDEBAR_PORT="${SIDEBAR_PORT:-5174}"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --all) ;;
    -f | --force) FORCE=1 ;;
    -h | --help | help)
      cat <<'EOF'
用法：
  ./stop.sh            停止后台启动的服务，并清理占用 5173/5174 的本仓库 vite
  ./stop.sh --all      与默认行为相同
  ./stop.sh --force    直接 SIGKILL，不等待优雅退出
EOF
      exit 0
      ;;
    *)
      echo "未知参数：$arg" >&2
      exit 1
      ;;
  esac
done

proc_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

proc_cwd() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

# 只认「vite 进程 + 工作目录在本仓库内」，两个条件都满足才动手
is_our_vite() {
  local pid="$1" cmd cwd
  cmd="$(proc_command "$pid")"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *vite*) ;;
    *) return 1 ;;
  esac
  cwd="$(proc_cwd "$pid")"
  if [ -n "$cwd" ]; then
    case "$cwd" in
      "$ROOT" | "$ROOT"/*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

terminate() {
  local pid="$1" name="$2"
  if [ "$FORCE" = 1 ]; then
    kill -KILL "$pid" 2>/dev/null || true
    echo "${name}：已强制停止（PID ${pid}）"
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || {
      echo "${name}：已停止（PID ${pid}）"
      return 0
    }
    sleep 0.25
    i=$((i + 1))
  done

  # 优雅退出超时（vite 卡在关闭钩子）→ 兜底强杀
  kill -KILL "$pid" 2>/dev/null || true
  echo "${name}：未在 5 秒内退出，已强制停止（PID ${pid}）"
}

stop_from_pidfile() {
  local name="$1" pidfile="$RUN_DIR/$1.pid" pid
  if [ ! -f "$pidfile" ]; then
    return 0
  fi
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  rm -f "$pidfile"

  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "${name}：未在运行"
    return 0
  fi
  if ! is_our_vite "$pid"; then
    echo "${name}：PID $pid 不是本仓库的 vite 进程，已跳过（未发送信号）" >&2
    return 0
  fi
  terminate "$pid" "$name"
}

stop_on_port() {
  local port="$1" name="$2" pid
  command -v lsof >/dev/null 2>&1 || return 0
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  [ -n "$pid" ] || return 0
  if ! is_our_vite "$pid"; then
    echo "${name}：端口 $port 被非本仓库进程占用（PID ${pid}），未处理" >&2
    return 0
  fi
  terminate "$pid" "$name"
}

mkdir -p "$RUN_DIR"
stop_from_pidfile console
stop_from_pidfile sidebar

# 手工 npm run dev 起的进程没有 pid 文件，按端口兜底
stop_on_port "$CONSOLE_PORT" "控制台"
stop_on_port "$SIDEBAR_PORT" "侧边栏"

# 顺手清掉已经没有进程的 pid 文件，避免下次 start 被误判「已在运行」
for pidfile in "$RUN_DIR"/*.pid; do
  [ -e "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
  fi
done

exit 0
