/**
 * 端到端：mock provider → runAgenticLoopStreaming → chatStream，
 * 验证 tokenSpeed 事件真的会随流发出（服务端测速链路回归）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

vi.mock("../llm/index.js", () => ({
  createProvider: () => ({
    label: "zai",
    // 60ms × 8 块：首块后立即出第一个 tokenSpeed（节流计时器初始为 0）
    stream: async function* () {
      for (let i = 0; i < 8; i++) {
        yield { type: "content", text: "x".repeat(30) };
        await new Promise((r) => setTimeout(r, 60));
      }
      yield { type: "usage", usage: { inputTokens: 100, billingOutputTokens: 60, outputTokens: 60 } };
      return { finish_reason: "stop" };
    },
  }),
  resolveModelThinking: () => ({}),
  calcCost: () => 0,
}));

import { chatStream } from "./index.js";
import { createSession } from "../session/index.js";
import type { Config } from "../config/index.js";

const mockConfig = {
  providers: {
    zai: {
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ id: "GLM-4.7", label: "GLM-4.7" }],
    },
  },
  defaultProvider: "zai",
  defaultModel: "GLM-4.7",
  defaultThinkingEffort: "low",
  maxTokens: 4096,
  contextMaxTokens: 100_000,
  contextMaxMessages: 0,
  maxToolCalls: 10,
  server: { port: 3000, host: "127.0.0.1" },
  fs: { allowedDirs: ["inputs", "knowledge_base", "files"], allowedFiles: ["memory.md"] },
  compaction: {
    provider: "zai",
    model: "GLM-4.7",
    thinkingEffort: "off",
    keepRecentRounds: 0,
    triggerTokens: 80_000,
    keepRecentTokens: 20_000,
    summaryMaxTokens: 8192,
  },
} as unknown as Config;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chatStream tokenSpeed 端到端", () => {
  let testDir: string;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), ".test-data", `chat-speed-${randomBytes(8).toString("hex")}`);
    process.env.AICLAW_DATA_DIR = testDir;
    await mkdir(path.join(testDir, "files", "prompts"), { recursive: true });
    const session = await createSession("Speed Test", testDir);
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("生成过程中发出 tokenSpeed 事件，结束时附带真实 outputTokens", async () => {
    const gen = chatStream(sessionId, "Hello", mockConfig, {});
    const events: Array<{ done: boolean; hasSpeed: boolean; speed?: { totalTokens: number; outputTokens?: number } }> =
      [];

    for await (const item of gen) {
      if (item.tokenSpeed) {
        events.push({ done: item.done, hasSpeed: true, speed: item.tokenSpeed });
      }
    }

    // 流中至少一次实时快照
    const live = events.filter((e) => !e.done);
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live[0].speed!.totalTokens).toBeGreaterThan(0);

    // 结束快照带真实 outputTokens
    const final = events.find((e) => e.done);
    expect(final).toBeDefined();
    expect(final!.speed!.outputTokens).toBeGreaterThan(0);
  });
});

// 避免 TS 对未使用工具的抱怨
void sleep;
