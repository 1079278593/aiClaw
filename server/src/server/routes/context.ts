/**
 * 上下文来源接口。
 *
 * ```text
 * GET  /api/context/sources   → ContextOverview（含每块 token 与合计）
 * PUT  /api/context/sources   → body { updates: [{ id, content }] }
 *                               确认后落盘，返回最新 overview
 * ```
 *
 * 为什么是 PUT 而不是 PATCH：前端提交的是**整块内容**，
 * 语义是「用这份内容替换那一块」，而不是局部补丁。
 *
 * 「确认后生效」的实现方式：这几块内容本来就在**每轮请求时重新读盘**
 * （`loadSystemPrompt` / `prepareMemory` / `buildDistillMapInjection`），
 * 所以落盘即生效，不需要重启、也不需要清缓存。
 * 反过来，这也意味着**没有草稿态**——因此前端必须显式确认再发 PUT，
 * 不能做成输入即保存。
 */

import { ContextSourceError, collectContextSources, writeContextSources } from "../../context/sources.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

export const handleContextRoutes: RouteHandler = async ({ req, res, url, config }) => {
  if (url.pathname !== "/api/context/sources") return false;

  const switches = {
    injectRootIndex: Boolean(config.injectRootIndex),
    injectDistillMap: Boolean(config.injectDistillMap),
  };

  if (req.method === "GET") {
    try {
      sendJson(res, await collectContextSources(switches));
    } catch (error) {
      sendJson(res, { error: (error as Error).message || "读取上下文来源失败" }, 500);
    }
    return true;
  }

  if (req.method === "PUT") {
    let body: { updates?: unknown };
    try {
      body = await readJsonBody<{ updates?: unknown }>(req);
    } catch {
      sendJson(res, { error: "无效的请求" }, 400);
      return true;
    }
    if (!Array.isArray(body.updates)) {
      sendJson(res, { error: "updates 必须是数组" }, 400);
      return true;
    }

    const updates: Array<{ id: string; content: string }> = [];
    for (const item of body.updates) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as { id?: unknown; content?: unknown };
      if (typeof candidate.id !== "string" || typeof candidate.content !== "string") {
        sendJson(res, { error: "每个 update 需要字符串 id 与 content" }, 400);
        return true;
      }
      updates.push({ id: candidate.id, content: candidate.content });
    }
    if (updates.length === 0) {
      // 空更新是前端 bug（点了确认却什么都没动），明确报错而不是假装成功。
      sendJson(res, { error: "没有需要保存的内容" }, 400);
      return true;
    }

    const result = await writeContextSources(updates);
    if (result.failed.length > 0) {
      // 部分失败按 400 返回：前端需要逐条展示原因，但仍带上已保存的列表与最新统计。
      sendJson(res, {
        ...result,
        overview: await collectContextSources(switches).catch(() => null),
        error: result.failed.map((item) => `${item.id}: ${item.error}`).join("；"),
      }, 400);
      return true;
    }

    sendJson(res, {
      ...result,
      overview: await collectContextSources(switches),
    });
    return true;
  }

  sendJson(res, { error: "不支持的方法" }, 405);
  return true;
};

// 供测试断言错误分支。
export { ContextSourceError };
