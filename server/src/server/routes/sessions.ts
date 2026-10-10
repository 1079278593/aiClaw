import { compactSession } from "../../chat/compaction.js";
import { createSession, deleteSession, listSessions, loadSession, renameSession, truncateSession } from "../../session/index.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson, toSessionMessage } from "../http-types.js";
import { appendUsageRecord } from "../services/usage-store.js";

export const handleSessionRoutes: RouteHandler = async ({ req, res, url, config, logger, broadcast }) => {
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    sendJson(res, { sessions: await listSessions() });
    return true;
  }
  if (url.pathname === "/api/sessions" && req.method === "POST") {
    try {
      const data = await readJsonBody<{ title?: string }>(req);
      sendJson(res, { session: await createSession(data.title) });
    } catch {
      sendJson(res, { error: "Failed to create session" }, 500);
    }
    return true;
  }

  const directMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
  if (directMatch && req.method === "GET") {
    try {
      sendJson(res, { session: await loadSession(directMatch[1]) });
    } catch {
      sendJson(res, { error: "Session not found" }, 404);
    }
    return true;
  }
  if (directMatch && req.method === "PATCH") {
    try {
      const data = await readJsonBody<{ title: string }>(req);
      sendJson(res, { session: await renameSession(directMatch[1], data.title) });
    } catch (error) {
      const message = (error as Error).message || "Failed to rename session";
      sendJson(res, { error: message }, message === "Session title is required" ? 400 : 500);
    }
    return true;
  }
  if (directMatch && req.method === "DELETE") {
    try {
      await deleteSession(directMatch[1]);
      sendJson(res, { ok: true });
    } catch {
      sendJson(res, { error: "Session not found" }, 404);
    }
    return true;
  }

  const compactMatch = /^\/api\/sessions\/([^/]+)\/compact$/.exec(url.pathname);
  if (compactMatch && req.method === "POST") {
    try {
      const data = await readJsonBody<{ keepRecentRounds?: number }>(req);
      const keepRecentRounds = typeof data.keepRecentRounds === "number" ? data.keepRecentRounds : undefined;
      const result = await compactSession(compactMatch[1], config, logger, keepRecentRounds);
      if (result.usage) await appendUsageRecord(result.usage);
      broadcast(toSessionMessage(await loadSession(compactMatch[1])));
      sendJson(res, { ok: true, archivedAs: result.archivedAs });
    } catch (error) {
      const message = (error as Error).message;
      const isBadRequest = message.includes("fewer than") || message.includes("Compaction not needed");
      sendJson(res, { error: isBadRequest || message.startsWith("Compaction failed") ? message : `Compaction failed: ${message}` }, isBadRequest ? 400 : 500);
    }
    return true;
  }

  const truncateMatch = /^\/api\/sessions\/([^/]+)\/truncate$/.exec(url.pathname);
  if (truncateMatch && req.method === "POST") {
    try {
      const data = await readJsonBody<{ messageId?: string }>(req);
      if (!data.messageId) {
        sendJson(res, { error: "messageId is required" }, 400);
        return true;
      }
      const session = await truncateSession(truncateMatch[1], data.messageId);
      broadcast(toSessionMessage(session));
      sendJson(res, { ok: true, messageCount: session.messages.length });
    } catch (error) {
      const message = (error as Error).message;
      sendJson(res, { error: message }, message.includes("not found") ? 404 : 500);
    }
    return true;
  }
  return false;
};
