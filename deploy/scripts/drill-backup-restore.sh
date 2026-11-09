#!/usr/bin/env bash
# #52 备份 / 恢复演练：使用临时目录与虚构文件，不接触真实数据。
# 退出码 0 表示演练通过；可在本机或服务器上运行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/zhiban-drill.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

SRC="$WORK/src/zhiban-dsh"
MEDIA="$WORK/src/zhiban-media"
BACKUP="$WORK/backups"
TARGET="$WORK/restore"

mkdir -p "$SRC/profiles/zhiban" "$SRC/storages" "$MEDIA/room_demo" "$TARGET"
printf 'name: dsh-profile-zhiban\n' > "$SRC/profiles/zhiban/package.json"
printf '{"drafts":[{"id":"draft_1","status":"VERIFIED"}]}\n' > "$SRC/storages/zhiban_wecom.json"
printf 'SQLite format 3\000fake-bytes\000' > "$SRC/storages/zhiban.sqlite"
printf 'sample-image-bytes' > "$MEDIA/room_demo/msg_1.jpg"
printf 'this log must not be backed up\n' > "$SRC/debug.log"
mkdir -p "$SRC/tmp"
printf 'transient\n' > "$SRC/tmp/scratch.bin"

export ZHIBAN_DSH_HOME="$SRC"
export ZHIBAN_MEDIA_DIR="$MEDIA"
export ZHIBAN_BACKUP_DIR="$BACKUP"

# 放一个过期文件，验证保留策略会清理
mkdir -p "$BACKUP"
printf 'old\n' > "$BACKUP/zhiban-20000101T000000Z.tar.gz"
touch -t 200001010000 "$BACKUP/zhiban-20000101T000000Z.tar.gz"

"$SCRIPT_DIR/backup.sh" >/dev/null
ARCHIVE="$(find "$BACKUP" -maxdepth 1 -name 'zhiban-*.tar.gz' ! -name 'zhiban-2000*' | head -n 1)"
[[ -n "$ARCHIVE" ]] || { echo "未生成备份文件" >&2; exit 1; }
[[ ! -e "$BACKUP/zhiban-20000101T000000Z.tar.gz" ]] || { echo "过期备份未被清理" >&2; exit 1; }

"$SCRIPT_DIR/restore.sh" "$ARCHIVE" "$TARGET" >/dev/null

RESTORED_DSH="$TARGET/$(basename "$SRC")"
RESTORED_MEDIA="$TARGET/$(basename "$MEDIA")"

diff -r "$SRC/profiles" "$RESTORED_DSH/profiles" >/dev/null || {
  echo "profile 恢复内容不一致" >&2
  diff -r "$SRC/profiles" "$RESTORED_DSH/profiles" >&2 || true
  exit 1
}
diff -r "$SRC/storages" "$RESTORED_DSH/storages" >/dev/null || {
  echo "领域存储恢复内容不一致" >&2
  diff -r "$SRC/storages" "$RESTORED_DSH/storages" >&2 || true
  exit 1
}
[[ -f "$RESTORED_MEDIA/room_demo/msg_1.jpg" ]] || { echo "媒体文件未恢复" >&2; exit 1; }
[[ ! -e "$RESTORED_DSH/debug.log" ]] || { echo "日志文件不应进入备份" >&2; exit 1; }
[[ ! -e "$RESTORED_DSH/tmp/scratch.bin" ]] || { echo "临时目录不应进入备份" >&2; exit 1; }

printf 'RESULT: PASS 备份与恢复演练通过（%s）\n' "$(basename "$ARCHIVE")"
