import type { WebSocket } from "ws";
import { BRAND_NAME } from "../brand.js";
import type { Config } from "../config/index.js";
import type { getLogger } from "../logger/index.js";
import { setLastActiveSession } from "../app-state/index.js";
import { loadSession } from "../session/index.js";
import { processChatMessage, cancelChat } from "./chat-handler.js";
import type { Client, ClientMessage } from "./protocol.js";
import { sendToClient } from "./send.js";

export function handleWebSocketConnection(
  ws: WebSocket,
  clients: Map<WebSocket, Client>,
  config: Config,
  logger: ReturnType<typeof getLogger>,
): void {
  const client: Client = { ws, sessionId: undefined, isAlive: true, writePermOpen: false };
  const pendingPermissions = new Map<string, { resolve: (allowed: boolean) => void; sessionId: string }>();
  clients.set(ws, client);
  logger.info(`WebSocket client connected (${clients.size} total)`);
  sendToClient(client, { type: "connected", message: `Connected to ${BRAND_NAME}` });

  ws.on("message", async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      if (message.type === "ping") {
        sendToClient(client, { type: "pong" });
        return;
      }
      if (message.type === "toolPermissionResponse") {
        const entry = pendingPermissions.get(message.requestId);
        if (entry) {
          pendingPermissions.delete(message.requestId);
          entry.resolve(message.allowed);
        }
        return;
      }
      if (message.type === "setWritePermission") {
        client.writePermOpen = message.enabled === true;
        return;
      }
      if (message.type === "joinSession") {
        client.sessionId = message.sessionId;
        try {
          const session = await loadSession(message.sessionId);
          await setLastActiveSession(message.sessionId);
          sendToClient(client, {
            type: "sessionLoaded",
            requestId: message.requestId,
            session: {
              id: session.id,
              title: session.title,
              messages: session.messages,
              lastProvider: session.lastProvider,
              lastModel: session.lastModel,
              lastThinkingEffort: session.lastThinkingEffort,
            },
          });
          logger.debug(`Client joined session: ${message.sessionId}`);
        } catch {
          sendToClient(client, { type: "error", message: "Session not found" });
        }
        return;
      }
      if (message.type === "chatMessage") {
        if (!message.sessionId) {
          sendToClient(client, { type: "error", message: "Missing sessionId" });
          return;
        }
        client.sessionId = message.sessionId;
        void processChatMessage({
          client,
          sessionId: message.sessionId,
          content: message.content,
          images: message.images,
          provider: message.provider,
          model: message.model,
          thinkingEffort: message.thinkingEffort,
          previewPath: message.previewPath,
          selectedPreviewText: message.selectedPreviewText,
          pendingPermissions,
          config,
          logger,
        });
        return;
      }
      if (message.type === "cancelChat") {
        cancelChat(message.sessionId, pendingPermissions);
        return;
      }
      sendToClient(client, { type: "error", message: `Unknown message type: ${(message as { type: string }).type}` });
    } catch (error) {
      logger.error(`WebSocket message error: ${(error as Error).message}`);
      sendToClient(client, { type: "error", message: "Failed to process message" });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    logger.info(`WebSocket client disconnected (${clients.size} remaining)`);
  });
  ws.on("error", (error) => {
    logger.error(`WebSocket error: ${error.message}`);
    clients.delete(ws);
  });
  ws.on("pong", () => {
    client.isAlive = true;
  });
}
