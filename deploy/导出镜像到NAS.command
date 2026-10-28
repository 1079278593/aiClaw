#!/bin/bash
# 双击：1 快速发版 | 2 完整选项
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -x "${ROOT}/deploy/script/docker-export-for-nas.sh" ]]; then
  chmod +x "${ROOT}/deploy/script/docker-export-for-nas.sh" "${ROOT}/deploy/script/docker-nas-remote-deploy.sh"
fi

exec "${ROOT}/deploy/script/docker-export-for-nas.sh"
