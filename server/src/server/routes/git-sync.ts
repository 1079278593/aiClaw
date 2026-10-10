import { getPaths } from "../../config/paths.js";
import { getGitSyncStatus, GitSyncError, pullGitSync, pushGitSync } from "../services/git-sync.js";
import type { RouteHandler } from "../http-types.js";
import { sendJson } from "../http-types.js";

function sendGitError(error: unknown, res: Parameters<typeof sendJson>[0]): void {
  if (error instanceof GitSyncError) {
    const statusCode = error.code === "busy" || error.code === "working_tree_dirty" ? 409 : 400;
    sendJson(res, { error: error.message, output: error.output }, statusCode);
    return;
  }
  sendJson(res, { error: "Git 同步失败。" }, 500);
}

export const handleGitSyncRoutes: RouteHandler = async ({ req, res, url, gitSyncEnabled }) => {
  const isGitRoute = url.pathname === "/api/git/status" || url.pathname === "/api/git/pull" || url.pathname === "/api/git/push";
  if (!isGitRoute) return false;

  if (!gitSyncEnabled) {
    sendJson(res, { error: "Not found" }, 404);
    return true;
  }

  try {
    if (url.pathname === "/api/git/status" && req.method === "GET") {
      sendJson(res, { enabled: true, dataDir: getPaths().base, ...(await getGitSyncStatus()) });
      return true;
    }
    if (url.pathname === "/api/git/pull" && req.method === "POST") {
      sendJson(res, await pullGitSync());
      return true;
    }
    if (url.pathname === "/api/git/push" && req.method === "POST") {
      sendJson(res, await pushGitSync());
      return true;
    }
  } catch (error) {
    sendGitError(error, res);
    return true;
  }

  return false;
};
