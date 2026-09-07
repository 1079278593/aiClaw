/**
 * Server module tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { startServer, stopServer, buildAugmentedUserContent, parseCommandsMarkdown } from "./index.js";
import type { Config } from "../config/index.js";
import { setupTestDir, cleanupTestDir } from "../test-utils.js";

const mockCompactSession = vi.hoisted(() => vi.fn());

vi.mock("../chat/compaction.js", () => ({
  compactSession: mockCompactSession,
  BUILTIN_COMPACTION_PROMPT: "mock compaction prompt",
}));

const mockConfig: Config = {
  providers: {
    zai: {
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [
        { id: "GLM-4.5-Air", label: "GLM-4.5-Air" },
        { id: "GLM-4.7", label: "GLM-4.7", thinking: [{ id: "enabled", params: { thinking: { type: "enabled" } } }], thinkingOff: { thinking: { type: "disabled" } } },
      ],
    },
    dashscope: {
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [
        { id: "qwen3.6-plus", label: "qwen3.6-plus" },
        { id: "qwen-vl-max-latest", label: "qwen-vl-max-latest", modal: "vl" },
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

function connectWs(port: number): Promise<{ ws: WebSocket; recv: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue: unknown[] = [];
    const waiters: Array<(v: unknown) => void> = [];

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiters.length > 0) waiters.shift()!(msg);
      else queue.push(msg);
    });

    const recv = (timeoutMs = 3000): Promise<unknown> =>
      new Promise((resolveRecv, rejectRecv) => {
        if (queue.length > 0) {
          resolveRecv(queue.shift());
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(resolveRecv);
          if (index !== -1) waiters.splice(index, 1);
          rejectRecv(new Error("message timeout"));
        }, timeoutMs);
        waiters.push((value) => {
          clearTimeout(timer);
          resolveRecv(value);
        });
      });

    ws.once("open", () => resolve({ ws, recv }));
    ws.once("error", reject);
  });
}

describe("document preview source lines", () => {
  it("preserves physical lines across consecutive blank lines", async () => {
    const modulePath = "./public/js/markdown.js";
    const { renderMarkdown } = await import(modulePath) as { renderMarkdown: (text: string) => string };

    const html = renderMarkdown("标题\n\n\n\n正文");

    expect(html).toContain('<span data-source-line="1">标题</span>');
    expect(html).toContain('<span data-source-line="5">正文</span>');
  });

  it("marks source lines for structured markdown and fenced code", async () => {
    const modulePath = "./public/js/markdown.js";
    const { renderMarkdown } = await import(modulePath) as { renderMarkdown: (text: string) => string };
    const source = [
      "# heading",
      "",
      "first",
      "second",
      "",
      "> quote",
      "- item",
      "",
      "| A |",
      "| --- |",
      "| cell |",
      "",
      "```",
      "alpha",
      "beta",
      "```",
      "",
      "after",
    ].join("\n");

    const html = renderMarkdown(source);

    expect(html).toContain('<h1 data-source-line="1">heading</h1>');
    expect(html).toContain('<span data-source-line="4">second</span>');
    expect(html).toContain('<p data-source-line="6">quote</p>');
    expect(html).toContain('<li data-source-line="7">item</li>');
    expect(html).toContain('<td data-source-line="11">cell</td>');
    expect(html).toContain('<span data-source-line="14">alpha</span>');
    expect(html).toContain('<span data-source-line="15">beta</span>');
    expect(html).toContain('<span data-source-line="18">after</span>');
    expect(html).toContain("<pre><code>");
    expect(html).not.toContain("<p><pre>");
  });

  it("resolves a selection endpoint from source-line metadata", async () => {
    const modulePath = "./public/js/features/document-selection.js";
    const { getSourceLineNumberFromOffset } = await import(modulePath) as {
      getSourceLineNumberFromOffset: (root: unknown, node: unknown, offset: number) => number;
    };
    const runtime = globalThis as typeof globalThis & { Node?: { ELEMENT_NODE: number; TEXT_NODE: number } };
    const previousNode = runtime.Node;
    runtime.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
    const root: Record<string, unknown> = {};
    const span: Record<string, unknown> = {
      nodeType: 1,
      parentElement: root,
      getAttribute: (name: string) => name === "data-source-line" ? "5" : null,
      childNodes: [],
    };
    const textNode = { nodeType: 3, parentElement: span };
    root.contains = (node: unknown) => node === root || node === span;

    try {
      expect(getSourceLineNumberFromOffset(root, textNode, 3)).toBe(5);
    } finally {
      if (previousNode) runtime.Node = previousNode;
      else delete runtime.Node;
    }
  });
});

describe("server", () => {
  let state: Awaited<ReturnType<typeof startServer>>;
  let testDir: string;
  const port = 14000 + Math.floor(Math.random() * 1000);

  beforeAll(async () => {
    testDir = await setupTestDir("server-test");
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8BvlsAAAAASUVORK5CYII=";

    await mkdir(path.join(testDir, "inputs"), { recursive: true });
    await mkdir(path.join(testDir, "files"), { recursive: true });
    await writeFile(path.join(testDir, "inputs", "sample.png"), Buffer.from(pngBase64, "base64"));
    await writeFile(path.join(testDir, "inputs", "notes.md"), "# Notes\n", "utf-8");
    await writeFile(
      path.join(testDir, "files", "commands.md"),
      [
        "# commands",
        "",
        "## summarize",
        "```prompt",
        "Summarize the following content in 3 bullet points.",
        "Keep the key conclusions.",
        "```",
        "",
        "## translate_zh",
        "```prompt",
        "Translate the following content into Chinese.",
        "```",
        "",
      ].join("\n"),
      "utf-8",
    );

    await mkdir(path.join(testDir, "knowledge_base", "example"), { recursive: true });
    await writeFile(path.join(testDir, "knowledge_base", "index.md"), "# 知识库索引\n\n| name | description |\n| --- | --- |\n| example | 示例描述 |\n", "utf-8");
    await writeFile(path.join(testDir, "knowledge_base", "example", "index.md"), "# example\n", "utf-8");
    await writeFile(path.join(testDir, "knowledge_base", "example", "a.md"), "# A\n", "utf-8");
    await writeFile(path.join(testDir, "knowledge_base", "example", "b.md"), "# B\n", "utf-8");

    mockCompactSession.mockResolvedValue({ archivedAs: "archived.jsonl" });
    state = await startServer({ port, host: "127.0.0.1", config: mockConfig });
  });

  afterAll(async () => {
    await stopServer(state);
    await cleanupTestDir(testDir);
  });

  it("serves index.html", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves modular frontend assets", async () => {
    const [styleRes, scriptRes, compatibilityRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/styles/tokens.css`),
      fetch(`http://127.0.0.1:${port}/js/main.js`),
      fetch(`http://127.0.0.1:${port}/js/app.js`),
    ]);

    expect(styleRes.status).toBe(200);
    expect(styleRes.headers.get("content-type")).toContain("text/css");
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("content-type")).toContain("application/javascript");
    expect(compatibilityRes.status).toBe(200);
  });

  it("returns safe config with provider model lists", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    const data = await res.json() as {
      availableProviders: string[];
      defaultProvider: string;
      defaultModel: string;
      defaultThinkingEffort: string;
      gitSyncEnabled: boolean;
      providers: Record<string, { models: Array<{ id: string; label: string; modal?: string; thinking?: Array<{ id: string }> }> }>;
    };

    expect(data.availableProviders).toEqual(["zai"]);
    expect(data.defaultProvider).toBe("zai");
    expect(data.defaultModel).toBe("GLM-4.7");
    expect(data.defaultThinkingEffort).toBe("low");
    expect(data.gitSyncEnabled).toBe(true);
    expect((data as { triliumEnabled?: boolean }).triliumEnabled).toBe(false);
    expect(data.providers.zai.models[0].id).toBe("GLM-4.5-Air");
    expect(data.providers.zai.models[1].thinking?.map((option) => option.id)).toEqual(["enabled"]);
    expect(data.providers.dashscope.models.some((model) => model.modal === "vl")).toBe(true);
  });

  it("returns app state endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/app-state`);
    expect(res.status).toBe(200);
    const data = await res.json() as { lastActiveSessionId?: string; recentModels?: Array<{ provider: string; model: string }> };
    expect(typeof data).toBe("object");
    expect(data.recentModels).toEqual([]);
  });

  it("returns knowledge overview", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/knowledge`);
    const data = await res.json() as { bases: Array<{ name: string; description: string; files: string[] }> };
    expect(data.bases).toEqual([
      { name: "example", description: "示例描述", files: ["a.md", "b.md"] },
    ]);
  });

  it("returns command definitions and supports prefix filtering", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/commands?q=sum`);
    expect(res.status).toBe(200);
    const data = await res.json() as { commands: Array<{ name: string; prompt: string }> };
    expect(data.commands).toEqual([
      {
        name: "summarize",
        prompt: "Summarize the following content in 3 bullet points.\nKeep the key conclusions.",
      },
    ]);
  });

  it("lists text files and supported images for @ mentions", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files?q=sample`);
    expect(res.status).toBe(200);
    const data = await res.json() as { files: Array<{ path: string; source: string }> };
    expect(data.files).toEqual([{ path: "inputs/sample.png", source: "inputs" }]);
  });

  it("lists document tree entries for allowed roots", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/documents/tree?path=knowledge_base/example`);
    expect(res.status).toBe(200);
    const data = await res.json() as { path: string; entries: Array<{ name: string; kind: string }> };
    expect(data.path).toBe("knowledge_base/example");
    expect(data.entries).toEqual([
      { name: "a.md", path: "knowledge_base/example/a.md", kind: "file" },
      { name: "b.md", path: "knowledge_base/example/b.md", kind: "file" },
      { name: "index.md", path: "knowledge_base/example/index.md", kind: "file" },
    ]);
  });

  it("loads document content for text files", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/documents/content?path=inputs/notes.md`);
    expect(res.status).toBe(200);
    const data = await res.json() as { path: string; content: string; supported: boolean };
    expect(data.path).toBe("inputs/notes.md");
    expect(data.supported).toBe(true);
    expect(data.content).toContain("# Notes");
  });

  it("returns 404 with a friendly message when the document was deleted", async () => {
    // 模拟模型执行 delete 工具后前端刷新：文件已不存在，不应返回原始 ENOENT
    const doomedPath = path.join(testDir, "inputs", "doomed.md");
    await writeFile(doomedPath, "# Doomed\n", "utf-8");
    await unlink(doomedPath);

    const res = await fetch(`http://127.0.0.1:${port}/api/documents/content?path=inputs/doomed.md`);
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("文件不存在或已被删除");
    expect(data.error).not.toContain("ENOENT");
  });

  it("loads document content for image files", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/documents/content?path=inputs/sample.png`);
    expect(res.status).toBe(200);
    const data = await res.json() as { path: string; supported: boolean; kind: string; content: string };
    expect(data.path).toBe("inputs/sample.png");
    expect(data.supported).toBe(true);
    expect(data.kind).toBe("image");
    expect(data.content).toMatch(/^data:image\/png;base64,/);
  });

  it("builds preview context for both the LLM message and persisted user content", () => {
    const result = buildAugmentedUserContent(
      "请帮我分析这段内容",
      undefined,
      "knowledge_base/example/a.md",
      "已选中源文件第 3 行到第 4 行：\n第一行\n第二行",
    );
    const expected = [
      "<系统提示>",
      "当前用户正在浏览文件：knowledge_base/example/a.md",
      "",
      "选中内容：",
      "```text",
      "已选中源文件第 3 行到第 4 行：",
      "第一行",
      "第二行",
      "```",
      "",
      "用户正在浏览的文件不一定与当前对话直接相关，请结合上下文判断是否需要参考。",
      "</系统提示>",
      "用户消息：请帮我分析这段内容",
    ].join("\n");

    expect(result.persistedUserContent).toBe(expected);
    expect(result.llmUserContent).toBe(expected);
    expect(result.latestUserTextForLog).toBe(expected);
  });

  it("omits line-number hint when there is no selected preview text", () => {
    const result = buildAugmentedUserContent(
      "请总结这个文件",
      undefined,
      "knowledge_base/example/a.md",
      undefined,
    );

    expect(result.persistedUserContent).toBe(result.llmUserContent);
    expect(result.llmUserContent).toBe([
      "<系统提示>",
      "当前用户正在浏览文件：knowledge_base/example/a.md",
      "",
      "用户正在浏览的文件不一定与当前对话直接相关，请结合上下文判断是否需要参考。",
      "</系统提示>",
      "用户消息：请总结这个文件",
    ].join("\n"));
  });

  it("creates a session", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test Session" }),
    });
    const data = await res.json() as { session: { id: string; title: string } };
    expect(data.session.title).toBe("Test Session");
    expect(data.session.id).toBeDefined();
  });

  it("parses commands markdown with multiline prompt blocks and skips invalid sections", () => {
    const commands = parseCommandsMarkdown([
      "# commands",
      "",
      "## summarize",
      "```prompt",
      "Line 1",
      "Line 2",
      "```",
      "",
      "## ignored_missing_block",
      "No prompt here",
      "",
      "## ignored_other_block",
      "```js",
      "console.log('no');",
      "```",
      "",
      "## translate",
      "```prompt",
      "Translate this text.",
      "```",
      "",
    ].join("\n"));

    expect(commands).toEqual([
      { name: "summarize", prompt: "Line 1\nLine 2" },
      { name: "translate", prompt: "Translate this text." },
    ]);
  });

  it("parses adjacent prompt commands without skipping middle items", () => {
    const commands = parseCommandsMarkdown([
      "# commands",
      "",
      "## delete_file",
      "```prompt",
      "删除这个文件",
      "```",
      "",
      "## delete_image",
      "```prompt",
      "删除这个图片",
      "```",
      "",
      "## image2text",
      "```prompt",
      "识别图中的文字",
      "```",
      "",
    ].join("\n"));

    expect(commands.map((command) => command.name)).toEqual([
      "delete_file",
      "delete_image",
      "image2text",
    ]);
  });

  it("creates a session with auto title when title is omitted", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json() as { session: { id: string; title: string } };
    expect(data.session.title).toBe("New Chat");
    expect(data.session.id).toBeDefined();
  });

  it("renames a session", async () => {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Before Rename" }),
    });
    const createData = await createRes.json() as { session: { id: string } };

    const renameRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${createData.session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "After Rename" }),
    });
    const renameData = await renameRes.json() as { session: { title: string } };
    expect(renameRes.status).toBe(200);
    expect(renameData.session.title).toBe("After Rename");
  });

  it("handles compaction route", async () => {
    mockCompactSession.mockResolvedValueOnce({ archivedAs: "test_archive.jsonl" });
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Compact Test" }),
    });
    const { session } = await res.json() as { session: { id: string } };

    const compactRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/compact`, { method: "POST" });
    const data = await compactRes.json() as { ok: boolean; archivedAs: string };
    expect(compactRes.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.archivedAs).toBe("test_archive.jsonl");
  });

  it("sends connected and pong websocket messages", async () => {
    const { ws, recv } = await connectWs(port);
    const connected = await recv() as { type: string };
    expect(connected.type).toBe("connected");
    ws.send(JSON.stringify({ type: "ping" }));
    const pong = await recv() as { type: string };
    expect(pong.type).toBe("pong");
    ws.close();
  });

  it("returns error for chatMessage without sessionId", async () => {
    const { ws, recv } = await connectWs(port);
    await recv();
    ws.send(JSON.stringify({ type: "chatMessage", content: "Hello" }));
    const err = await recv() as { type: string; message: string };
    expect(err.type).toBe("error");
    expect(err.message).toContain("sessionId");
    ws.close();
  });

  it("loads session and persists last active session on joinSession", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "WS Test" }),
    });
    const { session } = await res.json() as { session: { id: string } };

    const { ws, recv } = await connectWs(port);
    await recv();
    ws.send(JSON.stringify({ type: "joinSession", sessionId: session.id, requestId: "join-test-1" }));
    const loaded = await recv() as { type: string; requestId?: string; session: { id: string } };
    expect(loaded.type).toBe("sessionLoaded");
    expect(loaded.session.id).toBe(session.id);
    expect(loaded.requestId).toBe("join-test-1");
    ws.close();

    const appStateRes = await fetch(`http://127.0.0.1:${port}/api/app-state`);
    const appState = await appStateRes.json() as { lastActiveSessionId?: string };
    expect(appState.lastActiveSessionId).toBe(session.id);
  });
});
