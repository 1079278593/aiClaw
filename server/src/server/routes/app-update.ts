/**
 * App 内更新的路由。
 *
 * ```text
 * GET /api/app/update?platform=ios|android
 *   → AppUpdateInfo（含 configured / available / 版本 / 安装链接）
 * ```
 *
 * 为什么在这里做代理而不是让移动端直连 fir：
 * `FIR_API_TOKEN` 是账号级凭证，客户端包可被解包，token 不该出现在里面。
 * 详见 `src/app-update/index.ts` 文件头。
 *
 * 鉴权：`/api/*` 在 `http.ts` 里统一走 accessToken 校验，所以这里不必重复判权
 * ——但这也意味着该接口**不能**被匿名访问，移动端必须已保存令牌。
 */

import { fetchAppUpdate, isAppUpdatePlatform } from "../../app-update/index.js";
import type { RouteHandler } from "../http-types.js";
import { sendJson } from "../http-types.js";

export const handleAppUpdateRoutes: RouteHandler = async ({ req, res, url, config }) => {
  if (url.pathname !== "/api/app/update") return false;

  if (req.method !== "GET") {
    sendJson(res, { error: "不支持的方法" }, 405);
    return true;
  }

  const platformRaw = url.searchParams.get("platform") ?? "ios";
  if (!isAppUpdatePlatform(platformRaw)) {
    // 白名单校验：platform 会参与拼 URL，绝不能原样放行任意字符串。
    sendJson(res, { error: "platform 必须是 ios 或 android" }, 400);
    return true;
  }

  try {
    // 返回 200 即使「查不到」：未配置/未上传都属于正常状态，
    // 移动端按 configured / available 决定展示，不该走错误分支。
    sendJson(res, await fetchAppUpdate(config.appUpdate, platformRaw));
  } catch (error) {
    sendJson(res, { error: (error as Error).message || "查询更新失败" }, 500);
  }
  return true;
};
