#!/usr/bin/env bash
#
# #30：验证插件 HTTP 路由、SSE、ctx.schedule、插件清单。
#
# 前置：DSH Web 已启动，zhiban-m0 插件已加载。
# 用法：./scripts/verify-30.sh [base-url]
#
# Connection Fetch 路由只对 owner 开放。未认证调用预期返回 401；
# 如需验证 200，设置 DSH_COOKIE_JAR 指向一个已登录 DSH Web 的 cookie jar：
#   DSH_COOKIE_JAR=/tmp/dsh-cookies.txt ./scripts/verify-30.sh
# 本脚本不会打印 cookie 内容，也不会把 cookie 写进结果目录。
set -euo pipefail

BASE="${1:-http://127.0.0.1:3399}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SCRIPT_DIR/../.cache/m0-results}"
mkdir -p "$OUT"

post() {
  local path="$1" payload="$2"
  curl --silent --show-error --fail-with-body -X POST "$BASE$path" \
    -H 'content-type: application/json' --data-binary "$payload"
}

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

printf '0) 健康检查\n'
curl --silent --show-error --fail "$BASE/zhiban-m0/health" | tee "$OUT/30-health.json" >/dev/null
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("  plugin=%s plugins=%s model=%s" % (d.get("plugin"), d.get("plugins"), d.get("model")))' "$OUT/30-health.json"

printf '\n1) Connection Fetch：未认证调用\n'
CFETCH="$BASE/api/zhiban-m0/cfetch/ping"
STATUS="$(curl --silent --show-error --output "$OUT/30-cfetch-unauth.txt" --write-out '%{http_code}' "$CFETCH" || true)"
printf '  GET %s -> HTTP %s（预期 401；content-type 由 Web 服务决定）\n' "$CFETCH" "$STATUS"

if [ -n "${DSH_COOKIE_JAR:-}" ] && [ -f "$DSH_COOKIE_JAR" ]; then
  printf '  owner 认证调用（cookie jar 仅本地使用）\n'
  curl --silent --show-error --fail --cookie "$DSH_COOKIE_JAR" "$CFETCH" | tee "$OUT/30-cfetch-get.json" >/dev/null
  curl --silent --show-error --fail --cookie "$DSH_COOKIE_JAR" -X POST "$CFETCH" \
    -H 'content-type: application/json' -d '{"hello":"cfetch"}' | tee "$OUT/30-cfetch-post.json" >/dev/null
  printf '  GET/POST 均成功\n'
else
  printf '  未设置 DSH_COOKIE_JAR，跳过 owner 认证调用\n'
fi

printf '\n2) SSE 长连接（60 秒）\n'
SSE_META="$(curl --silent --show-error --no-buffer --max-time 70 \
  --output "$OUT/30-sse.txt" --write-out '%{http_code} %{time_total}' \
  "$BASE/zhiban-m0/sse?seconds=60")"
printf '  HTTP/time: %s\n' "$SSE_META"
printf '  hello=%s tick=%s done=%s\n' \
  "$(grep -c '^event: hello' "$OUT/30-sse.txt" || true)" \
  "$(grep -c '^event: tick' "$OUT/30-sse.txt" || true)" \
  "$(grep -c '^event: done' "$OUT/30-sse.txt" || true)"

printf '\n3) ctx.schedule：一次性提醒投递进原会话\n'
post '/zhiban-m0/session' '{}' | tee "$OUT/30-session.json" >/dev/null
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sessionId"])' "$OUT/30-session.json")"
SINCE="$(now_ms)"
printf '  sessionId=%s since=%s\n' "$SID" "$SINCE"
post '/zhiban-m0/schedule' "$(python3 -c 'import json,sys; print(json.dumps({"action":"create","sessionId":sys.argv[1],"title":"M0 一次性提醒","prompt":"请调用 reply_draft，body 写「M0 一次性提醒已投递」，riskLevel 为 low。","afterSeconds":5}, ensure_ascii=False))' "$SID")" \
  | tee "$OUT/30-schedule-create.json" >/dev/null
curl --silent --show-error --fail "$BASE/zhiban-m0/wait-turn?sessionId=$SID&since=$SINCE&timeoutMs=120000" \
  | tee "$OUT/30-schedule-delivery.json" >/dev/null

printf '4) cron 提醒：创建 / 列出 / 删除\n'
post '/zhiban-m0/schedule' "$(python3 -c 'import json,sys; print(json.dumps({"action":"create","sessionId":sys.argv[1],"title":"M0 cron 提醒","prompt":"cron 验证：请调用 reply_draft，body 写「cron 提醒」。","cron":{"expression":"*/5 * * * *","time_zone":"Asia/Shanghai"}}, ensure_ascii=False))' "$SID")" \
  | tee "$OUT/30-cron-create.json" >/dev/null
CRON_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["record"]["id"])' "$OUT/30-cron-create.json")"
post '/zhiban-m0/schedule' "$(python3 -c 'import json,sys; print(json.dumps({"action":"list","sessionId":sys.argv[1]}, ensure_ascii=False))' "$SID")" \
  | tee "$OUT/30-schedule-list.json" >/dev/null
post '/zhiban-m0/schedule' "$(python3 -c 'import json,sys; print(json.dumps({"action":"delete","sessionId":sys.argv[1],"id":sys.argv[2]}, ensure_ascii=False))' "$SID" "$CRON_ID")" \
  | tee "$OUT/30-cron-delete.json" >/dev/null

printf '5) 插件清单\n'
curl --silent --show-error --fail "$BASE/zhiban-m0/inventory" | tee "$OUT/30-inventory.json" >/dev/null

printf '\n结果汇总\n'
python3 - "$OUT" <<'PY'
import json
import os
import sys

out = sys.argv[1]
def load(name):
    return json.load(open(os.path.join(out, name), encoding="utf-8"))

ok = True
health = load("30-health.json")
print(f"health: plugin={health.get('plugin')} plugins={health.get('plugins')}")

sse_meta = open(os.path.join(out, "30-sse.txt"), encoding="utf-8").read()
hello = sse_meta.count("event: hello")
tick = sse_meta.count("event: tick")
done = sse_meta.count("event: done")
print(f"sse: hello={hello} tick={tick} done={done}")
if hello < 1 or tick < 10 or done < 1:
    ok = False

delivery = load("30-schedule-delivery.json")
turns = delivery.get("turns") or []
drafts = [d for t in turns for d in (t.get("drafts") or [])]
sources = sorted({u.get("source") for u in delivery.get("userMessages") or [] if u.get("source")})
print(f"schedule delivery: turns={[t.get('turn') for t in turns]} sources={sources}")
for draft in drafts:
    print(f"  draft[{draft.get('riskLevel')}] {draft.get('body')}")
if not turns or not drafts or "schedule" not in sources:
    ok = False

cron = load("30-cron-create.json")
listed = load("30-schedule-list.json")
deleted = load("30-cron-delete.json")
print(f"cron: created={cron.get('record', {}).get('id')} listed={[r.get('id') for r in listed.get('records') or []]}")
if not cron.get("record", {}).get("id"):
    ok = False
if not deleted.get("ok"):
    ok = False

inventory = load("30-inventory.json")
blob = json.dumps(inventory, ensure_ascii=False)
print(f"inventory: total={inventory.get('total')} "
      f"has_zhiban_hello={'zhiban-hello' in blob} has_zhiban_m0={'zhiban-m0' in blob}")
if inventory.get("total", 0) <= 0 or "zhiban-m0" not in blob:
    ok = False

print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
