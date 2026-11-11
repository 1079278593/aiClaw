# 供 .command 双击脚本加载（Terminal 默认不读 .zshrc）
export PATH="$HOME/development/flutter/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -f "$HOME/.zprofile" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.zprofile"
fi
export PUB_HOSTED_URL="${PUB_HOSTED_URL:-https://pub.flutter-io.cn}"
export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"

# 缓解 flutter 构建时 git fetch 的 HTTP/2 错误（国内网络常见）
export GIT_HTTP_VERSION=1.1
