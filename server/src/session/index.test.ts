/**
 * Session module tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  generateId,
  createSession,
  loadSession,
  saveSession,
  deleteSession,
  addMessage,
  listSessions,
  getInitialSession,
  renameSession,
} from "./index.js";
import { setLastActiveSession } from "../app-state/index.js";

const testDir = path.join(process.cwd(), ".test-data", `session-test-${randomBytes(8).toString("hex")}`);

describe("session", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("generateId returns unique 32-char hex ids", () => {
    const a = generateId();
    const b = generateId();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it("createSession persists and loadSession restores metadata", async () => {
    const session = await createSession("Test Session", testDir);
    session.lastProvider = "dashscope";
    session.lastModel = "qwen3.6-plus";
    await saveSession(session, testDir);

    const loaded = await loadSession(session.id, testDir);
    expect(loaded.title).toBe("Test Session");
    expect(loaded.lastProvider).toBe("dashscope");
    expect(loaded.lastModel).toBe("qwen3.6-plus");
  });

  it("createSession auto-generates unique titles when title is omitted", async () => {
    const first = await createSession(undefined, testDir);
    const second = await createSession(undefined, testDir);

    expect(first.title).toBe("New Chat");
    expect(second.title).toBe("New Chat 2");
  });

  it("addMessage appends to session and updates timestamp", async () => {
    const session = await createSession("Test", testDir);
    const originalUpdatedAt = session.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await addMessage(session.id, {
      id: "m1",
      role: "user",
      content: "Hello",
      timestamp: new Date().toISOString(),
    }, testDir);

    expect(updated.messages).toHaveLength(1);
    expect(updated.updatedAt).not.toBe(originalUpdatedAt);
  });

  it("listSessions sorts by updatedAt descending", async () => {
    const first = await createSession("First", testDir);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await createSession("Second", testDir);

    const sessions = await listSessions(testDir);
    expect(sessions[0].id).toBe(second.id);
    expect(sessions[1].id).toBe(first.id);
  });

  it("deleteSession removes session file", async () => {
    const session = await createSession("Delete Me", testDir);
    await deleteSession(session.id, testDir);
    await expect(loadSession(session.id, testDir)).rejects.toThrow();
  });

  it("renameSession updates persisted title", async () => {
    const session = await createSession("Before Rename", testDir);
    await renameSession(session.id, "After Rename", testDir);

    const loaded = await loadSession(session.id, testDir);
    expect(loaded.title).toBe("After Rename");
  });

  it("renameSession rejects blank titles", async () => {
    const session = await createSession("Keep Me", testDir);
    await expect(renameSession(session.id, "   ", testDir)).rejects.toThrow("Session title is required");
  });

  it("getInitialSession restores last active session when valid", async () => {
    const older = await createSession("Older", testDir);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = await createSession("Newer", testDir);
    await setLastActiveSession(older.id, testDir);

    const initial = await getInitialSession(testDir);
    expect(initial.id).toBe(older.id);
    expect(initial.id).not.toBe(newer.id);
  });

  it("getInitialSession falls back to newest session when app state missing", async () => {
    const first = await createSession("First", testDir);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await createSession("Second", testDir);

    const initial = await getInitialSession(testDir);
    expect(initial.id).toBe(second.id);
    expect(initial.id).not.toBe(first.id);
  });

  it("getInitialSession creates New Chat when no sessions exist", async () => {
    const initial = await getInitialSession(testDir);
    expect(initial.title).toBe("New Chat");
    expect(initial.messages).toEqual([]);
  });
});
