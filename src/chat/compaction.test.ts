import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { compactSession, BUILTIN_COMPACTION_PROMPT } from "./compaction.js";
import { createSession, addMessage, loadSession } from "../session/index.js";
import { getPaths } from "../config/paths.js";
import { setupTestDir, cleanupTestDir } from "../test-utils.js";
import type { Config } from "../config/index.js";
import type { Message } from "../types/index.js";
import { Logger } from "../logger/index.js";

const mockComplete = vi.fn();

vi.mock("../llm/index.js", () => ({
  createProvider: () => ({
    complete: mockComplete,
  }),
}));

const mockConfig: Config = {
  providers: {
    zai: {
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ id: "GLM-4.5-Air", label: "GLM-4.5-Air" }],
    },
    dashscope: {
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [{ id: "qwen3.6-plus", label: "qwen3.6-plus" }],
    },
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "deepseek-v4-flash", label: "v4-flash" }],
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
  tools: {
    tavily: {
      enabled: false,
      apiKey: "",
      baseUrl: "https://api.tavily.com",
      searchDepth: "basic",
      maxResults: 10,
      includeAnswer: false,
      includeRawContent: false,
      includeUsage: false,
      timeoutMs: 30_000,
      maxSearchContentChars: 2000,
      fetchDepth: "basic",
      fetchFormat: "markdown",
      maxFetchedChars: 20_000,
    },
    trilium: {
      enabled: false,
      baseUrl: "http://127.0.0.1:8080",
      token: "",
      ancestorNoteId: "",
      timeoutMs: 15_000,
    },
  },
  compaction: { provider: "zai", model: "GLM-4.5-Air", thinkingEffort: "off", keepRecentRounds: 0 },
};

function testLogger(testDir: string): Logger {
  return new Logger({ logDir: path.join(testDir, "logs"), enableConsole: false });
}

async function createSessionWithMessages(testDir: string): Promise<string> {
  const session = await createSession("Compaction Test", testDir);
  const first: Message = {
    id: "m1",
    role: "user",
    content: "你好，我们讨论一下 token 压缩。",
    timestamp: "2026-04-23T00:00:00.000Z",
  };
  const second: Message = {
    id: "m2",
    role: "assistant",
    content: "好的，可以用摘要替换长上下文。",
    timestamp: "2026-04-23T00:00:01.000Z",
  };
  await addMessage(session.id, first, testDir);
  await addMessage(session.id, second, testDir);
  return session.id;
}

describe("compactSession", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestDir("compaction-test");
    mockComplete.mockReset();
    mockComplete.mockResolvedValue({
      content: "## 对话背景\n已讨论 token 压缩。\n\n## 未解问题\n无",
      finish_reason: "stop",
    });
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("throws if session has fewer than 2 messages", async () => {
    const session = await createSession("Too Short", testDir);
    await expect(compactSession(session.id, mockConfig, testLogger(testDir))).rejects.toThrow("Session has fewer than 2 messages");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("archives original file before overwrite", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const paths = getPaths(testDir);
    const original = await readFile(path.join(paths.conversations, `${sessionId}.jsonl`), "utf-8");

    const result = await compactSession(sessionId, mockConfig, testLogger(testDir));
    const archived = await readFile(path.join(paths.conversationArchive, result.archivedAs), "utf-8");
    expect(archived).toBe(original);
  });

  it("writes two messages after compaction", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    await compactSession(sessionId, mockConfig, testLogger(testDir));

    const session = await loadSession(sessionId, testDir);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].content).toContain("token 压缩");
  });

  it("uses compaction_prompt.txt when present", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const paths = getPaths(testDir);
    await mkdir(path.dirname(paths.compactionPromptFile), { recursive: true });
    await writeFile(paths.compactionPromptFile, "自定义压缩提示词", "utf-8");

    await compactSession(sessionId, mockConfig, testLogger(testDir));
    const messages = mockComplete.mock.calls[0][1] as Message[];
    expect(messages[0].content).toBe("自定义压缩提示词");
  });

  it("falls back to built-in prompt when prompt file is missing", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const paths = getPaths(testDir);
    await rm(paths.compactionPromptFile, { force: true });

    await compactSession(sessionId, mockConfig, testLogger(testDir));
    const messages = mockComplete.mock.calls[0][1] as Message[];
    expect(messages[0].content).toBe(BUILTIN_COMPACTION_PROMPT);
  });

  it("creates archive file in conversation_archive", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const paths = getPaths(testDir);

    await compactSession(sessionId, mockConfig, testLogger(testDir));
    const archiveFiles = await readdir(paths.conversationArchive);
    expect(archiveFiles.some((file) => file.startsWith(`${sessionId}_`) && file.endsWith(".jsonl"))).toBe(true);
  });
});
