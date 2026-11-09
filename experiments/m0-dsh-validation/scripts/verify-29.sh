#!/usr/bin/env bash
#
# #29：验证插件在没有客户端连接时向长期会话注入消息并触发回合。
#
# 前置：DSH Web 已启动，zhiban-m0 插件已加载。
# 用法：./scripts/verify-29.sh [base-url]
# 结果：./.cache/m0-results/29-*.json（不会写日志，也不包含密钥）
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

printf '健康检查：%s\n' "$BASE"
curl --silent --show-error --fail "$BASE/zhiban-m0/health" | tee "$OUT/29-health.json" >/dev/null
printf '  %s\n' "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("plugin=%s node=%s model=%s" % (d.get("plugin"), d.get("node"), d.get("model")))' "$OUT/29-health.json")"

printf '\n1) 新建会话\n'
post '/zhiban-m0/session' '{}' | tee "$OUT/29-session.json" >/dev/null
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sessionId"])' "$OUT/29-session.json")"
printf '  sessionId=%s\n' "$SID"

printf '\n2) 路径 A：sessionController.prompt（模拟患者消息）\n'
post '/zhiban-m0/turn' "$(python3 -c 'import json,sys; print(json.dumps({"sessionId":sys.argv[1],"message":"请调用 reply_draft 工具，提交一条草稿：body 为「路径A：sessionController.prompt」，riskLevel 为 low。"}, ensure_ascii=False))' "$SID")" \
  | tee "$OUT/29-turn-a.json" >/dev/null

printf '3) 路径 B：resolveAgent + agent.followup（模拟主动投递）\n'
post '/zhiban-m0/turn-raw' "$(python3 -c 'import json,sys; print(json.dumps({"sessionId":sys.argv[1],"message":"请调用 reply_draft 工具，提交一条草稿：body 为「路径B：followup」，riskLevel 为 low。"}, ensure_ascii=False))' "$SID")" \
  | tee "$OUT/29-turn-b.json" >/dev/null

printf '4) 连续注入 3 条消息（排队）\n'
post '/zhiban-m0/burst' "$(python3 -c 'import json,sys; print(json.dumps({"sessionId":sys.argv[1],"messages":["请调用 reply_draft，body 写「排队A」，riskLevel 为 low。","请调用 reply_draft，body 写「排队B」，riskLevel 为 low。","请调用 reply_draft，body 写「排队C」，riskLevel 为 low。"]}, ensure_ascii=False))' "$SID")" \
  | tee "$OUT/29-burst.json" >/dev/null

printf '5) 结果汇总\n'
python3 - "$OUT" "$SID" <<'PY'
import json
import os
import sys

out, sid = sys.argv[1], sys.argv[2]
files = {
    "A": os.path.join(out, "29-turn-a.json"),
    "B": os.path.join(out, "29-turn-b.json"),
    "burst": os.path.join(out, "29-burst.json"),
}
ok = True
for label, path in files.items():
    data = json.load(open(path, encoding="utf-8"))
    turns = data.get("turns") or []
    drafts = [d for t in turns for d in (t.get("drafts") or [])]
    sources = sorted({u.get("source") for u in data.get("userMessages") or [] if u.get("source")})
    print(f"{label}: session={data.get('sessionId')} turns={[t.get('turn') for t in turns]} "
          f"durationMs={data.get('durationMs')} sources={sources}")
    for draft in drafts:
        print(f"  draft[{draft.get('riskLevel')}] {draft.get('body')}")
    if label == "burst":
        accepted = data.get("acceptedAt") or []
        starts = [t.get("at") for t in data.get("turnStarts") or []]
        ends = [t.get("at") for t in turns]
        print(f"  acceptedAt={accepted}")
        print(f"  turnStarts={starts}")
        print(f"  turnEnds={ends}")
        if len(turns) != 3 or len(drafts) != 3:
            ok = False
    elif len(turns) != 1 or len(drafts) != 1:
        ok = False
    if any(t.get("reason") != "completed" for t in turns):
        ok = False

print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
