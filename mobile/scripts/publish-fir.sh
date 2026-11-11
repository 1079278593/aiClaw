#!/usr/bin/env bash
# 构建 release 包并上传到 fir.im（betaqr）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${FIR_ENV_FILE:-$SCRIPT_DIR/fir.env}"

usage() {
  cat <<'EOF'
用法: scripts/publish-fir.sh [选项]

  --ios              构建并上传 iOS IPA（Adhoc/Inhouse）。本项目只有这个平台
  --android          不发布 Android：本项目不编译、不打包，直接报错退出
  --all              等同 --ios（保留参数兼容旧脚本）
  --skip-build       跳过构建，只上传已有产物（默认不再递增 build）
  --no-bump          不修改 pubspec.yaml 版本号
  --bump             与 --skip-build 联用时仍递增 build 号
  --changelog TEXT   更新说明（fir 后台显示）
  -h, --help         帮助

版本号:
  默认每次发布将 pubspec.yaml 的 version 设为「营销版本+build」：
  营销版本默认 1.0.0（或 fir.env 的 FIR_MARKETING_VERSION），build 在现有基础上 +1。
  例: 1.0.0+3 → 1.0.0+4

环境:
  配置文件 scripts/fir.env（见 fir.env.example）
  或导出 FIR_API_TOKEN

构建产物默认路径:
  build/ios/ipa/*.ipa

前置条件见 docs/release_fir.md
EOF
}

# 默认只发 iOS：用户设备只有 iOS，Android 不必上传到任何分发平台。
PLATFORM="ios"
SKIP_BUILD=0
CHANGELOG=""
DO_BUMP=1
FORCE_BUMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --android) PLATFORM="android" ;;
    --ios) PLATFORM="ios" ;;
    --all) PLATFORM="all" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-bump) DO_BUMP=0 ;;
    --bump) FORCE_BUMP=1 ;;
    --changelog)
      shift
      CHANGELOG="${1:-}"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# 平台判断先于版本计算：--android 不该先把 build 号算出来再报错。
if [[ "$PLATFORM" == "android" ]]; then
  # 本项目不做 Android：不编译、不打包、不发包。
  # 保留这个分支只为把「跑错了」直接说清楚，而不是静默什么都不做。
  echo "本项目不发布 Android（不编译、不打包）。要发 iOS 请用 --ios。" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [[ -z "${FIR_API_TOKEN:-}" ]]; then
  echo "错误: 未设置 FIR_API_TOKEN。请配置 $ENV_FILE 或 export FIR_API_TOKEN。" >&2
  exit 1
fi
export FIR_API_TOKEN

FIR_APP_NAME="${FIR_APP_NAME:-aiClaw}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.aiclaw.aiclawMobile}"
IOS_EXPORT_METHOD="${IOS_EXPORT_METHOD:-ad-hoc}"

if ! command -v flutter >/dev/null 2>&1; then
  echo "错误: 找不到 flutter，请把 Flutter SDK 加入 PATH。" >&2
  exit 1
fi

read_version() {
  local pubspec="$ROOT/pubspec.yaml"
  local line ver_name ver_code
  line="$(grep -E '^version:' "$pubspec" | head -1)"
  ver_name="${line#version:}"
  ver_name="${ver_name// /}"
  ver_name="${ver_name%%+*}"
  ver_code="${line#*+}"
  if [[ "$ver_code" == "$line" ]]; then
    ver_code="1"
  fi
  echo "$ver_name" "$ver_code"
}

version_python_next() {
  python3 - "$ROOT/pubspec.yaml" "${FIR_MARKETING_VERSION:-}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
marketing_override = sys.argv[2].strip()
text = path.read_text(encoding="utf-8")
match = re.search(r"^version:\s*(\d+\.\d+\.\d+)\+(\d+)", text, re.MULTILINE)
if match:
    name, build = match.group(1), int(match.group(2))
else:
    name, build = "1.0.0", 0
if marketing_override:
    name = marketing_override
build += 1
print(f"{name} {build}")
PY
}

write_pubspec_version() {
  local name="$1" build="$2"
  python3 - "$ROOT/pubspec.yaml" "$name" "$build" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
name, build = sys.argv[2], sys.argv[3]
new_version = f"{name}+{build}"
text = path.read_text(encoding="utf-8")
text, n = re.subn(
    r"^version:\s*.+$",
    f"version: {new_version}",
    text,
    count=1,
    flags=re.MULTILINE,
)
if n != 1:
    sys.stderr.write("无法在 pubspec.yaml 中更新 version 行\n")
    sys.exit(1)
path.write_text(text, encoding="utf-8")
PY
}

resolve_release_version() {
  local out
  if ! out="$(version_python_next 2>&1)"; then
    echo "错误: 解析 pubspec.yaml 版本失败: $out" >&2
    exit 1
  fi
  read -r APP_VERSION APP_BUILD <<< "$out"
  if [[ -z "${APP_VERSION:-}" || -z "${APP_BUILD:-}" ]]; then
    echo "错误: 无法解析版本号 (输出: $out)" >&2
    exit 1
  fi
}

should_bump() {
  if [[ "$DO_BUMP" -eq 0 ]]; then
    return 1
  fi
  if [[ "$SKIP_BUILD" -eq 1 && "$FORCE_BUMP" -eq 0 ]]; then
    return 1
  fi
  return 0
}

PENDING_BUMP=0
APP_VERSION=""
APP_BUILD=""
if should_bump; then
  resolve_release_version
  PENDING_BUMP=1
  echo "→ 本次发布版本: ${APP_VERSION}+${APP_BUILD} (上传成功后再写回 pubspec.yaml)"
else
  read -r APP_VERSION APP_BUILD <<< "$(read_version)"
  if [[ -z "${APP_VERSION:-}" || -z "${APP_BUILD:-}" ]]; then
    echo "错误: pubspec.yaml 缺少合法的 version: x.y.z+build" >&2
    exit 1
  fi
  echo "→ 使用现有版本: ${APP_VERSION}+${APP_BUILD}"
fi

flutter_build_version_args() {
  echo "--build-name=$APP_VERSION" "--build-number=$APP_BUILD"
}

upload_via_api() {
  local platform="$1"
  local bundle_id="$2"
  local file_path="$3"
  local release_type="${4:-}"

  if [[ ! -f "$file_path" ]]; then
    echo "错误: 找不到安装包 $file_path" >&2
    exit 1
  fi

  echo "→ 向 fir 申请上传凭证 ($platform, $bundle_id)..."
  local cert_json
  cert_json="$(
    python3 - <<PY
import json, os, sys, urllib.request

payload = {
    "type": "$platform",
    "bundle_id": "$bundle_id",
    "api_token": os.environ["FIR_API_TOKEN"],
}
req = urllib.request.Request(
    "http://api.appmeta.cn/apps",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        print(resp.read().decode())
except urllib.error.HTTPError as e:
    sys.stderr.write(e.read().decode() + "\n")
    sys.exit(1)
PY
  )"

  local upload_url key token
  upload_url="$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cert']['binary']['upload_url'])" <<<"$cert_json")"
  key="$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cert']['binary']['key'])" <<<"$cert_json")"
  token="$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cert']['binary']['token'])" <<<"$cert_json")"
  short="$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('short',''))" <<<"$cert_json")"

  echo "→ 上传 $(basename "$file_path") ..."
  local -a curl_args=(
    -sf
    -F "key=$key"
    -F "token=$token"
    -F "file=@$file_path"
    -F "x:name=$FIR_APP_NAME"
    -F "x:version=$APP_VERSION"
    -F "x:build=$APP_BUILD"
  )
  if [[ -n "$CHANGELOG" ]]; then
    curl_args+=(-F "x:changelog=$CHANGELOG")
  fi
  if [[ "$platform" == "ios" && -n "$release_type" ]]; then
    curl_args+=(-F "x:release_type=$release_type")
  fi

  curl "${curl_args[@]}" "$upload_url" >/dev/null
  echo "✓ 上传完成"
  if [[ -n "$short" ]]; then
    echo "  下载页（short）: https://fir.im/$short"
  fi
}

build_ios() {
  local -a ver_args
  ver_args=($(flutter_build_version_args))
  echo "→ flutter build ipa --export-method=$IOS_EXPORT_METHOD ${ver_args[*]}"
  (cd "$ROOT" && flutter pub get && flutter build ipa --export-method="$IOS_EXPORT_METHOD" "${ver_args[@]}")
}

find_ipa() {
  local ipa_dir="$ROOT/build/ios/ipa"
  local ipa
  ipa="$(find "$ipa_dir" -maxdepth 1 -name '*.ipa' 2>/dev/null | head -1)"
  if [[ -z "$ipa" ]]; then
    ipa="$(find "$ROOT/build/ios" -name '*.ipa' 2>/dev/null | head -1)"
  fi
  echo "$ipa"
}

ios_release_type() {
  case "$IOS_EXPORT_METHOD" in
    ad-hoc) echo "Adhoc" ;;
    enterprise) echo "Inhouse" ;;
    development) echo "Adhoc" ;;
    *)
      echo "错误: IOS_EXPORT_METHOD=$IOS_EXPORT_METHOD 无法用于 fir，请使用 ad-hoc 或 enterprise。" >&2
      exit 1
      ;;
  esac
}

if [[ "$PLATFORM" == "ios" || "$PLATFORM" == "all" ]]; then
  # --all 等同 --ios：Android 不在本项目范围内。
  if [[ "$PLATFORM" == "all" ]]; then
    echo "提示: 本项目不发布 Android，--all 按 --ios 处理。"
  fi
  if [[ "$SKIP_BUILD" -eq 0 ]]; then
    build_ios
  fi
  IPA="$(find_ipa)"
  upload_via_api "ios" "$IOS_BUNDLE_ID" "$IPA" "$(ios_release_type)"
fi

if [[ "$PENDING_BUMP" -eq 1 ]]; then
  write_pubspec_version "$APP_VERSION" "$APP_BUILD"
  echo "→ 已写回 pubspec.yaml: ${APP_VERSION}+${APP_BUILD}"
fi

echo "全部完成。"
