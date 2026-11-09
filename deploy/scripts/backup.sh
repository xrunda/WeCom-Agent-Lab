#!/usr/bin/env bash
# #52 每日备份：DSH_HOME（含领域存储/会话/凭据）与企微存档媒体。
#
# 备份文件包含凭据与患者数据，目录必须仅 root 可读（本脚本会设置 0700/0600）。
# 可用环境变量覆盖路径，便于服务器与本地演练：
#   ZHIBAN_DSH_HOME            默认 /var/lib/zhiban/dsh
#   ZHIBAN_MEDIA_DIR           默认 $ZHIBAN_DSH_HOME/zhiban/media
#   ZHIBAN_BACKUP_DIR          默认 /var/backups/zhiban
#   ZHIBAN_BACKUP_RETENTION_DAYS 默认 14
set -euo pipefail

DSH_HOME="${ZHIBAN_DSH_HOME:-/var/lib/zhiban/dsh}"
MEDIA_DIR="${ZHIBAN_MEDIA_DIR:-$DSH_HOME/zhiban/media}"
BACKUP_DIR="${ZHIBAN_BACKUP_DIR:-/var/backups/zhiban}"
RETENTION_DAYS="${ZHIBAN_BACKUP_RETENTION_DAYS:-14}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '备份失败：%s\n' "$*" >&2; exit 1; }

[[ -d "$DSH_HOME" ]] || die "DSH_HOME 不存在：$DSH_HOME"
case "$BACKUP_DIR/" in
  "$DSH_HOME"/*) die "BACKUP_DIR 不能位于 DSH_HOME 内，避免备份被再次打包" ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="zhiban-$STAMP"
ARCHIVE="$BACKUP_DIR/$BASE.tar.gz"
PARTIAL="$ARCHIVE.partial"
MANIFEST="$BACKUP_DIR/$BASE.sha256"

cleanup() { rm -f "$PARTIAL"; }
trap cleanup EXIT

TAR_ARGS=(--exclude='*.log' --exclude='tmp/*' --exclude='node_modules/*' --exclude='*.partial')
TAR_PATHS=(-C "$(dirname "$DSH_HOME")" "$(basename "$DSH_HOME")")
if [[ -d "$MEDIA_DIR" && "$MEDIA_DIR" != "$DSH_HOME" && "$MEDIA_DIR" != "$DSH_HOME"/* ]]; then
  log "追加媒体目录 MEDIA_DIR=$MEDIA_DIR"
  TAR_PATHS+=(-C "$(dirname "$MEDIA_DIR")" "$(basename "$MEDIA_DIR")")
fi

log "开始备份 DSH_HOME=$DSH_HOME"
tar -czf "$PARTIAL" "${TAR_ARGS[@]}" "${TAR_PATHS[@]}"

mv "$PARTIAL" "$ARCHIVE"
chmod 600 "$ARCHIVE"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && sha256sum "$BASE.tar.gz" > "$BASE.sha256")
else
  (cd "$BACKUP_DIR" && shasum -a 256 "$BASE.tar.gz" > "$BASE.sha256")
fi
chmod 600 "$MANIFEST"

# 保留最近 N 天（按修改时间清理，至少保留 14 天）
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'zhiban-*.tar.gz' -o -name 'zhiban-*.sha256' \) \
  -mtime +"$RETENTION_DAYS" -delete

SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
log "备份完成：${ARCHIVE}（${SIZE} 字节），校验文件：${MANIFEST}"
log "保留策略：最近 ${RETENTION_DAYS} 天；请另行同步到异机/对象存储（见 docs/P1-deploy.md）"
