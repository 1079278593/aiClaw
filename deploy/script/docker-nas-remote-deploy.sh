#!/usr/bin/env bash
# 镜像已经在 Mac 构建好之后，用 SSH 载入 NAS 并重启 aiclaw。
# 首次仍要在绿联 GUI 里创建过项目。本脚本不创建数据目录里的用户。
#
#   推荐：cp deploy/nas.env.example deploy/nas.env 后填写 NAS_SSH、NAS_PROJECT_DIR
#
#   ./deploy/script/docker-nas-remote-deploy.sh
#   ./deploy/script/docker-nas-remote-deploy.sh /Volumes/docker/aiclaw/aiclaw-local.tar
#   ./deploy/script/docker-nas-remote-deploy.sh check
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAS_ENV="${ROOT}/deploy/nas.env"
if [[ -f "$NAS_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$NAS_ENV"
  set +a
fi

IMAGE="${AICLAW_EXPORT_IMAGE:-aiclaw:local}"
NAS_SSH="${NAS_SSH:-}"
NAS_SSH_PORT="${NAS_SSH_PORT:-22}"
NAS_PROJECT_DIR="${NAS_PROJECT_DIR:-}"
NAS_TAR="${NAS_TAR:-}"

fail() {
  echo "[nas-deploy] ERROR: $*" >&2
  exit 1
}

ssh_nas() {
  ssh -p "$NAS_SSH_PORT" -o ConnectTimeout=10 "$NAS_SSH" "$@"
}

usage() {
  cat <<'EOF'
用法:
  ./deploy/script/docker-nas-remote-deploy.sh
  ./deploy/script/docker-nas-remote-deploy.sh /path/to/aiclaw-local.tar
  ./deploy/script/docker-nas-remote-deploy.sh check

也可在命令前设置 NAS_SSH、NAS_PROJECT_DIR，或写入 deploy/nas.env（见 nas.env.example）。

不指定 tar：Mac 上 docker save 直接管道到 NAS 的 docker load。
指定 tar：在 NAS 上 docker load -i。
加载后在项目目录执行 docker compose up -d --force-recreate aiclaw。
EOF
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage && exit 0

MODE="deploy"
TAR=""
if [[ "${1:-}" == "check" ]]; then
  MODE="check"
elif [[ -n "${1:-}" ]]; then
  TAR="$1"
fi
TAR="${TAR:-$NAS_TAR}"

[[ -n "$NAS_SSH" ]] || fail "请设置 NAS_SSH（deploy/nas.env 或环境变量），见 deploy/nas.env.example"
[[ -n "$NAS_PROJECT_DIR" ]] || fail "请设置 NAS_PROJECT_DIR（deploy/nas.env 或环境变量），见 deploy/nas.env.example"

echo "[nas-deploy] 检查 SSH（${NAS_SSH} -p ${NAS_SSH_PORT}）…"
ssh_nas "echo '[nas-deploy] SSH OK'"
ssh_nas "command -v docker >/dev/null && docker version --format 'docker {{.Server.Version}}'"
ssh_nas "test -f '${NAS_PROJECT_DIR}/aiclaw.env' && test -f '${NAS_PROJECT_DIR}/docker-compose-aiclaw.yml'"

if [[ "$MODE" == "check" ]]; then
  echo "[nas-deploy] 检查通过，未加载镜像。"
  exit 0
fi

if [[ -n "$TAR" ]]; then
  [[ -f "$TAR" ]] || fail "找不到 tar: ${TAR}"
  echo "[nas-deploy] 在 NAS 上加载 ${TAR}…"
  ssh_nas "docker load -i $(printf '%q' "$TAR")"
else
  echo "[nas-deploy] docker save | ssh docker load …"
  docker save "$IMAGE" | ssh_nas "docker load"
fi

echo "[nas-deploy] 重启 aiclaw…"
ssh_nas "cd $(printf '%q' "$NAS_PROJECT_DIR") && docker compose -f docker-compose-aiclaw.yml up -d --force-recreate aiclaw"
echo "[nas-deploy] 完成。在 NAS 上验收: curl -s http://127.0.0.1:3010/health"
