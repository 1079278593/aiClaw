import { compactSession } from "../../chat/compaction.js";
import { foldDialogueState } from "../../chat/dialogue-fold.js";
import { loadDialogueState, removeDialogueState, resetDialogueCursor } from "../../chat/dialogue-state.js";
import { loadAppState } from "../../app-state/index.js";
import {
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
  setSessionFold,
  truncateSession,
} from "../../session/index.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson, toSessionMessage } from "../http-types.js";
import { appendUsageRecord } from "../services/usage-store.js";

export const handleSessionRoutes: RouteHandler = async ({ req, res, url, config, logger, broadcast }) => {
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const appState = await loadAppState();
    // The reflections chat session is mobile-internal: keep it out of the chat list
    // (plan_reflections_chat.md §7.4 step 4).
    const sessions = (await listSessions()).filter((s) => s.id !== appState.reflectionsSessionId && !s.personId);
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
      const sessionId = directMatch[1];
      // 先读会话：删完之后就拿不到 personId，也就分不清要不要清状态块。
      const session = await loadSession(sessionId);
      await deleteSession(sessionId);
      // 人物分析会话的折叠状态只属于这一次分析，删会话就连块一起删；
      // 心得会话的状态是人的长期结论，删会话保留（dialogue-state.ts 的既有语义）。
      if (session.personId) {
        await removeDialogueState(sessionId).catch((error) => {
          logger.warn(`dialogue state not removed: ${(error as Error).message}`, { sessionId });
        });
      }
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
      const target = await loadSession(sessionId);
      // 需要折叠的会话（人物分析 / 心得）：走增量折叠，不重写历史，也不看 8000 token 阈值。
      // 其它会话仍是 `compactSession`（整段摘要换掉旧历史）。
      const foldBackfill = target.fold !== true && (await loadAppState()).reflectionsSessionId === sessionId;
      if (target.fold === true || foldBackfill) {
        if (foldBackfill) await setSessionFold(sessionId, true).catch(() => undefined);
        const folded = await foldDialogueState(sessionId, config, logger, {
          force: true,
          domain: target.personId ? "person" : "reflections",
        });
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
      // 截断可能把游标指向的消息删掉。保留「当前有效」，只把游标归零，
      // 否则 `pendingRange` 会一直返回 null，这条会话再也不会折叠。
      if (session.fold) await resetDialogueCursor(session.id).catch(() => undefined);
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
