/**
 * 心得会话的上下文装配（context_governance_plan §2）。
 *
 * 单元测试证明了「游标之后进窗口」这套函数行为正确；这里再确认它真的接进了
 * `chatStream`：否则实现得再对，请求里发的东西也不会变。
 *
 * 两条最容易返工的断言：
 * 1. 未到 8000 token 时，游标之外、最近 2 轮之前的原文**仍然**发给模型；
 * 2. 折叠之后，游标之前的原文不再出现，只多出「当前有效」一块。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types/index.js";
import { getPaths, ensureDirectories } from "../config/paths.js";
import { saveSession } from "../session/index.js";
import { saveAppState } from "../app-state/index.js";
import { saveDialogueState } from "./dialogue-state.js";

let dir = "";
/** 每次调用 provider 时实际收到的消息，用于断言「发了什么」。 */
const captured: Message[][] = [];

const fakeProvider = {
  label: "fake",
  async complete(_key: string, messages: Message[]) {
    captured.push(messages);
    return { content: "好的", finish_reason: "stop" };
  },
  async *stream(_key: string, messages: Message[]) {
    captured.push(messages);
    yield { type: "content" as const, text: "好的" };
    return { finish_reason: "stop" };
  },
};

vi.mock("../llm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/index.js")>("../llm/index.js");
  return { ...actual, createProvider: () => fakeProvider };
});

const config = {
  providers: {
    zai: {
      apiKey: "k",
      baseUrl: "https://example.invalid",
      models: [{ id: "glm-4.5-air", label: "x", contextWindow: 200_000 }],
    },
  },
  defaultProvider: "zai",
  defaultModel: "glm-4.5-air",
  defaultThinkingEffort: "off",
  maxTokens: 4096,
  contextMaxTokens: 100_000,
  contextMaxMessages: 0,
  injectRootIndex: false,
  injectDistillMap: false,
  autoRefreshDistill: false,
  autoOrganize: false,
  autoOrganizeCadence: "message",
  autoOrganizeDebounceMs: 0,
  autoOrganizeMinUnits: 0,
  maxToolCalls: 10,
  server: { port: 3000, host: "127.0.0.1", accessToken: "", corsOrigins: [] },
  fs: { policy: { readable: [], writable: [], denied: [] }, allowedFiles: [] },
  tools: { tavily: { enabled: false }, trilium: { enabled: false } },
  compaction: { provider: "zai", model: "glm-4.5-air", thinkingEffort: "off", keepRecentRounds: 0 },
};

function msg(id: string, role: Message["role"], content: string): Message {
  return { id, role, content, timestamp: "2026-11-19T00:00:00.000Z" };
}

async function seedSession(sessionId: string, messages: Message[]) {
  await saveSession({
    id: sessionId,
    title: "心得",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    messages,
  }, dir);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aiclaw-reflect-"));
  process.env.AICLAW_DATA_DIR = dir;
  await ensureDirectories(getPaths(dir));
  captured.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("心得会话的窗口装配", () => {
  it("未到 8000 token：中间那几轮原文仍然发给模型", async () => {
    const { chatStream } = await import("./index.js");
    await saveAppState({ reflectionsSessionId: "r1", recentModels: [] }, dir);
    await seedSession("r1", [
      msg("u1", "user", "第一问的独特标记"),
      msg("a1", "assistant", "第一答"),
      msg("u2", "user", "第二问的独特标记"),
      msg("a2", "assistant", "第二答"),
      msg("u3", "user", "第三问的独特标记"),
      msg("a3", "assistant", "第三答"),
      msg("u4", "user", "第四问的独特标记"),
      msg("a4", "assistant", "第四答"),
    ]);

    for await (const _chunk of chatStream("r1", "第五问", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }

    const payload = captured[0]?.map((message) => String(message.content)).join("\n") ?? "";
    // 最近 2 轮的保护区之外，第 1、2 轮也还在：它们没到 8000，也还没被折叠。
    expect(payload).toContain("第一问的独特标记");
    expect(payload).toContain("第二问的独特标记");
    expect(payload).toContain("第五问");
  });

  it("折叠之后：游标之前的原文不再发送，改为注入「当前有效」", async () => {
    const { chatStream } = await import("./index.js");
    await saveAppState({ reflectionsSessionId: "r2", recentModels: [] }, dir);
    await saveDialogueState("r2", {
      current: "## 硬约束\n必须用 pnpm",
      history: [],
      foldedThrough: "a2",
    }, dir);
    await seedSession("r2", [
      msg("u1", "user", "第一问的独特标记"),
      msg("a1", "assistant", "第一答"),
      msg("u2", "user", "第二问的独特标记"),
      msg("a2", "assistant", "第二答"),
      msg("u3", "user", "第三问的独特标记"),
      msg("a3", "assistant", "第三答"),
      msg("u4", "user", "第四问的独特标记"),
      msg("a4", "assistant", "第四答"),
    ]);

    for await (const _chunk of chatStream("r2", "第五问", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }

    const systemText = (captured[0] ?? [])
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    const payload = (captured[0] ?? []).map((message) => String(message.content)).join("\n");

    expect(systemText).toContain("必须用 pnpm");
    expect(payload).not.toContain("第一问的独特标记");
    expect(payload).not.toContain("第二问的独特标记");
    // 游标之后（含保护区）继续以原文发送。
    expect(payload).toContain("第三问的独特标记");
    expect(payload).toContain("第四问的独特标记");
  });

  it("其它会话不受影响：旧原文照常全部发送，也不注入对话状态", async () => {
    const { chatStream } = await import("./index.js");
    await saveAppState({ reflectionsSessionId: "r3", recentModels: [] }, dir);
    await saveDialogueState("r3", { current: "只属于心得会话", history: [], foldedThrough: "a1" }, dir);
    await seedSession("other", [
      msg("u1", "user", "普通会话第一问"),
      msg("a1", "assistant", "第一答"),
      msg("u2", "user", "普通会话第二问"),
      msg("a2", "assistant", "第二答"),
    ]);

    for await (const _chunk of chatStream("other", "第三问", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }

    const payload = (captured[0] ?? []).map((message) => String(message.content)).join("\n");
    expect(payload).toContain("普通会话第一问");
    expect(payload).not.toContain("只属于心得会话");
  });
});
