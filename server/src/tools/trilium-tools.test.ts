import { describe, expect, it, vi } from "vitest";
import { createTriliumTools } from "./trilium-tools.js";
import type { TriliumToolConfig } from "../config/schema.js";
import type { TriliumClient, TriliumNote } from "../trilium/client.js";

const config: TriliumToolConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8080",
  token: "token",
  ancestorNoteId: "",
  timeoutMs: 5_000,
};

const sampleNote: TriliumNote = {
  noteId: "abc123",
  title: "测试笔记",
  type: "text",
  isProtected: false,
  childNoteIds: [],
};

function makeClient(overrides: Partial<TriliumClient> = {}): TriliumClient {
  return {
    getNote: vi.fn(async () => sampleNote),
    getNoteContent: vi.fn(async () => "<p>第一行</p><p>第二行</p>"),
    searchNotes: vi.fn(async () => [sampleNote]),
    listChildren: vi.fn(async () => [sampleNote]),
    ...overrides,
  };
}

describe("trilium tools", () => {
  it("does not register tools without token", () => {
    expect(createTriliumTools({ ...config, token: "" })).toEqual([]);
    expect(createTriliumTools({ ...config, enabled: false })).toEqual([]);
  });

  it("search and list return refs", async () => {
    const client = makeClient();
    const [searchTool, listTool] = createTriliumTools(config, client);
    const search = await searchTool.execute({ query: "测试" });
    const list = await listTool.execute({});
    expect(search.content).toContain("trilium:abc123");
    expect(search.content).toContain("测试笔记");
    expect(list.content).toContain("trilium:abc123");
  });

  it("read converts html and accepts trilium: prefix", async () => {
    const client = makeClient();
    const tools = createTriliumTools(config, client);
    const readTool = tools.find((tool) => tool.name === "trilium_read")!;
    const result = await readTool.execute({ noteId: "trilium:abc123" });
    expect(client.getNote).toHaveBeenCalledWith("abc123");
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("测试笔记");
    expect(result.content).toContain("第一行");
    expect(result.content).not.toContain("<p>");
  });
});
