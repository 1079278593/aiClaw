/**
 * Chat module tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { chat, chatStream, truncateMessagesForContext, getChatContextPreview, sanitizeHistoryForProvider, loadSystemPrompt, loadRootIndexForInjection, buildSystemBlocks, ROOT_INDEX_TOKEN_MAX } from "./index.js";
import { getPaths } from "../config/paths.js";
import { createSession } from "../session/index.js";
import type { Message, Session } from "../types/index.js";
import type { Config } from "../config/index.js";

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
  compaction: { provider: "zai", model: "glm-4.5-air", thinkingEffort: "off", keepRecentRounds: 0 },
};

describe("chat", () => {
  let testDir: string;
  let session: Session;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), ".test-data", `chat-test-${randomBytes(8).toString("hex")}`);
    process.env.AICLAW_DATA_DIR = testDir;
    await mkdir(path.join(testDir, "files", "prompts"), { recursive: true });
    session = await createSession("Test Chat", testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("truncateMessagesForContext keeps all messages within limit", () => {
    const result = truncateMessagesForContext([
      { id: "1", role: "user", content: "Hello", timestamp: "2024-01-01T00:00:00Z" },
      { id: "2", role: "assistant", content: "Hi", timestamp: "2024-01-01T00:00:01Z" },
    ], 1000);

    expect(result).toHaveLength(2);
  });

  it("truncateMessagesForContext keeps latest message under tight token limit", () => {
    const result = truncateMessagesForContext([
      { id: "1", role: "user", content: "A".repeat(100), timestamp: "2024-01-01T00:00:00Z" },
      { id: "2", role: "assistant", content: "B".repeat(100), timestamp: "2024-01-01T00:00:01Z" },
      { id: "3", role: "user", content: "C".repeat(100), timestamp: "2024-01-01T00:00:02Z" },
    ], 50);

    expect(result[result.length - 1].content).toBe("C".repeat(100));
  });

  it("getChatContextPreview returns empty hint for empty session", () => {
    expect(getChatContextPreview(session)).toBe("(empty session)");
  });

  it("sanitizeHistoryForProvider keeps reasoning_content for all models, strips only images for non-vision models", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "查天气", timestamp: "2024-01-01T00:00:00Z" },
      {
        id: "2",
        role: "assistant",
        content: null,
        timestamp: "2024-01-01T00:00:01Z",
        tool_calls: [{ id: "tool-1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"杭州\"}" } }],
        reasoning_content: "先调用工具",
      },
      { id: "3", role: "tool", content: "晴天 25C", timestamp: "2024-01-01T00:00:02Z", tool_call_id: "tool-1" },
      { id: "4", role: "assistant", content: "杭州今天晴天 25C。", timestamp: "2024-01-01T00:00:03Z", reasoning_content: "整理结果" },
    ];

    // 所有 provider 都保留历史 reasoning_content
    for (const provider of ["zai", "dashscope", "deepseek"] as const) {
      const result = sanitizeHistoryForProvider([...messages], true);
      expect(result).toHaveLength(4);
      expect(result[1].tool_calls).toBeDefined();
      expect(result[1].reasoning_content).toBe("先调用工具");
      expect(result[3].reasoning_content).toBe("整理结果");
      void provider;
    }

    // thinking off 也不影响历史 reasoning 保留
    const offMessages = sanitizeHistoryForProvider([...messages], true);
    expect(offMessages[1].reasoning_content).toBe("先调用工具");
  });

  it("sanitizeHistoryForProvider strips image parts for non-vision models", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc", path: "inputs/a.png" } },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "2",
        role: "assistant",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,def", path: "inputs/b.png" } },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const sanitized = sanitizeHistoryForProvider(messages, false);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].content).toEqual([{ type: "text", text: "看看这张图" }]);
  });

  it("chat rejects when real LLM call cannot complete in test", async () => {
    await expect(chat(session.id, "Hello", mockConfig)).rejects.toThrow();
  }, 30_000);

  it("chatStream exposes async iterator and accepts thinkingEffort", () => {
    const generator = chatStream(session.id, "Hello", mockConfig, { thinkingEffort: "medium" });
    expect(typeof generator[Symbol.asyncIterator]).toBe("function");
  });

  it("8.1 系统提示词单一来源：AGENT.md 存在时优先于 files/prompts", async () => {
    const { writeFile } = await import("node:fs/promises");
    const paths = getPaths(testDir);
    await mkdir(paths.agentsMain, { recursive: true });
    await writeFile(paths.agentSystemPromptFile, "旧宪法", "utf-8");
    await writeFile(paths.agentConstitutionFile, "新宪法：只看 AGENT.md", "utf-8");

    const prompt = await loadSystemPrompt(mockConfig);
    expect(prompt).toContain("新宪法：只看 AGENT.md");
    expect(prompt).not.toContain("旧宪法");
  });

  it("8.1 AGENT.md 缺失时回退到 files/prompts（旧装兼容）", async () => {
    const { writeFile } = await import("node:fs/promises");
    const paths = getPaths(testDir);
    await mkdir(paths.agentsMain, { recursive: true });
    await writeFile(paths.agentSystemPromptFile, "旧宪法", "utf-8");

    const prompt = await loadSystemPrompt(mockConfig);
    expect(prompt).toContain("旧宪法");
  });

  it("8.1 AGENT.md 为空文件时继续回退，而不是把空内容当宪法", async () => {
    const { writeFile } = await import("node:fs/promises");
    const paths = getPaths(testDir);
    await mkdir(paths.agentsMain, { recursive: true });
    await writeFile(paths.agentConstitutionFile, "   \n  ", "utf-8");
    await writeFile(paths.agentSystemPromptFile, "旧宪法", "utf-8");

    const prompt = await loadSystemPrompt(mockConfig);
    expect(prompt).toContain("旧宪法");
  });

  it("5.7 injectRootIndex 默认关闭时不注入根索引", async () => {
    const { writeFile } = await import("node:fs/promises");
    const paths = getPaths(testDir);
    await mkdir(paths.reflections, { recursive: true });
    await writeFile(path.join(paths.reflections, "_index.md"), "inbox/\n第一篇.md\n", "utf-8");

    expect(await loadRootIndexForInjection(false)).toBeNull();
    expect(buildSystemBlocks("策略", null).map((block) => block.name)).toEqual(["policy"]);
  });

  it("5.7 打开后注入根索引，并进 rootIndex 块", async () => {
    const { writeFile } = await import("node:fs/promises");
    const paths = getPaths(testDir);
    await mkdir(paths.reflections, { recursive: true });
    await writeFile(path.join(paths.reflections, "_index.md"), "inbox/\n第一篇.md\n", "utf-8");

    const injected = await loadRootIndexForInjection(true);
    expect(injected).toContain("第一篇.md");
    const blocks = buildSystemBlocks("策略", injected);
    expect(blocks.map((block) => block.name)).toEqual(["rootIndex", "policy"]);
    expect(blocks[0].max).toBe(ROOT_INDEX_TOKEN_MAX);
  });

  it("5.7 根索引超过 1 KB 时放弃注入（不截断成半张地图）", async () => {
    const { writeFile } = await import("node:fs/promises");
    const paths = getPaths(testDir);
    await mkdir(paths.reflections, { recursive: true });
    // 每行 40 字节，40 行 = 1.6 KB，超过 ROOT_INDEX_BYTE_MAX。
    await writeFile(
      path.join(paths.reflections, "_index.md"),
      Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}-${"长".repeat(13)}.md`).join("\n"),
      "utf-8",
    );

    expect(await loadRootIndexForInjection(true)).toBeNull();
  });
});
