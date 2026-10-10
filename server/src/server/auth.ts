/**
 * Multi-client access control: Bearer token for HTTP, query token for WebSocket.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "../config/schema.js";
import { sendJson } from "./http-types.js";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

export function authRequired(server: Pick<ServerConfig, "accessToken">): boolean {
  return Boolean(server.accessToken);
}

/**
 * Non-loopback binds must set accessToken to avoid exposing the API unauthenticated.
 */
export function assertServerBindSafe(server: Pick<ServerConfig, "host" | "accessToken">): void {
  if (!isLoopbackHost(server.host) && !server.accessToken) {
    throw new Error(
      `server.host is '${server.host}' (non-loopback) but server.accessToken is empty.\n` +
        `Set a strong accessToken in config.json before binding to a public interface.`,
    );
  }
}

export function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export function extractAccessTokenFromUrl(url: URL): string | undefined {
  return (
    url.searchParams.get("access_token")?.trim() ||
    url.searchParams.get("token")?.trim() ||
    undefined
  );
}

export function isAuthorizedToken(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!expected) return true;
  return Boolean(provided) && provided === expected;
}

/** Returns true if the request may proceed; otherwise writes 401 and returns false. */
export function requireHttpAuth(
  req: IncomingMessage,
  res: ServerResponse,
  server: Pick<ServerConfig, "accessToken">,
): boolean {
  if (!authRequired(server)) return true;
  const token = extractBearerToken(req);
  if (isAuthorizedToken(token, server.accessToken)) return true;
  sendJson(res, { error: "Unauthorized" }, 401);
  return false;
}

export function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigins: string[],
): void {
  if (!corsOrigins.length) return;
  const origin = req.headers.origin;
  const allowAll = corsOrigins.includes("*");
  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    return;
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function handleCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigins: string[],
): boolean {
  if (req.method !== "OPTIONS" || !corsOrigins.length) return false;
  applyCorsHeaders(req, res, corsOrigins);
  res.statusCode = 204;
  res.end();
  return true;
}
