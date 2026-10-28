#!/usr/bin/env bash
# Mac 双击请运行：deploy/导出镜像到NAS.command
# 只构建服务端镜像。不拷贝 .env，不拷贝用户数据，不把手机端打进镜像。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NAS_ENV="${ROOT}/deploy/nas.env"
if [[ -f "$NAS_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$NAS_ENV"
  set +a
fi

IMAGE_NAME="${AICLAW_EXPORT_IMAGE:-aiclaw:local}"
DEFAULT_OUTPUT="${ROOT}/deploy/aiclaw-local.tar"
NAS_EXPORT_DIR="/Volumes/docker/aiclaw"
NAS_EXPORT_OUTPUT="${NAS_EXPORT_DIR}/aiclaw-local.tar"
NODE_IMAGE_CN="${AICLAW_NODE_IMAGE:-docker.1ms.run/library/node:22-bookworm-slim}"
NPM_REGISTRY="${AICLAW_NPM_REGISTRY:-https://registry.npmmirror.com}"
BUILD_NUMBER_FILE="${ROOT}/deploy/build.number"
REMOTE_DEPLOY="${ROOT}/deploy/script/docker-nas-remote-deploy.sh"
NAS_SSH_DEFAULT="${NAS_SSH:-user@192.168.1.100}"
NAS_PROJECT_DIR_DEFAULT="${NAS_PROJECT_DIR:-/path/to/docker/aiclaw}"

INTERACTIVE=1
QUICK=0
NO_CACHE=0
PLATFORM=""
OUTPUT="$DEFAULT_OUTPUT"
USE_CN_MIRRORS=1
DEPLOY_NAS=0
EXPLICIT_NO_DEPLOY=0

usage() {
  cat <<EOF
用法:
  ./deploy/script/docker-export-for-nas.sh              交互：1 快速发版 | 2 完整选项
  ./deploy/script/docker-export-for-nas.sh --quick      快速发版

快速发版：国内源、linux/amd64、使用缓存、tar 写到 ${NAS_EXPORT_DIR}、SSH 重启 NAS。
需要 NAS 已挂载，并且 SSH 能执行 docker。完整选项只构建和导出，不自动发布。
EOF
}

fail() {
  echo "[export] ERROR: $*" >&2
  exit 1
}

prompt_choice() {
  local prompt="$1" default="$2" reply=""
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    echo "$default"
    return
  fi
  read -r -p "${prompt} [${default}]: " reply
  if [[ -z "$reply" ]]; then echo "$default"; else echo "$reply"; fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick|-q|-y|--yes) INTERACTIVE=0; QUICK=1; shift ;;
    --no-deploy) EXPLICIT_NO_DEPLOY=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    -o|--output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "未找到 docker。请先打开 Docker Desktop，它只用来构建镜像。"
docker info >/dev/null 2>&1 || fail "Docker 未运行。"

if [[ "$QUICK" -eq 1 ]]; then
  USE_CN_MIRRORS=1
  NO_CACHE=0
  [[ "$EXPLICIT_NO_DEPLOY" -eq 1 ]] || DEPLOY_NAS=1
  [[ -n "$PLATFORM" ]] || PLATFORM="linux/amd64"
  if [[ "$OUTPUT" == "$DEFAULT_OUTPUT" ]]; then
    [[ -d "$NAS_EXPORT_DIR" ]] || fail "快速发版需要 NAS 挂载目录: ${NAS_EXPORT_DIR}"
    OUTPUT="$NAS_EXPORT_OUTPUT"
  fi
else
  echo ""
  echo "=== aiClaw：Mac 构建 → NAS ==="
  echo "1 = 快速发版（amd64、国内源、导出到 NAS 并 SSH 发布）"
  echo "2 = 完整选项（导出 tar，之后用绿联 GUI 导入）"
  case "$(prompt_choice "请选择 1/2" "2")" in
    1)
      QUICK=1
      USE_CN_MIRRORS=1
      PLATFORM="linux/amd64"
      [[ -d "$NAS_EXPORT_DIR" ]] || fail "快速发版需要 NAS 挂载目录: ${NAS_EXPORT_DIR}"
      OUTPUT="$NAS_EXPORT_OUTPUT"
      DEPLOY_NAS=1
      ;;
    2)
      echo "1 = linux/amd64（绿联 x86，推荐）"
      echo "2 = 本机架构"
      case "$(prompt_choice "架构" "1")" in
        1) PLATFORM="linux/amd64" ;;
        2) PLATFORM="" ;;
        *) fail "无效架构" ;;
      esac
      echo "1 = ${DEFAULT_OUTPUT}"
      echo "2 = ${NAS_EXPORT_OUTPUT}"
      case "$(prompt_choice "导出位置" "1")" in
        1) OUTPUT="$DEFAULT_OUTPUT" ;;
        2)
          [[ -d "$NAS_EXPORT_DIR" ]] || fail "目录不存在: ${NAS_EXPORT_DIR}"
          OUTPUT="$NAS_EXPORT_OUTPUT"
          ;;
        *) fail "无效导出位置" ;;
      esac
      ;;
    *) fail "请输入 1 或 2" ;;
  esac
fi

n=0
[[ -f "$BUILD_NUMBER_FILE" ]] && n="$(<"$BUILD_NUMBER_FILE")"
n=$((n + 1))
echo "$n" >"$BUILD_NUMBER_FILE"
commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo no-git)"
echo "[export] build=${n} commit=${commit} image=${IMAGE_NAME} platform=${PLATFORM:-native}"

base_image="node:22-bookworm-slim"
if [[ "$USE_CN_MIRRORS" -eq 1 ]]; then
  base_image="$NODE_IMAGE_CN"
fi

cmd=(docker build --build-arg "NODE_IMAGE=${base_image}" --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" -t "$IMAGE_NAME" -f "${ROOT}/server/Dockerfile")
if [[ -n "$PLATFORM" ]]; then
  cmd+=(--platform "$PLATFORM")
fi
if [[ "$NO_CACHE" -eq 1 ]]; then
  cmd+=(--no-cache)
fi
cmd+=("${ROOT}/server")

echo "[export] 构建 ${base_image} …"
"${cmd[@]}"

mkdir -p "$(dirname "$OUTPUT")"
echo "[export] 导出 ${OUTPUT}"
docker save -o "$OUTPUT" "$IMAGE_NAME"
ls -lh "$OUTPUT"

if [[ "$DEPLOY_NAS" -eq 1 ]]; then
  nas_tar="${NAS_PROJECT_DIR_DEFAULT}/$(basename "$OUTPUT")"
  NAS_SSH="$NAS_SSH_DEFAULT" NAS_PROJECT_DIR="$NAS_PROJECT_DIR_DEFAULT" \
    "$REMOTE_DEPLOY" "$nas_tar"
else
  echo "[export] 未自动发布。把 tar 导入绿联，再用 docker-compose-aiclaw.yml 部署。见 deploy/部署文档.md"
fi
