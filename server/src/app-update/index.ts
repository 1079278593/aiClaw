/**
 * App 内更新：替移动端去问 fir，**token 不下发到客户端**。
 *
 * 存在这一层的唯一理由是凭据边界：`FIR_API_TOKEN` 是账号级的，
 * 用它不仅能查版本，还能列出账号下所有应用。APK/IPA 都可解包，
 * 把 token 打进客户端等于对每个拿到安装包的人公开。
 * 所以移动端只调本服务，由这里持有 token 去请求 fir。
 *
 * 关于 fir 的返回格式：同一个接口在不同域名/不同应用状态下形状不一致，
 * 已知的两种情况都要接住：
 *   1. 正常：{ version, build, versionShort, changelog, installUrl, update_url, binary:{fsize} }
 *   2. 应用不存在：{ code: 100701, errors: { exception: ["app is not found"] } }
 * 把「应用不存在」当成一种**正常的空结果**，不是错误——Android 侧目前
 * 就没有上传过包，若这里抛错，移动端只能显示故障，反而误导。
 */

export type AppUpdatePlatform = "ios" | "android";

export type AppUpdateInfo = {
  platform: AppUpdatePlatform;
  /** 服务端是否配好了 token。false 时其余字段无意义，移动端应隐藏入口。 */
  configured: boolean;
  /** fir 上是否已存在该应用（Android 目前为 false，属正常状态）。 */
  available: boolean;
  /** 营销版本，如 1.0.0。 */
  version?: string;
  /** 构建号，字符串（fir 原样返回，不转数字以免丢前导零）。 */
  build?: string;
  /** 更新说明。 */
  changelog?: string;
  /** 更新时间（ISO 字符串）；fir 给的是秒级时间戳。 */
  updatedAt?: string;
  /** 一键安装链接（iOS 为 itms-services 跳转）。 */
  installUrl?: string;
  /** fir 的更新短链，作为 installUrl 缺失时的兜底。 */
  updateUrl?: string;
  /** 安装包字节数。 */
  sizeBytes?: number;
  /** 未配置 / 不可用时的说明，直接展示给用户。 */
  reason?: string;
};

export type AppUpdateConfig = {
  enabled: boolean;
  apiToken: string;
  apiBase: string;
  iosBundleId: string;
  androidBundleId: string;
  timeoutMs: number;
};

function bundleIdOf(config: AppUpdateConfig, platform: AppUpdatePlatform): string {
  return platform === "ios" ? config.iosBundleId : config.androidBundleId;
}

/** 只接受这两个值，避免把用户输入拼进 URL 造成任意路径请求。 */
export function isAppUpdatePlatform(value: unknown): value is AppUpdatePlatform {
  return value === "ios" || value === "android";
}

/**
 * 查 fir 的最新版本。
 *
 * 失败一律降级成 `available:false + reason`，**不抛异常**：
 * 更新检查是锦上添花的功能，它坏掉不该让「更多」页面整块报错。
 * 但配置本身缺失（没 token / 没开开关）要与「查询失败」区分开，
 * 否则用户会以为是自己网络问题。
 */
export async function fetchAppUpdate(
  config: AppUpdateConfig | undefined,
  platform: AppUpdatePlatform,
): Promise<AppUpdateInfo> {
  const base: AppUpdateInfo = { platform, configured: false, available: false };

  if (!config?.enabled) {
    return { ...base, reason: "服务端未开启 App 更新功能（appUpdate.enabled）" };
  }
  const token = config.apiToken.trim();
  if (!token) {
    return { ...base, reason: "服务端未配置 fir 的 API Token（appUpdate.apiToken）" };
  }

  const bundleId = bundleIdOf(config, platform);
  const url = `${config.apiBase.replace(/\/+$/, "")}/apps/latest/${encodeURIComponent(bundleId)}`
    + `?api_token=${encodeURIComponent(token)}&type=${platform}`;

  let payload: Record<string, unknown>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      payload = (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    return {
      ...base,
      configured: true,
      reason: aborted ? "查询更新超时" : `无法连接 fir（${(error as Error).message}）`,
    };
  }

  // 应用不存在：Android 尚未上传过包时就是这种返回，属于正常空结果。
  if (payload.code === 100701 || (payload.errors && !payload.version)) {
    return {
      ...base,
      configured: true,
      reason: `fir 上还没有 ${platform} 的安装包（bundle: ${bundleId}）`,
    };
  }

  // token 填错（例如没替换模板里的占位文字）时 fir 会带 message 返回。
  // 原样透传，否则用户只会看到「没有版本号」，根本猜不到是 token 的问题。
  const message = typeof payload.message === "string" ? payload.message : "";
  if (message && !payload.build && !payload.versionShort) {
    return { ...base, configured: true, reason: `fir 拒绝了请求：${message}` };
  }

  const version = typeof payload.versionShort === "string" ? payload.versionShort : undefined;
  const build = typeof payload.build === "string"
    ? payload.build
    : typeof payload.version === "string" ? payload.version : undefined;
  if (!build) {
    return { ...base, configured: true, reason: "fir 返回里没有版本号" };
  }

  const installUrl = (typeof payload.installUrl === "string" && payload.installUrl)
    || (typeof payload.install_url === "string" && payload.install_url)
    || undefined;
  const updateUrl = (typeof payload.update_url === "string" && payload.update_url) || undefined;
  const binary = payload.binary as { fsize?: unknown } | undefined;
  const sizeBytes = typeof binary?.fsize === "number" ? binary.fsize : undefined;
  const updatedAt = typeof payload.updated_at === "number"
    ? new Date(payload.updated_at * 1000).toISOString()
    : undefined;

  return {
    platform,
    configured: true,
    available: true,
    ...(version ? { version } : {}),
    build,
    ...(typeof payload.changelog === "string" && payload.changelog ? { changelog: payload.changelog } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    // 两个链接可能只出现一个：installUrl 能直接装，updateUrl 只是网页。
    // 优先给能装的，缺失时退回短链，由客户端按「能否直接安装」决定文案。
    ...(installUrl ? { installUrl } : {}),
    ...(!installUrl && updateUrl ? { updateUrl } : {}),
    ...(updateUrl && installUrl ? { updateUrl } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}
