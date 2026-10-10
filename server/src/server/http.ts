import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/index.js";
import type { getLogger } from "../logger/index.js";
import {
  applyCorsHeaders,
  authRequired,
  handleCorsPreflight,
  isLoopbackHost,
  requireHttpAuth,
} from "./auth.js";
import type { ServerMessage } from "./protocol.js";
import { handleContentRoutes } from "./routes/content.js";
import { handleGitSyncRoutes } from "./routes/git-sync.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { handleSystemRoutes } from "./routes/system.js";
import { handleStaticRequest } from "./static-assets.js";

export function createHttpHandler(options: {
  host: string;
  port: number;
  config: Config;
  logger: ReturnType<typeof getLogger>;
  broadcast: (message: ServerMessage) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { host, port, config, logger, broadcast } = options;
  const gitSyncEnabled = isLoopbackHost(host);
  const routes = [handleSystemRoutes, handleGitSyncRoutes, handleSessionRoutes, handleContentRoutes];

  return async (req, res) => {
    try {
      const url = new URL(req.url || "", `http://${host}:${port}`);
      applyCorsHeaders(req, res, config.server.corsOrigins);
      if (handleCorsPreflight(req, res, config.server.corsOrigins)) return;

      // Public health (no auth) — used by clients to learn authRequired.
      if (url.pathname === "/health" && req.method === "GET") {
        const { sendJson } = await import("./http-types.js");
        sendJson(res, {
          status: "ok",
          authRequired: authRequired(config.server),
        });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!requireHttpAuth(req, res, config.server)) return;
      }

      for (const route of routes) {
        if (await route({ req, res, url, config, gitSyncEnabled, logger, broadcast })) return;
      }
      if (url.pathname.startsWith("/api/")) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (await handleStaticRequest(url.pathname, res, logger)) return;
      res.statusCode = 404;
      res.end("Not found");
    } catch (error) {
      logger.error(`HTTP request error: ${(error as Error).message}`);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  };
}
