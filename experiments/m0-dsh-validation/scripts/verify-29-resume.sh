#!/usr/bin/env bash
#
# #29 重启恢复：用同一个 sessionId 再注入一条消息。
#
# 用法：
#   ./scripts/verify-29-resume.sh <sessionId> [base-url] [message]
#
# 典型流程：
#   1. 运行 verify-29.sh，记录输出的 sessionId
#   2. 重启 DSH（本机 Ctrl-C 后重新启动；服务器 systemctl restart dsh-zhiban）
#   3. 运行本脚本，确认同一会话继续递增回合
set -euo pipefail

SID="${1:?用法：verify-29-resume.sh <sessionId> [base-url] [message]}"
BASE="${2:-http://127.0.0.1:3399}"
MESSAGE="${3:-请调用 reply_draft 工具，提交一条草稿：body 为「重启后同一会话继续」，riskLevel 为 low。}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SCRIPT_DIR/../.cache/m0-results}"
mkdir -p "$OUT"

PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"sessionId":sys.argv[1],"message":sys.argv[2]}, ensure_ascii=False))' "$SID" "$MESSAGE")"
curl --silent --show-error --fail-with-body -X POST "$BASE/zhiban-m0/turn" \
  -H 'content-type: application/json' --data-binary "$PAYLOAD" \
  | tee "$OUT/29-resume.json" >/dev/null

python3 - "$OUT/29-resume.json" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
turns = data.get("turns") or []
print(f"session={data.get('sessionId')} durationMs={data.get('durationMs')} turns={[t.get('turn') for t in turns]}")
for turn in turns:
    print(f"  turn {turn.get('turn')}: {turn.get('reason')}")
    for draft in turn.get("drafts") or []:
        print(f"    draft[{draft.get('riskLevel')}] {draft.get('body')}")
ok = bool(turns) and all(t.get("reason") == "completed" for t in turns)
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
