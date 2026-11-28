/**
 * 领域（专家）列表与新建（plan_experts §4 阶段 2）。
 *
 * 只有两个接口，都不改会话：勾选走 `PATCH /api/sessions/:id`。
 * 新建是**一次性**的：目录、`rules.md`、`index.md` 已存在就拒绝，不覆盖。
 * 之后这两个文件只在文档浏览器里改，`POST` 不再生成第二次。
 */

import { createExpertDomain, ExpertCreateError, listExpertDomains } from "../../experts/index.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

export const handleExpertsRoutes: RouteHandler = async ({ req, res, url }) => {
  if (url.pathname === "/api/experts" && req.method === "GET") {
    const domains = await listExpertDomains().catch(() => []);
    sendJson(res, { experts: domains });
    return true;
  }

  if (url.pathname === "/api/experts" && req.method === "POST") {
    let body: { id?: unknown };
    try {
      body = await readJsonBody<{ id?: unknown }>(req);
    } catch {
      sendJson(res, { error: "无效的请求" }, 400);
      return true;
    }
    try {
      const created = await createExpertDomain(body.id);
      sendJson(res, { ok: true, expert: { id: created.id, hasIndex: true } }, 201);
    } catch (error) {
      const status = error instanceof ExpertCreateError ? error.statusCode : 500;
      sendJson(res, { error: (error as Error).message || "新建领域失败" }, status);
    }
    return true;
  }

  return false;
};
