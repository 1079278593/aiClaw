import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/index.js";
import type { getLogger } from "../logger/index.js";
import type { Session } from "../types/index.js";
import type { ServerMessage } from "./protocol.js";

export type HttpContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  config: Config;
  gitSyncEnabled: boolean;
  logger: ReturnType<typeof getLogger>;
  broadcast: (message: ServerMessage) => void;
};

export type RouteHandler = (context: HttpContext) => Promise<boolean>;

export function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export async function readJsonBody<T extends object = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return (body ? JSON.parse(body) : {}) as T;
}

export function toSessionMessage(session: Session): Extract<ServerMessage, { type: "sessionLoaded" }> {
  return {
    type: "sessionLoaded",
    session: {
      id: session.id,
      title: session.title,
      messages: session.messages,
      lastProvider: session.lastProvider,
      lastModel: session.lastModel,
      lastThinkingEffort: session.lastThinkingEffort,
    },
  };
}
