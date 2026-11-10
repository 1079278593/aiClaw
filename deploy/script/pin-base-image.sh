#!/usr/bin/env bash
# 把 node 基础镜像固化到本机，让后续发版不再依赖外网镜像源。
#
# 为什么需要：免费镜像源（docker.1ms.run / daocloud 等）会随政策随时失效，
# 每次构建都要联网拉 `node:22-bookworm-slim`，网络一抖发版就失败。
# 固化之后 `docker build` 的 `FROM` 指向本地 tag，`load metadata` 0 秒完成，
# 完全不访问任何 registry。
#
# 用法：
#   ./deploy/script/pin-base-image.sh                     自动挑一个可用源并固化
#   ./deploy/script/pin-base-image.sh <registry/image>    指定源
#   ./deploy/script/pin-base-image.sh --list              只检查各源可用性，不固化
#
# 固化产物：aiclaw/base-node:22-bookworm-slim（platform=linux/amd64，与 NAS 一致）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_TAG="22-bookworm-slim"
LOCAL_IMAGE="aiclaw/base-node:${BASE_TAG}"
PLATFORM="linux/amd64"

# 候选源，按历史上更稳的顺序。第一个能拉通的会被固化。
CANDIDATES=(
  "${AICLAW_NODE_IMAGE:-}"
  "docker.m.daocloud.io/library/node:${BASE_TAG}"
  "docker.1ms.run/library/node:${BASE_TAG}"
  "node:${BASE_TAG}"
)

fail() { echo "[pin] ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "未找到 docker。请先打开 Docker Desktop。"
docker info >/dev/null 2>&1 || fail "Docker 未运行。"

# 用 buildx 探测某个镜像能否解析。只看 metadata，不真正拉全部层。
probe() {
  local image="$1"
  local df
  df="$(mktemp)"
  printf 'FROM %s\n' "$image" >"$df"
  # 不复用缓存，否则「之前拉过」会被误判成「现在还能拉」。
  if docker buildx build --platform "$PLATFORM" -f "$df" --load \
      -t "aiclaw/probe-$$:tmp" "$ROOT" >/dev/null 2>&1; then
    rm -f "$df"
    docker rmi "aiclaw/probe-$$:tmp" >/dev/null 2>&1 || true
    return 0
  fi
  rm -f "$df"
  return 1
}

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
  echo "[pin] 当前可用性（platform=${PLATFORM}）："
  for img in "${CANDIDATES[@]}"; do
    [[ -n "$img" ]] || continue
    if probe "$img"; then echo "  OK    $img"; else echo "  FAIL  $img"; fi
  done
  exit 0
fi

target="${1:-}"
if [[ -z "$target" ]]; then
  echo "[pin] 自动挑选可用源…"
  for img in "${CANDIDATES[@]}"; do
    [[ -n "$img" ]] || continue
    echo -n "[pin] 试 $img … "
    if probe "$img"; then
      echo "可用"
      target="$img"
      break
    fi
    echo "不可用"
  done
  [[ -n "$target" ]] || fail "所有候选源都不可用。检查网络，或用参数显式指定一个源。"
else
  echo -n "[pin] 校验 $target … "
  probe "$target" || fail "$target 当前不可用"
  echo "可用"
fi

echo "[pin] 固化 ${target} → ${LOCAL_IMAGE} (${PLATFORM})"
df="$(mktemp)"
printf 'FROM %s\n' "$target" >"$df"
docker buildx build --platform "$PLATFORM" -f "$df" --load -t "$LOCAL_IMAGE" "$ROOT"
rm -f "$df"

echo ""
docker images "$LOCAL_IMAGE" --format "[pin] 完成: {{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}"
echo "[pin] 之后 ${ROOT}/deploy/script/docker-export-for-nas.sh 会自动优先使用它，不再联网。"
