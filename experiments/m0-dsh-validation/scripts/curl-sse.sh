#!/usr/bin/env bash
#
# 单独验证 SSE 长连接：默认持续 60 秒，打印事件和服务端耗时。
# 用法：./scripts/curl-sse.sh [base-url] [seconds]
set -euo pipefail

BASE="${1:-http://127.0.0.1:3399}"
SECONDS_TO_STREAM="${2:-60}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SCRIPT_DIR/../.cache/m0-results}"
mkdir -p "$OUT"
FILE="$OUT/sse-${SECONDS_TO_STREAM}s.txt"

META="$(curl --silent --show-error --no-buffer --max-time "$((SECONDS_TO_STREAM + 15))" \
  --output "$FILE" --write-out '%{http_code} %{time_total}' \
  "$BASE/zhiban-m0/sse?seconds=$SECONDS_TO_STREAM")"

printf 'HTTP/time: %s\n' "$META"
printf 'hello=%s tick=%s done=%s\n' \
  "$(grep -c '^event: hello' "$FILE" || true)" \
  "$(grep -c '^event: tick' "$FILE" || true)" \
  "$(grep -c '^event: done' "$FILE" || true)"
printf '原始事件：%s\n' "$FILE"
