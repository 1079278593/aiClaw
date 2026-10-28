import type { WebSocket } from "ws";
import { BRAND_NAME } from "../brand.js";
import type { Config } from "../config/index.js";
import type { getLogger } from "../logger/index.js";
import { setLastActiveSession } from "../app-state/index.js";
import { loadSession } from "../session/index.js";
import { processChatMessage, cancelChat } from "./chat-handler.js";
import type { Client, ClientMessage } from "./protocol.js";
import { sendToClient } from "./send.js";
import { loadConfigWithoutApiKey } from "../config/index.js";
import { authIsRequired, resolveTenantToken, type TenantIdentity } from "../tenant/access.js";
import { currentTenant, runWithTenant, type TenantScope } from "../tenant/store.js";
import { initTools } from "../tools/index.js";
import { CHAT_LIMIT_PER_MINUTE, consumeRateLimit } from "./rate-limit.js";

const AUTH_TIMEOUT_MS = 5_000;

export function handleWebSocketConnection(
  ws: WebSocket,
  clients: Map<WebSocket, Client>,
  config: Config,
  logger: ReturnType<typeof getLogger>,
  queryToken?: string,
): void {
  const bootTenant = currentTenant();
  let scope: TenantScope | undefined = bootTenant;
  let activeConfig = config;
  let authenticated = false;
  const client: Client = {
    ws,
    sessionId: undefined,
    isAlive: true,
    writePermOpen: false,
  };
  const pendingPermissions = new Map<string, { resolve: (allowed: boolean) => void; sessionId: string }>();
  clients.set(ws, client);
  logger.info(`WebSocket client connected (${clients.size} total)`);

  const enter = <T>(fn: () => T): T => (scope ? runWithTenant(scope, fn) : fn());

  const markAuthenticated = async (identity: TenantIdentity | null) => {
    if (!identity) {
      ws.close(4401, "Unauthorized");
      return false;
    }
    scope = identity;
    client.tenantId = identity.id;
    activeConfig = await loadConfigWithoutApiKey(identity.base);
    activeConfig.server = config.server;
    enter(() => initTools(activeConfig));
    authenticated = true;
    sendToClient(client, { type: "connected", message: `Connected to ${BRAND_NAME}` });
    return true;
  };

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4401, "Unauthorized");
  }, AUTH_TIMEOUT_MS);
  let ready = false;
  const queued: Buffer[] = [];

  ws.on("message", (data: Buffer) => {
    if (!ready) {
      queued.push(data);
      return;
    }
    void enter(() => onClientMessage(data));
  });

  void (async () => {
    const required = await authIsRequired(config.server.accessToken);
    if (!required) {
      authenticated = true;
      clearTimeout(authTimer);
      sendToClient(client, { type: "connected", message: `Connected to ${BRAND_NAME}` });
    } else if (queryToken) {
      clearTimeout(authTimer);
      await markAuthenticated(await resolveTenantToken(queryToken, config.server.accessToken));
    }
    ready = true;
    for (const data of queued) void enter(() => onClientMessage(data));
  })();

  async function onClientMessage(data: Buffer) {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      if (!authenticated) {
        if (message.type === "ping") {
          sendToClient(client, { type: "pong" });
          return;
        }
        if (message.type === "auth") {
          clearTimeout(authTimer);
          await markAuthenticated(await resolveTenantToken(message.token, config.server.accessToken));
          return;
        }
        ws.close(4401, "Unauthorized");
        return;
      }
      if (message.type === "auth") return;
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
        const limit = consumeRateLimit(`chat:${client.tenantId ?? "-"}`, CHAT_LIMIT_PER_MINUTE);
        if (!limit.allowed) {
          sendToClient(client, { type: "error", message: "请求过于频繁，请稍后再试" });
          return;
        }
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
          threadPath: message.threadPath,
          captureJob: message.captureJob,
          pendingPermissions,
          config: activeConfig,
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
  }

  ws.on("close", () => {
    clearTimeout(authTimer);
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
