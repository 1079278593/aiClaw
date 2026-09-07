#!/bin/bash
cd "$(dirname "$0")" || exit 1

PNPM_VERSION="10.23.0"
OPEN_URL="http://127.0.0.1:3000"
DEFAULT_DATA_DIR="$HOME/aiclaw-data"

echo "========================================"
echo "  aiClaw"
echo "========================================"
echo

pause_exit() {
  echo
  read -r -p "按回车键退出..."
  exit "${1:-1}"
}

load_node_env() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # Finder 双击不会加载 ~/.zshrc，需要手动载入 nvm
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
  if [ -d /opt/homebrew/bin ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  fi
  if [ -d /usr/local/bin ]; then
    export PATH="/usr/local/bin:$PATH"
  fi
}

node_version_ok() {
  local ver major minor
  ver="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  [ -n "$major" ] && [ -n "$minor" ] || return 1
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 16 ]; }
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 未找到 Node.js。"
    echo "请安装 Node.js 22.16.0 或更高版本：https://nodejs.org/"
    pause_exit 1
  fi
  if ! node_version_ok; then
    echo "[错误] Node.js 版本过低，当前 $(node -v)，需要 >= 22.16.0。"
    pause_exit 1
  fi
  echo "Node.js $(node -v)"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm $(pnpm -v)"
    return 0
  fi

  # Node 自带 corepack，pnpm 往往已经在里面，只是还没放到 PATH
  if command -v corepack >/dev/null 2>&1 && corepack pnpm -v >/dev/null 2>&1; then
    echo "检测到 Node.js/corepack 中的 pnpm $(corepack pnpm -v)，正在启用到 PATH ..."
    corepack enable || true
    if ! corepack prepare "pnpm@${PNPM_VERSION}" --activate; then
      echo "[错误] 启用 corepack pnpm 失败。"
      pause_exit 1
    fi
  else
    echo "未找到 pnpm，正在安装 pnpm@${PNPM_VERSION} ..."
    if command -v corepack >/dev/null 2>&1; then
      corepack enable || true
      if ! corepack prepare "pnpm@${PNPM_VERSION}" --activate; then
        echo "[错误] 通过 corepack 安装 pnpm 失败。"
        pause_exit 1
      fi
    elif ! npm install -g "pnpm@${PNPM_VERSION}"; then
      echo "[错误] 通过 npm 安装 pnpm 失败。"
      pause_exit 1
    fi
  fi
  hash -r
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[错误] pnpm 安装后仍不可用，请重新打开终端后再试。"
    pause_exit 1
  fi
  echo "pnpm $(pnpm -v)"
}

write_data_dir() {
  local dir="$1"
  local tmp
  tmp="$(mktemp)"
  if [ -f .env ] && grep -qE '^[[:space:]]*HYXCLAW_DATA_DIR=' .env; then
    awk -v dir="$dir" '
      /^[[:space:]]*HYXCLAW_DATA_DIR=/ { print "HYXCLAW_DATA_DIR=" dir; next }
      { print }
    ' .env > "$tmp"
    mv "$tmp" .env
  else
    {
      [ -f .env ] && cat .env
      printf 'HYXCLAW_DATA_DIR=%s\n' "$dir"
    } > "$tmp"
    mv "$tmp" .env
  fi
}

expand_path() {
  local data_dir="$1"
  case "$data_dir" in
    "~") data_dir="$HOME" ;;
    "~/"*) data_dir="$HOME/${data_dir#~/}" ;;
  esac
  printf '%s' "$data_dir"
}

ensure_env() {
  local first_setup=0
  if [ ! -f .env ]; then
    first_setup=1
    echo
    echo "未找到 .env，正在从 .env.example 复制一份到项目根目录。"
    if [ -f .env.example ]; then
      cp .env.example .env
    else
      printf 'HYXCLAW_DATA_DIR=%s\n' "$DEFAULT_DATA_DIR" > .env
    fi
  fi

  if [ "$first_setup" -eq 0 ]; then
    echo "数据目录：$(read_data_dir)"
    echo "路径记录在 $(pwd)/.env"
    return 0
  fi

  echo
  echo "数据目录用来放知识库、会话和 config.json。"
  echo "这个路径会写入项目根目录的 .env（HYXCLAW_DATA_DIR），不是让你重复填写已有配置。"
  echo "直接回车使用默认目录；若你已经有数据文件夹，再粘贴那个路径。"
  printf "数据目录 [%s]: " "$DEFAULT_DATA_DIR"
  read -r data_dir
  data_dir="$(expand_path "${data_dir:-$DEFAULT_DATA_DIR}")"

  if ! mkdir -p "$data_dir"; then
    echo "[错误] 无法创建目录：$data_dir"
    pause_exit 1
  fi
  write_data_dir "$data_dir"
  echo "已写入 $(pwd)/.env"
  echo "  HYXCLAW_DATA_DIR=$data_dir"
}

read_data_dir() {
  local line
  line="$(grep -E '^[[:space:]]*HYXCLAW_DATA_DIR=' .env | tail -1 | tr -d '\r')"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

ensure_deps() {
  local need_install=0
  if [ ! -d node_modules ]; then
    need_install=1
  elif [ package.json -nt node_modules ]; then
    need_install=1
  elif [ -f pnpm-lock.yaml ] && [ pnpm-lock.yaml -nt node_modules ]; then
    need_install=1
  fi

  if [ "$need_install" -eq 0 ]; then
    echo "依赖已就绪"
    return 0
  fi

  echo "正在安装依赖 (pnpm install) ..."
  if ! pnpm install; then
    echo "[错误] pnpm install 失败。"
    pause_exit 1
  fi
}

ensure_build() {
  local need_build=0
  if [ ! -f dist/cli/index.js ]; then
    need_build=1
  elif find src -name '*.ts' -newer dist/cli/index.js -print -quit 2>/dev/null | grep -q .; then
    need_build=1
  fi

  if [ "$need_build" -eq 0 ]; then
    echo "编译产物已就绪"
    return 0
  fi

  echo "正在构建 (pnpm build) ..."
  if ! pnpm build; then
    echo "[错误] 构建失败。"
    pause_exit 1
  fi
}

ensure_init() {
  local data_dir
  data_dir="$(read_data_dir)"
  if [ -z "$data_dir" ]; then
    echo "[错误] .env 中未设置 HYXCLAW_DATA_DIR。"
    pause_exit 1
  fi
  if [ -f "$data_dir/config.json" ]; then
    echo "数据目录：$data_dir"
    return 0
  fi

  echo "数据目录尚未初始化，正在执行 init ..."
  if ! node dist/cli/index.js init; then
    echo "[错误] 初始化失败。"
    pause_exit 1
  fi
  echo
  echo "请编辑以下文件，填入默认模型提供商的 API Key，然后重新双击本脚本："
  echo "  $data_dir/config.json"
  pause_exit 0
}

load_node_env
ensure_node
ensure_pnpm
ensure_env
ensure_deps
ensure_build
ensure_init

echo
echo "启动后将打开 ${OPEN_URL}"
echo "关闭本窗口或按 Ctrl+C 可停止服务。"
echo

(sleep 2 && open "${OPEN_URL}") &
node dist/cli/index.js start
exit_code=$?

echo
if [ "$exit_code" -ne 0 ]; then
  echo "服务已退出，退出码：${exit_code}"
  echo "若提示未设置 API Key，请编辑数据目录中的 config.json 后重试。"
fi
read -r -p "按回车键退出..."
exit "$exit_code"
