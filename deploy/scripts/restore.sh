#!/usr/bin/env bash
# #52 从备份恢复到新目录（不会覆盖正在运行的数据）。
#
# 用法：restore.sh <backup.tar.gz> <target-dir>
#   target-dir 必须不存在或为空；恢复后由运维决定是否切换 DSH_HOME。
set -euo pipefail

ARCHIVE="${1:-}"
TARGET="${2:-}"

die() { printf '恢复失败：%s\n' "$*" >&2; exit 1; }

[[ -n "$ARCHIVE" && -n "$TARGET" ]] || die "用法：restore.sh <backup.tar.gz> <target-dir>"
[[ -f "$ARCHIVE" ]] || die "备份文件不存在：$ARCHIVE"

if [[ -e "$TARGET" ]]; then
  [[ -d "$TARGET" ]] || die "目标已存在且不是目录：$TARGET"
  if [[ -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
    die "目标目录非空，拒绝覆盖：$TARGET"
  fi
fi

MANIFEST="${ARCHIVE%.tar.gz}.sha256"
if [[ -f "$MANIFEST" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$MANIFEST")") \
      || die "校验失败，备份文件可能损坏"
  else
    (cd "$(dirname "$ARCHIVE")" && shasum -a 256 -c "$(basename "$MANIFEST")") \
      || die "校验失败，备份文件可能损坏"
  fi
else
  printf '警告：未找到校验文件 %s，跳过完整性校验\n' "$MANIFEST" >&2
fi

umask 077
mkdir -p "$TARGET"
tar -xzf "$ARCHIVE" -C "$TARGET"

printf '已恢复到：%s\n' "$TARGET"
printf '顶层内容：\n'
ls -1A "$TARGET"
cat <<'EOF'

后续步骤（不要直接覆盖正在运行的数据）：
1. 停止服务：sudo systemctl stop dsh-zhiban
2. 将恢复出的 DSH_HOME 改名为正式目录，确认属主为 zhiban（0600/0750）
3. 启动：sudo systemctl start dsh-zhiban
4. 验证：curl -fsS http://127.0.0.1:3080/ >/dev/null && systemctl is-active dsh-zhiban
5. 确认数据（草稿、审计、会话、seq）后再删除旧目录
EOF
