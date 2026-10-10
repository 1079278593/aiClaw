/**
 * Session storage and management
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Message, Session } from "../types/index.js";
import { getPaths, ensureDirectories } from "../config/paths.js";
import { logger } from "../logger/index.js";
import { loadAppState } from "../app-state/index.js";

const SESSION_METADATA_ROLE = "system";
const DEFAULT_SESSION_TITLE = "New Chat";

export function generateId(): string {
  return randomBytes(16).toString("hex");
}

function getSessionPath(sessionId: string, conversationsDir: string): string {
  return path.join(conversationsDir, `${sessionId}.jsonl`);
}

function createMetadataMessage(session: Session): Message {
  return {
    id: "meta",
    role: SESSION_METADATA_ROLE,
    content: "",
    timestamp: session.createdAt,
    metadata: {
      title: session.title,
      sessionId: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastProvider: session.lastProvider,
      lastModel: session.lastModel,
      lastThinkingEffort: session.lastThinkingEffort,
    },
  };
}

export async function listSessions(userDataDir?: string): Promise<Session[]> {
  const paths = getPaths(userDataDir);
  await ensureDirectories(paths);
  const files = await fs.readdir(paths.conversations);

  const sessions: Session[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.replace(".jsonl", "");
    try {
      sessions.push(await loadSession(sessionId, userDataDir));
    } catch (error) {
      logger.warn(`Failed to load session ${sessionId}: ${(error as Error).message}`);
    }
  }

  return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function loadSession(sessionId: string, userDataDir?: string): Promise<Session> {
  const paths = getPaths(userDataDir);
  const sessionPath = getSessionPath(sessionId, paths.conversations);
  const content = await fs.readFile(sessionPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const messages: Message[] = [];
  let sessionMeta: {
    title: string;
    createdAt: string;
    updatedAt: string;
    lastProvider?: string;
    lastModel?: string;
    lastThinkingEffort?: string;
  } | null = null;

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Message;
      if (msg.role === SESSION_METADATA_ROLE && msg.id === "meta") {
        sessionMeta = {
          title: (msg.metadata?.title as string) || "Untitled",
          createdAt: (msg.metadata?.createdAt as string) || msg.timestamp,
          updatedAt: (msg.metadata?.updatedAt as string) || msg.timestamp,
          lastProvider: msg.metadata?.lastProvider as string | undefined,
          lastModel: msg.metadata?.lastModel as string | undefined,
          lastThinkingEffort: msg.metadata?.lastThinkingEffort as string | undefined,
        };
      } else {
        messages.push(msg);
      }
    } catch (error) {
      logger.warn(`Failed to parse message in ${sessionPath}: ${(error as Error).message}`);
    }
  }

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  return {
    id: sessionId,
    title: sessionMeta?.title || "Untitled",
    createdAt: sessionMeta?.createdAt || firstMsg?.timestamp || new Date().toISOString(),
    updatedAt: sessionMeta?.updatedAt || lastMsg?.timestamp || new Date().toISOString(),
    messages,
    lastProvider: sessionMeta?.lastProvider,
    lastModel: sessionMeta?.lastModel,
    lastThinkingEffort: sessionMeta?.lastThinkingEffort,
  };
}

export async function saveSession(session: Session, userDataDir?: string): Promise<void> {
  const paths = getPaths(userDataDir);
  await ensureDirectories(paths);
  const sessionPath = getSessionPath(session.id, paths.conversations);

  const lines = [JSON.stringify(createMetadataMessage(session)), ...session.messages.map((msg) => JSON.stringify(msg))];
  await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf-8");
  logger.debug(`Saved session ${session.id} with ${session.messages.length} messages`);
}

function normalizeSessionTitle(title?: string): string {
  return title?.trim() || "";
}

async function getAutoSessionTitle(userDataDir?: string, baseTitle: string = DEFAULT_SESSION_TITLE): Promise<string> {
  const sessions = await listSessions(userDataDir);
  const existingTitles = new Set(sessions.map((session) => session.title));

  if (!existingTitles.has(baseTitle)) return baseTitle;

  let index = 2;
  while (existingTitles.has(`${baseTitle} ${index}`)) {
    index += 1;
  }
  return `${baseTitle} ${index}`;
}

export async function createSession(title?: string, userDataDir?: string): Promise<Session> {
  const finalTitle = normalizeSessionTitle(title) || await getAutoSessionTitle(userDataDir);
  const now = new Date().toISOString();
  const session: Session = {
    id: generateId(),
    title: finalTitle,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await saveSession(session, userDataDir);
  logger.info(`Created session ${session.id}: ${finalTitle}`);
  return session;
}

export async function renameSession(sessionId: string, title: string, userDataDir?: string): Promise<Session> {
  const normalizedTitle = normalizeSessionTitle(title);
  if (!normalizedTitle) {
    throw new Error("Session title is required");
  }

  const session = await loadSession(sessionId, userDataDir);
  session.title = normalizedTitle;
  session.updatedAt = new Date().toISOString();
  await saveSession(session, userDataDir);
  logger.info(`Renamed session ${session.id}: ${normalizedTitle}`);
  return session;
}

export async function deleteSession(sessionId: string, userDataDir?: string): Promise<void> {
  const paths = getPaths(userDataDir);
  await fs.unlink(getSessionPath(sessionId, paths.conversations));
  logger.info(`Deleted session ${sessionId}`);
}

export async function addMessage(sessionId: string, message: Message, userDataDir?: string): Promise<Session> {
  const session = await loadSession(sessionId, userDataDir);
  session.messages.push(message);
  session.updatedAt = new Date().toISOString();
  await saveSession(session, userDataDir);
  return session;
}

export async function truncateSession(
  sessionId: string,
  messageId: string,
  userDataDir?: string,
): Promise<Session> {
  const session = await loadSession(sessionId, userDataDir);
  const index = session.messages.findIndex((msg) => msg.id === messageId);
  if (index === -1) {
    throw new Error(`Message ${messageId} not found in session ${sessionId}`);
  }
  session.messages = session.messages.slice(0, index);
  session.updatedAt = new Date().toISOString();
  await saveSession(session, userDataDir);
  logger.info(`Truncated session ${sessionId} at message ${messageId}, kept ${session.messages.length} messages`);
  return session;
}

export async function getInitialSession(userDataDir?: string): Promise<Session> {
  const sessions = await listSessions(userDataDir);
  const appState = await loadAppState(userDataDir);

  if (appState.lastActiveSessionId) {
    const existing = sessions.find((session) => session.id === appState.lastActiveSessionId);
    if (existing) return existing;
  }

  if (sessions.length > 0) {
    return sessions[0];
  }

  return createSession(undefined, userDataDir);
}
