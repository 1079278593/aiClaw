#!/usr/bin/env bash
# 发布菜单：NAS、fir（仅 iOS）、提交并推到 GitHub。
#
#   ./deploy/script/release.sh            交互选择，直接回车等于全部
#   ./deploy/script/release.sh 1          全部
#   ./deploy/script/release.sh --nas      进入 NAS 菜单：快速发版，或只导出 tar
#   ./deploy/script/release.sh --fir
#   ./deploy/script/release.sh --git
#
# 全部的顺序：先提交已有改动，再构建镜像（网页上的提交号就是这次提交），
# 然后 NAS、fir。发版号和 App 构建号是打包时才写回的，最后再提交一次并推送。
# 这台 Mac 没有 Android SDK，fir 只发 iOS。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# shellcheck source=/dev/null
source "${ROOT}/mobile/scripts/_fir-shell-env.sh"

fail() {
  echo "[release] ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法: ./deploy/script/release.sh [1|--all|2|--nas|3|--fir|4|--git]

  1  全部：提交、NAS、fir（iOS）、再提交发版号并推到 GitHub（默认）
  2  NAS：再选「快速发版」或「只导出 tar」
  3  只发布到 fir（iOS）
  4  只提交并推到 GitHub
EOF
}

apply_github_proxy() {
  local enabled host port
  enabled="$(scutil --proxy 2>/dev/null | awk '/HTTPSEnable/{print $3; exit}')"
  host="$(scutil --proxy 2>/dev/null | awk '/HTTPSProxy /{print $3; exit}')"
  port="$(scutil --proxy 2>/dev/null | awk '/HTTPSPort /{print $3; exit}')"
  if [[ "$enabled" == "1" && -n "$host" && -n "$port" ]]; then
    export https_proxy="http://${host}:${port}"
    export http_proxy="$https_proxy"
    export HTTPS_PROXY="$https_proxy"
    export HTTP_PROXY="$https_proxy"
    echo "[release] GitHub 走系统代理 ${https_proxy}"
  fi
}

dirty() {
  [[ -n "$(git status --porcelain)" ]]
}

ask_message() {
  local message
  read -r -p "提交说明: " message
  [[ -n "$message" ]] || fail "提交说明不能为空"
  printf '%s' "$message"
}

commit_with() {
  local message="$1"
  if ! dirty; then
    echo "[release] 没有需要提交的改动。"
    return 0
  fi
  git add -A
  git commit -m "$message"
}

push_github() {
  apply_github_proxy
  command -v gh >/dev/null 2>&1 || fail "未找到 gh，无法向 GitHub 认证"
  local -a cmd=(git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push)
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    cmd+=(-u aiClaw HEAD)
  fi
  GIT_TERMINAL_PROMPT=0 "${cmd[@]}"
}

publish_nas() {
  echo "[release] 发布到 NAS…"
  "${ROOT}/deploy/script/docker-export-for-nas.sh" --quick
}

publish_nas_menu() {
  echo "[release] NAS：1 快速发版，2 只导出 tar"
  "${ROOT}/deploy/script/docker-export-for-nas.sh"
}

publish_fir() {
  local changelog="${1:-更新}"
  echo "[release] 发布到 fir（仅 iOS）…"
  (
    cd "${ROOT}/mobile"
    ./scripts/publish-fir.sh --ios --changelog "$changelog"
  )
}

commit_and_push() {
  local message="$1"
  commit_with "$message"
  echo "[release] 推到 GitHub…"
  push_github
}

run_all() {
  local message=""
  if dirty; then
    message="$(ask_message)"
    commit_with "$message"
  else
    echo "[release] 工作区是干净的，先发版，再提交发版号。"
    message="发版"
  fi
  publish_nas
  publish_fir "$message"
  if dirty; then
    local build app
    build="$(tr -d '[:space:]' < "${ROOT}/deploy/build.number")"
    app="$(awk '/^version:/{print $2; exit}' "${ROOT}/mobile/pubspec.yaml")"
    commit_with "记录发版：服务 ${build}，App ${app}"
  fi
  echo "[release] 推到 GitHub…"
  push_github
}

choice="${1:-}"
case "$choice" in
  -h|--help) usage; exit 0 ;;
esac

if [[ -z "$choice" ]]; then
  echo "1) 全部：NAS、fir（iOS）、提交并推到 GitHub"
  echo "2) NAS：快速发版，或只导出 tar"
  echo "3) 只发布到 fir（iOS）"
  echo "4) 只提交并推到 GitHub"
  echo "0) 取消"
  read -r -p "请选择 [1-4，默认 1]: " choice
  choice="${choice:-1}"
fi

case "$choice" in
  1|--all) run_all ;;
  2|--nas) publish_nas_menu ;;
  3|--fir) publish_fir "更新" ;;
  4|--git)
    if dirty; then
      commit_and_push "$(ask_message)"
    else
      echo "[release] 没有需要提交的改动，只推送已有提交。"
      push_github
    fi
    ;;
  0) echo "[release] 已取消"; exit 0 ;;
  *) fail "无效选择: $choice" ;;
esac

echo "[release] 完成。"
