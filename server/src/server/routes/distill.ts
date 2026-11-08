/**
 * 蒸馏接口（plan_distill §9 第 5 步）。
 *
 * ```text
 * GET  /api/distill/overview          → { text, updatedAt }   地图原文
 * GET  /api/distill/stale             → { items }             过期摘要（只读扫描）
 * POST /api/distill/refresh           → body { scope, path, sources?, title? }
 *                                       生成/重算一篇摘要
 * ```
 *
 * **刻意没有**「列表 / 删除 / 重建全站」三类接口：
 * 蒸馏不是用户管理的数据，是 Agent 的缓存（plan_distill §3.1.1）。
 * 列表面板、删除按钮、空态这些都随「不做专门 UI」一起去掉了。
 *
 * 刷新是本模块唯一会烧 token 的操作，所以：
 * - 必须显式指定 `scope` + `path`，不支持「刷新全部」；
 * - 生成失败返回 200 + `{ ok: false, error }`（缓存没更新不是请求错误，
 *   前端据此提示即可，不该走 5xx 让用户以为服务坏了）。
 */

import { generateDistill } from "../../distill/generate.js";
import { scanStaleSummaries } from "../../distill/generate.js";
import { isDistillScope, readOverview } from "../../distill/store.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

export const handleDistillRoutes: RouteHandler = async ({ req, res, url, config }) => {
  try {
    if (url.pathname === "/api/distill/overview" && req.method === "GET") {
      const text = await readOverview();
      sendJson(res, { text, bytes: Buffer.byteLength(text, "utf-8") });
      return true;
    }

    if (url.pathname === "/api/distill/stale" && req.method === "GET") {
      // 只扫描、不重算：自动重算会在用户不知情时烧 token（plan_distill §6）。
      sendJson(res, { items: await scanStaleSummaries() });
      return true;
    }

    if (url.pathname === "/api/distill/refresh" && req.method === "POST") {
      const body = await readJsonBody<{
        scope?: unknown;
        path?: unknown;
        sources?: unknown;
        title?: unknown;
      }>(req).catch(() => ({} as Record<string, never>));

      const scope = typeof body.scope === "string" ? body.scope : "";
      const relative = typeof body.path === "string" ? body.path : "";
      if (!isDistillScope(scope)) {
        sendJson(res, { error: "scope 必须是 reflections 或 knowledge" }, 400);
        return true;
      }
      if (!relative) {
        sendJson(res, { error: "path 不能为空" }, 400);
        return true;
      }
      const sources = Array.isArray(body.sources)
        ? body.sources.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];

      const result = await generateDistill({
        scope,
        relative,
        title: typeof body.title === "string" ? body.title : undefined,
        sources,
        // 必须带上 config：否则 createLlmSummarizer 拿不到 provider/model，
        // 每次刷新都会以「未提供配置」失败（真实冒烟测试发现的问题）。
        config,
      });
      // 生成失败也是 200：缓存没更新不等于请求非法（见文件头）。
      sendJson(res, result);
      return true;
    }
  } catch (error) {
    sendJson(res, { error: (error as Error).message || "请求失败" }, 400);
    return true;
  }

  if (url.pathname === "/api/distill" || url.pathname.startsWith("/api/distill/")) return false;
  return false;
};
