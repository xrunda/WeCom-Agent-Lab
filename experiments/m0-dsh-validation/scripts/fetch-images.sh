#!/usr/bin/env bash
#
# 下载 5 张公开授权的餐食照片，用于 #28 看图摸底。
# 图片不提交进仓库；许可与署名见 assets/sources.json。
#
# 用法：
#   ./scripts/fetch-images.sh [目标目录]
#
# 默认目标目录：./.cache/m0-images（相对于本脚本的上一级）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$SCRIPT_DIR/../.cache/m0-images}"
mkdir -p "$DEST"

# 只下载公共维基共享资源；不抓取任何用户或患者图片。
download() {
  local url="$1" name="$2"
  printf '下载 %s\n' "$name"
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
    --user-agent 'zhiban-m0-validation/0.1 (internal validation)' \
    --output "$DEST/$name" "$url"
  case "$(file --mime-type -b "$DEST/$name")" in
    image/*) ;;
    *)
      printf '错误：%s 不是图片（%s）\n' "$name" "$(file --mime-type -b "$DEST/$name")" >&2
      exit 1
      ;;
  esac
}

download \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Ramen_Bowl_2.jpg/1280px-Ramen_Bowl_2.jpg' \
  '01-ramen.jpg'
download \
  'https://upload.wikimedia.org/wikipedia/commons/8/85/Caesar-salad.jpg' \
  '02-caesar-salad.jpg'
download \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Margherita_pizza_on_plate.jpg/1280px-Margherita_pizza_on_plate.jpg' \
  '03-margherita-pizza.jpg'
download \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/6/60/Sushi_platter.jpg/1280px-Sushi_platter.jpg' \
  '04-sushi-platter.jpg'
download \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Dim_sum_steamer.jpg/1280px-Dim_sum_steamer.jpg' \
  '05-dim-sum.jpg'

# 化验单是本地生成的虚构样本，不下载真实报告。
LAB_SRC="$SCRIPT_DIR/../assets/06-lab-report-synthetic.png"
if [ -f "$LAB_SRC" ]; then
  cp "$LAB_SRC" "$DEST/06-lab-report-synthetic.png"
  printf '已复制虚构化验单：06-lab-report-synthetic.png\n'
else
  printf '提示：未找到 %s，跳过化验单\n' "$LAB_SRC" >&2
fi

cat <<EOF

完成，目录：$DEST

署名与许可：
  01-ramen.jpg              Shisma / CC BY 4.0
  02-caesar-salad.jpg       Telluride / CC BY-SA 3.0
  03-margherita-pizza.jpg   Shisma / CC BY 4.0
  04-sushi-platter.jpg      chidorian / CC BY-SA 2.0
  05-dim-sum.jpg            Alpha / CC BY-SA 2.0
  06-lab-report-synthetic.png  本地生成，虚构数据，仅用于识图测试

详细来源见 assets/sources.json。图片只用于内部验证，不提交进 git。
EOF
