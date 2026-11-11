#!/bin/bash
# 双击运行：发布 iOS 到 fir（build 号自动 +1）
#
# 本项目只有 iOS。Android 不编译、不打包、不发包，菜单里不留对应项。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/_fir-shell-env.sh"

cd "$DIR/.."

echo "======================================"
echo "  aiClaw 发布到 fir.im（iOS）"
echo "======================================"
echo ""
echo "  1) 构建并发布（build 号自动 +1，默认）"
echo "  2) 只上传已有 IPA（不构建、不递增版本）"
echo "  0) 取消"
echo ""
read -r -p "请选择 [1-2，默认 1]: " choice
choice="${choice:-1}"

case "$choice" in
  1) ARGS=(--ios) ;;
  2) ARGS=(--ios --skip-build --no-bump) ;;
  0)
    echo "已取消"
    exit 0
    ;;
  *)
    echo "无效选项，已取消"
    exit 1
    ;;
esac

echo ""
read -r -p "更新说明（可留空）: " changelog
if [[ -n "$changelog" ]]; then
  ARGS+=(--changelog "$changelog")
fi

echo ""
set +e
"$DIR/publish-fir.sh" "${ARGS[@]}"
code=$?
set -e
echo ""
read -r -p "按回车键关闭窗口…" _
exit "$code"
