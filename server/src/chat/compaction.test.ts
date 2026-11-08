import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { compactSession, BUILTIN_COMPACTION_PROMPT, CONSTRAINT_SECTION_HEADER } from "./compaction.js";
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
    commandcode: {
      apiKey: "",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      models: [{ id: "z-ai/glm-5.3-flash", label: "glm-5.3-flash" }],
    },
  },
  defaultProvider: "zai",
  defaultModel: "GLM-4.7",
  defaultThinkingEffort: "low",
  maxTokens: 4096,
  contextMaxTokens: 100_000,
  contextMaxMessages: 0,
  injectRootIndex: false,
      injectDistillMap: false,
      autoRefreshDistill: false,
  maxToolCalls: 10,
  server: { port: 3000, host: "127.0.0.1", accessToken: "", corsOrigins: [] },
  fs: { policy: { readable: ["inputs", "knowledge_base", "files"], writable: ["inputs", "knowledge_base", "files"], denied: [] }, allowedFiles: ["memory.md"] },
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

  const SUMMARY = "## 对话背景\n已讨论 token 压缩。\n\n## 未解问题\n无";

  beforeEach(async () => {
    testDir = await setupTestDir("compaction-test");
    mockComplete.mockReset();
    // 两步压缩：第 1 次是约束提取，第 2 次是摘要。默认没有约束。
    mockComplete.mockImplementation(async (_apiKey: string, messages: Message[]) => {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("逐字保留的约束")) {
        return { content: "无", finish_reason: "stop" };
      }
      return { content: SUMMARY, finish_reason: "stop" };
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
    const summaryCall = mockComplete.mock.calls.find((call) => {
      const messages = call[1] as Message[];
      return String(messages[0]?.content ?? "").includes("自定义压缩提示词");
    });
    expect(summaryCall).toBeTruthy();
    const messages = summaryCall![1] as Message[];
    expect(messages[0].content).toBe("自定义压缩提示词");
  });

  it("falls back to built-in prompt when prompt file is missing", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const paths = getPaths(testDir);
    await rm(paths.compactionPromptFile, { force: true });

    await compactSession(sessionId, mockConfig, testLogger(testDir));
    const summaryCall = mockComplete.mock.calls.find((call) => {
      const messages = call[1] as Message[];
      return String(messages[0]?.content ?? "") === BUILTIN_COMPACTION_PROMPT;
    });
    expect(summaryCall).toBeTruthy();
  });

  it("creates archive file in conversation_archive", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const paths = getPaths(testDir);

    await compactSession(sessionId, mockConfig, testLogger(testDir));
    const archiveFiles = await readdir(paths.conversationArchive);
    expect(archiveFiles.some((file) => file.startsWith(`${sessionId}_`) && file.endsWith(".jsonl"))).toBe(true);
  });

  it("11. 压缩后约束清单逐字保留在摘要里", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const constraints = [
      "所有 API 返回必须是 JSON，字段名用 camelCase。",
      "不要修改 knowledge_base/ 下的任何文件。",
    ];
    mockComplete.mockImplementation(async (_apiKey: string, messages: Message[]) => {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("逐字保留的约束")) {
        // 模型会加上列表前缀与围栏，规整后必须与原文一字不差。
        return { content: `\`\`\`\n- ${constraints[0]}\n- ${constraints[1]}\n\`\`\``, finish_reason: "stop" };
      }
      return { content: SUMMARY, finish_reason: "stop" };
    });

    const result = await compactSession(sessionId, mockConfig, testLogger(testDir));
    expect(result.constraints).toEqual(constraints);
    expect(result.constraintsExtracted).toBe(true);

    const session = await loadSession(sessionId, testDir);
    const summary = String(session.messages[1].content);
    expect(summary).toContain(CONSTRAINT_SECTION_HEADER);
    // 逐字：每条约束原文完整出现在摘要中，且带 "- " 前缀。
    for (const constraint of constraints) {
      expect(summary).toContain(`- ${constraint}`);
    }
    // 清单在摘要之后，不是插在中间。
    expect(summary.indexOf(CONSTRAINT_SECTION_HEADER)).toBeGreaterThan(summary.indexOf("未解问题"));
  });

  it("约束提取失败不阻塞压缩，退回单步摘要", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    let call = 0;
    mockComplete.mockImplementation(async (_apiKey: string, messages: Message[]) => {
      call += 1;
      const system = String(messages[0]?.content ?? "");
      if (system.includes("逐字保留的约束")) throw new Error("provider 500");
      return { content: SUMMARY, finish_reason: "stop" };
    });

    const result = await compactSession(sessionId, mockConfig, testLogger(testDir));
    expect(result.constraints).toEqual([]);
    expect(result.constraintsExtracted).toBe(false);
    expect(call).toBe(2);

    const session = await loadSession(sessionId, testDir);
    expect(session.messages[1].content).toBe(SUMMARY);
    expect(String(session.messages[1].content)).not.toContain(CONSTRAINT_SECTION_HEADER);
  });

  it("模型返回「无」时不加空小节", async () => {
    const sessionId = await createSessionWithMessages(testDir);
    const result = await compactSession(sessionId, mockConfig, testLogger(testDir));
    expect(result.constraints).toEqual([]);
    expect(result.constraintsExtracted).toBe(false);
    const session = await loadSession(sessionId, testDir);
    expect(String(session.messages[1].content)).toBe(SUMMARY);
  });
});
