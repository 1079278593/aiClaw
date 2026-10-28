import { createServer } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, type Config } from "../config/index.js";
import { getInstallRoot, getPaths } from "../config/paths.js";
import { getLogger } from "../logger/index.js";
import { hasActiveUser, loadUsers } from "../tenant/users.js";
import { currentTenant, runWithTenant, type TenantScope } from "../tenant/store.js";
import { initTools } from "../tools/index.js";
import {
  assertServerBindSafe,
  extractAccessTokenFromUrl,
} from "./auth.js";
import { createHttpHandler } from "./http.js";
import type { Client, ClientMessage, ServerMessage } from "./protocol.js";
import { sendToClient } from "./send.js";
import { handleWebSocketConnection } from "./websocket.js";

export type { Client, ClientMessage, ServerMessage } from "./protocol.js";
export type { CommandDefinition } from "./services/commands.js";
export { parseCommandsMarkdown } from "./services/commands.js";
export { buildAugmentedUserContent, buildPreviewContextSuffix } from "./services/chat-content.js";

export type ServerState = {
  port: number;
  host: string;
  clients: Map<WebSocket, Client>;
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  config: Config;
};

export async function startServer(overrides?: {
  port?: number;
  host?: string;
  config?: Config;
  tenant?: TenantScope;
}): Promise<ServerState> {
  const tenant = overrides?.tenant;
  const boot = () => bootServer(overrides);
  return tenant ? runWithTenant(tenant, boot) : boot();
}

async function bootServer(overrides?: {
  port?: number;
  host?: string;
  config?: Config;
  tenant?: TenantScope;
}): Promise<ServerState> {
  const tenant = overrides?.tenant ?? currentTenant();
  const config = overrides?.config ?? await loadConfig();
  const logger = getLogger(tenant ? path.join(getInstallRoot(), "logs") : getPaths().logs);
  const host = overrides?.host ?? config.server.host;
  const port = overrides?.port ?? config.server.port;
  const hasUsers = hasActiveUser(await loadUsers());
  assertServerBindSafe({ host, accessToken: config.server.accessToken, hasUsers });
  initTools(config);

  const httpServer = createServer();
  // noServer: authenticate on upgrade before completing the handshake
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Client>();
  const broadcast = (message: ServerMessage): void => {
    const tenantId = currentTenant()?.id;
    for (const client of clients.values()) {
      if (tenantId && client.tenantId !== tenantId) continue;
      sendToClient(client, message);
    }
  };
  const inTenant = <T>(fn: () => T): T => (tenant ? runWithTenant(tenant, fn) : fn());

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/ws", `http://${host}:${port}`);
      const queryToken = extractAccessTokenFromUrl(url);
      wss.handleUpgrade(req, socket, head, (ws) => {
        inTenant(() => handleWebSocketConnection(ws, clients, config, logger, queryToken));
      });
    } catch (error) {
      logger.error(`WebSocket upgrade error: ${(error as Error).message}`);
      socket.destroy();
    }
  });

  const healthCheckInterval = setInterval(() => {
    for (const [ws, client] of clients.entries()) {
      if (!client.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      client.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  httpServer.on("close", () => clearInterval(healthCheckInterval));
  const handleRequest = createHttpHandler({ host, port, config, logger, broadcast });
  httpServer.on("request", (req, res) => {
    inTenant(() => {
      void handleRequest(req, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, resolve);
    httpServer.on("error", reject);
  });
  logger.info(`Server started on http://${host}:${port}`);
  logger.info(`WebSocket server ready at ws://${host}:${port}`);
  return { port, host, clients, httpServer, wss, config };
}

export async function stopServer(state: ServerState): Promise<void> {
  const { clients, httpServer, wss } = state;
  const logger = getLogger(getPaths().logs);
  for (const ws of clients.keys()) ws.close();
  clients.clear();
  wss.close();

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
    httpServer.closeAllConnections?.();
  });
  logger.info("Server stopped");
}
