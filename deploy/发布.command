#!/bin/bash
# 双击：NAS / fir / 提交到 GitHub
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "${ROOT}/mobile/scripts/_fir-shell-env.sh"
chmod +x "${ROOT}/deploy/script/release.sh" \
  "${ROOT}/deploy/script/docker-export-for-nas.sh" \
  "${ROOT}/deploy/script/docker-nas-remote-deploy.sh" \
  "${ROOT}/mobile/scripts/publish-fir.sh"
exec "${ROOT}/deploy/script/release.sh"
