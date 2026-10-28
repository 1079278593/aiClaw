import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfigWithoutApiKey, type Config } from "../config/index.js";
import type { getLogger } from "../logger/index.js";
import { authIsRequired, resolveTenantToken } from "../tenant/access.js";
import { runWithTenant } from "../tenant/store.js";
import { initTools } from "../tools/index.js";
import {
  applyCorsHeaders,
  extractBearerToken,
  handleCorsPreflight,
  isLoopbackHost,
} from "./auth.js";
import type { ServerMessage } from "./protocol.js";
import { handleContentRoutes } from "./routes/content.js";
import { handleGitSyncRoutes } from "./routes/git-sync.js";
import { handlePeopleRoutes } from "./routes/people.js";
import { handleReflectionsRoutes } from "./routes/reflections.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { handleSystemRoutes } from "./routes/system.js";
import { consumeRateLimit, HTTP_LIMIT_PER_MINUTE } from "./rate-limit.js";
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
  const routes = [handleSystemRoutes, handleGitSyncRoutes, handleSessionRoutes, handlePeopleRoutes, handleReflectionsRoutes, handleContentRoutes];

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
          authRequired: await authIsRequired(config.server.accessToken),
        });
        return;
      }

      let requestConfig = config;
      const runRoutes = async () => {
        for (const route of routes) {
          if (await route({ req, res, url, config: requestConfig, gitSyncEnabled, logger, broadcast })) return;
        }
        if (url.pathname.startsWith("/api/")) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Not found" }));
        }
      };

      if (url.pathname.startsWith("/api/")) {
        if (await authIsRequired(config.server.accessToken)) {
          const identity = await resolveTenantToken(extractBearerToken(req), config.server.accessToken);
          if (!identity) {
            const { sendJson } = await import("./http-types.js");
            sendJson(res, { error: "Unauthorized" }, 401);
            return;
          }
          const limit = consumeRateLimit(`http:${identity.id}`, HTTP_LIMIT_PER_MINUTE);
          if (!limit.allowed) {
            const { sendJson } = await import("./http-types.js");
            res.setHeader("Retry-After", String(limit.retryAfterSec));
            sendJson(res, { error: "请求过于频繁，请稍后再试" }, 429);
            return;
          }
          requestConfig = await loadConfigWithoutApiKey(identity.base);
          requestConfig.server = config.server;
          await runWithTenant(identity, async () => {
            initTools(requestConfig);
            await runRoutes();
          });
          return;
        }
      }

      await runRoutes();
      if (res.writableEnded) return;
      if (url.pathname.startsWith("/api/")) return;
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
