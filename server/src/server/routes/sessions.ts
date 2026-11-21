import { compactSession } from "../../chat/compaction.js";
import { foldDialogueState } from "../../chat/dialogue-fold.js";
import { loadAppState } from "../../app-state/index.js";
import { createSession, deleteSession, listSessions, loadSession, renameSession, truncateSession } from "../../session/index.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson, toSessionMessage } from "../http-types.js";
import { appendUsageRecord } from "../services/usage-store.js";

export const handleSessionRoutes: RouteHandler = async ({ req, res, url, config, logger, broadcast }) => {
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const appState = await loadAppState();
    // The reflections chat session is mobile-internal: keep it out of the chat list
    // (plan_reflections_chat.md §7.4 step 4).
    const sessions = (await listSessions()).filter((s) => s.id !== appState.reflectionsSessionId);
    sendJson(res, { sessions });
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
      const sessionId = compactMatch[1];
      const appState = await loadAppState();
      // 心得会话：走增量折叠，不重写历史，也不看 8000 token 阈值。
      // 其它会话仍是 `compactSession`（整段摘要换掉旧历史）。
      if (appState.reflectionsSessionId === sessionId) {
        const folded = await foldDialogueState(sessionId, config, logger, { force: true });
        if (folded.usage.length > 0) {
          for (const record of folded.usage) await appendUsageRecord(record);
        }
        if (folded.outcome === "failed") {
          sendJson(res, { error: `Compaction failed: ${folded.reason ?? "折叠失败"}` }, 500);
          return true;
        }
        if (folded.outcome === "no-pending") {
          sendJson(res, { error: "Compaction not needed: 没有待处理的原文" }, 400);
          return true;
        }
        broadcast(toSessionMessage(await loadSession(sessionId)));
        sendJson(res, {
          ok: true,
          archivedAs: null,
          constraintsExtracted: false,
          constraintCount: 0,
          foldedThrough: folded.foldedThrough ?? null,
          batches: folded.batches,
          outcomes: folded.outcome,
        });
        return true;
      }

      const data = await readJsonBody<{ keepRecentRounds?: number }>(req);
      const keepRecentRounds = typeof data.keepRecentRounds === "number" ? data.keepRecentRounds : undefined;
      const result = await compactSession(sessionId, config, logger, keepRecentRounds);
      if (result.usage) await appendUsageRecord(result.usage);
      broadcast(toSessionMessage(await loadSession(sessionId)));
      sendJson(res, {
        ok: true,
        archivedAs: result.archivedAs,
        constraintsExtracted: result.constraintsExtracted === true,
        constraintCount: result.constraints?.length ?? 0,
      });
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
