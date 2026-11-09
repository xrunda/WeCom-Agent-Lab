#!/usr/bin/env bash
#
# #30 重启持久化：创建一条一次性提醒，重启 Host 后再确认它仍存在并投递。
#
# 用法：
#   ./scripts/verify-30-persist.sh prepare [base-url] [seconds]
#   # 在 seconds 秒内重启 DSH：
#   #   本机：Ctrl-C 后重新启动
#   #   服务器：sudo systemctl restart dsh-zhiban
#   ./scripts/verify-30-persist.sh check [base-url]
#
# prepare 会把 sessionId / scheduleId / since 写入 .cache/m0-results/30-persist-state.json；
# check 读取同一个文件。默认 90 秒，给重启留出时间。
set -euo pipefail

MODE="${1:?用法：verify-30-persist.sh prepare|check [base-url] [seconds]}"
BASE="${2:-http://127.0.0.1:3399}"
SECONDS_TO_FIRE="${3:-90}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SCRIPT_DIR/../.cache/m0-results}"
STATE="$OUT/30-persist-state.json"
mkdir -p "$OUT"

post() {
  local path="$1" payload="$2"
  curl --silent --show-error --fail-with-body -X POST "$BASE$path" \
    -H 'content-type: application/json' --data-binary "$payload"
}

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

if [ "$MODE" = "prepare" ]; then
  post '/zhiban-m0/session' '{}' >"$OUT/30-persist-session.json"
  SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sessionId"])' "$OUT/30-persist-session.json")"
  SINCE="$(now_ms)"
  post '/zhiban-m0/schedule' "$(python3 -c 'import json,sys; print(json.dumps({"action":"create","sessionId":sys.argv[1],"title":"M0 重启后投递","prompt":"重启投递验证：请调用 reply_draft，body 写「重启后提醒已投递」，riskLevel 为 low。","afterSeconds":int(sys.argv[2])}, ensure_ascii=False))' "$SID" "$SECONDS_TO_FIRE")" \
    >"$OUT/30-persist-create.json"
  python3 - "$OUT/30-persist-session.json" "$OUT/30-persist-create.json" "$STATE" "$SINCE" <<'PY'
import json
import sys

session = json.load(open(sys.argv[1], encoding="utf-8"))
created = json.load(open(sys.argv[2], encoding="utf-8"))
state = {
    "sessionId": session["sessionId"],
    "scheduleId": created["record"]["id"],
    "since": int(sys.argv[4]),
    "scheduledAt": created["record"].get("scheduledAt"),
}
json.dump(state, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(json.dumps(state, ensure_ascii=False, indent=2))
PY
  cat <<EOF

提醒已创建。现在请在 ${SECONDS_TO_FIRE} 秒内重启 DSH，然后执行：
  ./scripts/verify-30-persist.sh check "$BASE"
EOF
  exit 0
fi

[ "$MODE" = "check" ] || { echo "未知模式：$MODE" >&2; exit 2; }
[ -f "$STATE" ] || { echo "缺少状态文件：$STATE（先执行 prepare）" >&2; exit 2; }
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sessionId"])' "$STATE")"
SINCE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["since"])' "$STATE")"
SCHEDULE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["scheduleId"])' "$STATE")"

post '/zhiban-m0/schedule' "$(python3 -c 'import json,sys; print(json.dumps({"action":"catalog"}, ensure_ascii=False))')" \
  >"$OUT/30-persist-catalog.json"
curl --silent --show-error --fail "$BASE/zhiban-m0/wait-turn?sessionId=$SID&since=$SINCE&timeoutMs=180000" \
  >"$OUT/30-persist-delivery.json"

python3 - "$OUT" "$SCHEDULE_ID" <<'PY'
import json
import os
import sys

out, schedule_id = sys.argv[1], sys.argv[2]
catalog = json.load(open(os.path.join(out, "30-persist-catalog.json"), encoding="utf-8"))
delivery = json.load(open(os.path.join(out, "30-persist-delivery.json"), encoding="utf-8"))
records = {record.get("id"): record for record in catalog.get("records") or []}
record = records.get(schedule_id)
turns = delivery.get("turns") or []
drafts = [d for turn in turns for d in (turn.get("drafts") or [])]
sources = sorted({u.get("source") for u in delivery.get("userMessages") or [] if u.get("source")})

print(f"schedule {schedule_id}:", json.dumps(record, ensure_ascii=False) if record else "not found")
print(f"turns={[t.get('turn') for t in turns]} sources={sources}")
for draft in drafts:
    print(f"  draft[{draft.get('riskLevel')}] {draft.get('body')}")

ok = bool(record) and bool(turns) and bool(drafts) and "schedule" in sources
if record:
    ok = ok and record.get("sessionId") == delivery.get("sessionId")
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
