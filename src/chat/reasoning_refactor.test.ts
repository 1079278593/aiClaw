import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/index.js";
import { createSession, loadSession } from "../session/index.js";
import { clearTools, registerTool } from "../tools/registry.js";

const { completeMock, streamMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  streamMock: vi.fn(),
}));

vi.mock("../llm/index.js", async () => {
  const actual = await vi.importActual("../llm/index.js");
  return {
    ...actual,
    createProvider: () => ({
      complete: completeMock,
      stream: streamMock,
    }),
  };
});

const { chat, chatStream } = await import("./index.js");

const mockConfig: Config = {
  providers: {
    zai: {
      apiKey: "test-api-key-mock",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [
        { id: "GLM-4.5-Air", label: "GLM-4.5-Air" },
        { id: "GLM-4.7", label: "GLM-4.7" },
      ],
    },
    dashscope: {
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [
        { id: "qwen3.6-plus", label: "qwen3.6-plus" },
      ],
    },
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      models: [
        { id: "deepseek-v4-flash", label: "v4-flash" },
      ],
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
  compaction: { provider: "zai", model: "glm-4.5-air", thinkingEffort: "off", keepRecentRounds: 0 },
};

describe("reasoning refactor", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), ".test-data", `reasoning-refactor-${randomBytes(8).toString("hex")}`);
    process.env.HYXCLAW_DATA_DIR = testDir;
    await mkdir(path.join(testDir, "files", "prompts"), { recursive: true });
    clearTools();
    completeMock.mockReset();
    streamMock.mockReset();
  });

  afterEach(async () => {
    clearTools();
    await rm(testDir, { recursive: true, force: true });
  });

  it("keeps reasoning_content within the loop and persists it to disk", async () => {
    const session = await createSession("Reasoning Test", testDir);

    registerTool({
      name: "get_weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
      async execute() {
        return { content: "晴天 25C" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: null,
        finish_reason: "tool_calls",
        reasoning_content: "先调用天气工具",
        tool_calls: [{
          id: "tool-1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: JSON.stringify({ city: "杭州" }),
          },
        }],
        usage: undefined,
      })
      .mockImplementationOnce(async (_apiKey, messages) => {
        const assistantWithToolCall = messages.findLast((message: { role: string; tool_calls?: unknown; reasoning_content?: string }) => message.role === "assistant" && message.tool_calls);
        expect(assistantWithToolCall?.reasoning_content).toBe("先调用天气工具");

        return {
          content: "杭州今天晴天 25C。",
          finish_reason: "stop",
          reasoning_content: "根据工具结果组织最终回答",
          tool_calls: undefined,
          usage: undefined,
        };
      });

    const result = await chat(session.id, "杭州天气怎么样？", mockConfig);
    expect(result.assistantMessage.content).toBe("杭州今天晴天 25C。");

    const persisted = await loadSession(session.id, testDir);
    const persistedAssistantWithToolCall = persisted.messages.find((message) => message.role === "assistant" && message.tool_calls);

    expect(persistedAssistantWithToolCall).toBeDefined();
    expect(persistedAssistantWithToolCall?.reasoning_content).toBe("先调用天气工具");

    // Final assistant message should also persist its reasoning
    const finalAssistant = persisted.messages.find((message) => message.role === "assistant" && !message.tool_calls && message.content === "杭州今天晴天 25C。");
    expect(finalAssistant).toBeDefined();
    expect(finalAssistant?.reasoning_content).toBe("根据工具结果组织最终回答");

    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it("does not report a tool limit when the model returns only reasoning", async () => {
    const session = await createSession("Reasoning Only Test", testDir);
    completeMock.mockResolvedValueOnce({
      content: null,
      finish_reason: "stop",
      reasoning_content: "已完成文件修改。",
      usage: undefined,
    });

    const result = await chat(session.id, "修改文件", mockConfig);
    expect(result.assistantMessage.content).toBe("（模型未返回可见文本）");
    expect(result.assistantMessage.reasoning_content).toBe("已完成文件修改。");

    const persisted = await loadSession(session.id, testDir);
    const finalAssistant = persisted.messages.at(-1);
    expect(finalAssistant?.content).toBe("（模型未返回可见文本）");
    expect(finalAssistant?.reasoning_content).toBe("已完成文件修改。");
  });

  it("does not report a tool limit for a streaming reasoning-only response", async () => {
    const session = await createSession("Streaming Reasoning Only Test", testDir);
    streamMock.mockImplementationOnce(async function* () {
      yield { type: "reasoning" as const, text: "已完成文件修改。" };
      return { finish_reason: "stop" };
    });

    const stream = chatStream(session.id, "修改文件", mockConfig);
    const chunks: Array<{ chunk: string; done: boolean; reasoning?: boolean }> = [];
    while (true) {
      const item = await stream.next();
      if (item.done) break;
      chunks.push(item.value);
    }

    expect(chunks).toContainEqual({ chunk: "已完成文件修改。", done: false, reasoning: true });
    expect(chunks).toContainEqual({ chunk: "（模型未返回可见文本）", done: false });

    const persisted = await loadSession(session.id, testDir);
    const finalAssistant = persisted.messages.at(-1);
    expect(finalAssistant?.content).toBe("（模型未返回可见文本）");
    expect(finalAssistant?.reasoning_content).toBe("已完成文件修改。");
  });

  it("reports the tool limit only when the loop actually reaches it", async () => {
    const session = await createSession("Tool Limit Test", testDir);
    registerTool({
      name: "get_weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { content: "晴天" };
      },
    });
    completeMock.mockResolvedValueOnce({
      content: null,
      finish_reason: "tool_calls",
      tool_calls: [{
        id: "tool-1",
        type: "function",
        function: { name: "get_weather", arguments: "{}" },
      }],
      usage: undefined,
    });

    const result = await chat(session.id, "查天气", { ...mockConfig, maxToolCalls: 1 });
    expect(result.assistantMessage.content).toBe("（已达到最大工具调用次数）");
    expect(completeMock).toHaveBeenCalledTimes(1);
  });
});
