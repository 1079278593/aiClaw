#!/usr/bin/env bash
# 给每个租户的 config.json 补上 appUpdate 段（一次性迁移），然后重启 aiclaw 容器。
#
# 为什么需要这个脚本：config.json 的初始化策略是 `once`
# （server/src/config/init-strategies.ts），只在文件不存在时从模板复制。
# 已存在的租户配置**永远不会**被新版本自动补字段，所以必须显式加一次。
#
# 安全性：
# - 只有缺失时才插入，已存在则原样跳过，重复执行无副作用。
# - 先备份成 config.json.bak-<时间戳>，JSON 校验失败就自动还原。
# - 不重启容器，先 dry-run 看 diff；确认后带 --apply 才写入并重启。
#
# 用法：
#   ./deploy/script/add-app-update-field.sh            # 预览（不改任何文件）
#   ./deploy/script/add-app-update-field.sh --apply    # 写入并重启
#   ./deploy/script/add-app-update-field.sh --apply --token <FIR_API_TOKEN>  # 同时填好 token
#   FIR_API_TOKEN=xxx ./deploy/script/add-app-update-field.sh --apply --enable   # 也可用环境变量
#
# 在 NAS 上执行需要 NAS 有 node（实测 v18 可用）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-deploy/script/add-app-update-field.sh}")/../.." 2>/dev/null && pwd || echo "$PWD")"
APPLY=0
FIR_TOKEN="${FIR_API_TOKEN:-}"
FIR_BASE="https://api.bq04.com"
IOS_BUNDLE="com.aiclaw.aiclawMobile"
ANDROID_BUNDLE="com.aiclaw.aiclaw_mobile"
ENABLED="false"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || echo "见脚本头部注释。"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --token) FIR_TOKEN="${2:-}"; shift 2 ;;
    --enable) ENABLED="true"; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# 数据目录：优先用显式路径，其次 AICLAW_DATA_DIR，最后按 compose 的约定猜。
DATA_DIR="${AICLAW_DATA_DIR:-${1:-}}"
if [[ -z "$DATA_DIR" ]]; then
  if [[ -n "${NAS_PROJECT_DIR:-}" && -d "${NAS_PROJECT_DIR}/data" ]]; then
    DATA_DIR="${NAS_PROJECT_DIR}/data"
  elif [[ -d /volume1/docker/aiclaw/data ]]; then
    DATA_DIR=/volume1/docker/aiclaw/data
  else
    echo "找不到数据目录。请设置 AICLAW_DATA_DIR，或作为第一个参数传入。" >&2
    exit 1
  fi
fi

echo "数据目录: $DATA_DIR"
if [[ ! -d "$DATA_DIR/tenants" ]]; then
  echo "没有 $DATA_DIR/tenants/ —— 这是老安装，配置在 $DATA_DIR/config.json。"
  echo "请手动检查该文件，本脚本只处理租户目录。" >&2
  exit 1
fi

# 用 while-read 而不是 mapfile：macOS 自带 bash 3.2 没有 mapfile。
CONFIGS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && CONFIGS+=("$line")
done < <(find "$DATA_DIR/tenants" -maxdepth 2 -name config.json -type f | sort)
if [[ ${#CONFIGS[@]} -eq 0 ]]; then
  echo "tenants/ 下没有找到 config.json。" >&2
  exit 1
fi

echo "找到 ${#CONFIGS[@]} 个租户配置。"
[[ $APPLY -eq 1 ]] || echo "（预览模式，不会修改文件；加 --apply 才写入）"
echo

for cfg in "${CONFIGS[@]}"; do
  tenant="$(basename "$(dirname "$cfg")")"
  echo "=== 租户: $tenant ==="

  # 用 node 做 JSON 读写，避免 sed/awk 破坏格式。
  # stdout 输出状态关键字，便于下面判断是否要备份。
  status="$(APPLY=$APPLY ENABLED=$ENABLED FIR_TOKEN=$FIR_TOKEN FIR_BASE=$FIR_BASE \
    IOS_BUNDLE=$IOS_BUNDLE ANDROID_BUNDLE=$ANDROID_BUNDLE CFG="$cfg" node -e '
    const fs = require("fs");
    const p = process.env.CFG;
    const apply = process.env.APPLY === "1";
    const raw = fs.readFileSync(p, "utf8");
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      console.log("invalid-json:" + e.message);
      process.exit(0);
    }
    if (cfg.appUpdate) {
      // 已存在就不动：可能用户已经填了真 token。
      console.log("already-present:" + JSON.stringify(cfg.appUpdate));
      process.exit(0);
    }
    const block = {
      enabled: process.env.ENABLED === "true",
      apiToken: process.env.FIR_TOKEN || "",
      apiBase: process.env.FIR_BASE,
      iosBundleId: process.env.IOS_BUNDLE,
      androidBundleId: process.env.ANDROID_BUNDLE,
      timeoutMs: 15000,
    };
    if (!apply) {
      console.log("would-add:" + JSON.stringify(block));
      process.exit(0);
    }
    // 备份，出问题可还原。
    fs.writeFileSync(p + ".bak-" + Date.now(), raw);
    cfg.appUpdate = block;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    // 写回后立刻复核，确保不是写坏了文件。
    JSON.parse(fs.readFileSync(p, "utf8"));
    console.log("added:" + JSON.stringify(block));
  ')"

  case "$status" in
    already-present:*) echo "  已有 appUpdate，跳过：" "${status#already-present:}" ;;
    would-add:*)       echo "  将新增：" "${status#would-add:}" ;;
    added:*)           echo "  已新增：" "${status#added:}" ;;
    invalid-json:*)    echo "  JSON 解析失败，未修改：${status#invalid-json:}" ;;
    *)                 echo "  未预期输出：$status" ;;
  esac
  echo
done

if [[ $APPLY -eq 0 ]]; then
  echo "预览完毕。确认无误后加 --apply 执行。"
  exit 0
fi

# 重启容器让新配置生效。配置只在启动时读入，改文件不重启不会生效。
echo "重启 aiclaw 容器…"
if ! command -v docker >/dev/null 2>&1 || ! docker ps >/dev/null 2>&1; then
  echo "本机没有可用的 docker（或不在 NAS 上），跳过重启。"
  echo "请在 NAS 上重启容器：docker restart aiclaw-aiclaw-1"
elif docker ps --format '{{.Names}}' | grep -qx 'aiclaw-aiclaw-1'; then
  docker restart aiclaw-aiclaw-1 >/dev/null
  echo "已重启 aiclaw-aiclaw-1。"
elif [[ -n "${NAS_PROJECT_DIR:-}" && -f "${NAS_PROJECT_DIR}/docker-compose-aiclaw.yml" ]]; then
  ( cd "$NAS_PROJECT_DIR" && docker compose -f docker-compose-aiclaw.yml up -d --force-recreate aiclaw )
  echo "已用 compose 重建 aiclaw。"
else
  echo "没找到运行中的 aiclaw 容器，请手动重启。" >&2
fi

echo
echo "验证（把 <TOKEN> 换成 accessToken）："
echo "  curl -H 'Authorization: Bearer <TOKEN>' 'http://127.0.0.1:3010/api/app/update?platform=ios'"
