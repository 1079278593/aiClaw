import { readAccountSettings, updateAccountSettings } from "../../config/account-settings.js";
import { rotateUser } from "../../tenant/users.js";
import { getAvailableProviders, type Config, type ProviderName } from "../../config/index.js";
import { loadAppState } from "../../app-state/index.js";
import { authIsRequired } from "../../tenant/access.js";
import { currentTenant } from "../../tenant/store.js";
import { flushUsage, getDailyStats, getUsageStats } from "../services/usage-store.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";
import { isTriliumEnabled } from "../../trilium/paths.js";
import { serverVersion } from "../../version.js";

export const handleSystemRoutes: RouteHandler = async ({ req, res, url, config, gitSyncEnabled, logger }) => {
  // /health is handled in http.ts (public). Keep a duplicate here only if reached somehow.
  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, {
      status: "ok",
      authRequired: await authIsRequired(config.server.accessToken),
      ...serverVersion(),
    });
    return true;
  }
  if (url.pathname === "/api/account/token/rotate" && req.method === "POST") {
    const id = currentTenant()?.id;
    if (!id) {
      sendJson(res, { error: "无法确定当前账号" }, 400);
      return true;
    }
    try {
      const token = await rotateUser(id);
      logger.info(`Rotated access token for '${id}'.`);
      sendJson(res, { token, accountId: id });
    } catch (error) {
      const missing = (error as Error).message.includes("not found");
      sendJson(res, {
        error: missing ? "当前账号不能在这里轮换，请在服务器上执行 user rotate" : (error as Error).message,
      }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/settings/account" && req.method === "GET") {
    sendJson(res, { ...(await readAccountSettings()), accountId: currentTenant()?.id ?? "" });
    return true;
  }
  if (url.pathname === "/api/settings/account" && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      sendJson(res, { ...(await updateAccountSettings(body)), accountId: currentTenant()?.id ?? "" });
    } catch (error) {
      const message = error instanceof SyntaxError ? "无效的请求" : (error as Error).message;
      sendJson(res, { error: message }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, {
      availableProviders: getAvailableProviders(config),
      providers: Object.fromEntries(
        (Object.entries(config.providers) as Array<[ProviderName, Config["providers"][ProviderName]]>)
          .map(([name, provider]) => [name, { models: provider.models }]),
      ),
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      defaultThinkingEffort: config.defaultThinkingEffort,
      gitSyncEnabled,
      triliumEnabled: isTriliumEnabled(config.tools.trilium.enabled, config.tools.trilium.token),
      authRequired: await authIsRequired(config.server.accessToken),
      accountId: currentTenant()?.id ?? "",
    });
    return true;
  }
  if (url.pathname === "/api/app-state" && req.method === "GET") {
    sendJson(res, await loadAppState());
    return true;
  }
  if (url.pathname === "/api/usage/flush" && req.method === "POST") {
    await flushUsage();
    sendJson(res, { ok: true });
    return true;
  }
  if (url.pathname === "/api/usage/stats" && req.method === "GET") {
    sendJson(res, await getUsageStats());
    return true;
  }
  if (url.pathname === "/api/usage/daily" && req.method === "GET") {
    const days = parseInt(url.searchParams.get("days") || "7", 10);
    sendJson(res, await getDailyStats(Math.min(Math.max(days, 1), 90)));
    return true;
  }
  return false;
};
