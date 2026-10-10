/**
 * File tools integration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { MAX_IMAGE_BYTES } from "../media/image.js";

vi.mock("../config/paths.js", () => ({
  getUserDataDir: vi.fn(() => tmpDir),
}));

import { createFileTools } from "./file-tools.js";

let tmpDir: string;
let inputsDir: string;
let knowledgeBaseDir: string;
let tools: ReturnType<typeof createFileTools>;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "aiclaw-test-"));
  inputsDir = path.join(tmpDir, "inputs");
  knowledgeBaseDir = path.join(tmpDir, "knowledge_base");
  await mkdir(inputsDir);
  await mkdir(knowledgeBaseDir);
  tools = createFileTools([inputsDir, knowledgeBaseDir], [path.join(tmpDir, "memory.md")]);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function getTool(name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe("write tool", () => {
  it("creates a file with relative path", async () => {
    const result = await getTool("write").execute({ path: "inputs/hello.txt", content: "hello" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Written");
  });

  it("creates parent directories", async () => {
    const result = await getTool("write").execute({ path: "inputs/sub/dir/file.txt", content: "nested" });
    expect(result.isError).toBeUndefined();
  });

  it("writes to allowed single file", async () => {
    const result = await getTool("write").execute({ path: "memory.md", content: "memory" });
    expect(result.isError).toBeUndefined();
  });

  it("blocks absolute path", async () => {
    const result = await getTool("write").execute({ path: path.join(os.tmpdir(), "evil.txt"), content: "x" });
    expect(result.isError).toBe(true);
  });
});

describe("read tool", () => {
  it("reads file content", async () => {
    await getTool("write").execute({ path: "inputs/r.txt", content: "read me" });
    const result = await getTool("read").execute({ path: "inputs/r.txt" });
    expect(result.content).toBe("read me");
  });

  it("returns error for missing file", async () => {
    const result = await getTool("read").execute({ path: "inputs/missing.txt" });
    expect(result.isError).toBe(true);
  });

  it("returns error for missing file with a friendly message", async () => {
    const result = await getTool("read").execute({ path: "inputs/nope.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("文件不存在");
  });

  it("caps output at the default line limit and appends a notice", async () => {
    const content = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
    await getTool("write").execute({ path: "inputs/big.txt", content });
    const result = await getTool("read").execute({ path: "inputs/big.txt" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("line 2000");
    expect(result.content).not.toContain("line 2001");
    expect(result.content).toContain("read 截断");
    expect(result.content).toContain("offset=2001");
  });

  it("honors an explicit limit", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    await getTool("write").execute({ path: "inputs/lim.txt", content });
    const result = await getTool("read").execute({ path: "inputs/lim.txt", offset: 10, limit: 3 });
    expect(result.content).toContain("line 10");
    expect(result.content).toContain("line 12");
    expect(result.content).not.toContain("line 13");
    expect(result.content).toContain("read 截断");
  });

  it("byte-caps oversized content at 50 KiB", async () => {
    // One long line well over 50 KiB — the line cap won't trigger, only the byte cap.
    const content = "x".repeat(60 * 1024);
    await getTool("write").execute({ path: "inputs/wide.txt", content });
    const result = await getTool("read").execute({ path: "inputs/wide.txt" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("已按字节截断");
    // Truncated body is 50 KiB; the notice adds a small suffix.
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThan(51 * 1024);
  });

  it("does not add a notice for small files", async () => {
    await getTool("write").execute({ path: "inputs/small.txt", content: "just a bit" });
    const result = await getTool("read").execute({ path: "inputs/small.txt" });
    expect(result.content).toBe("just a bit");
  });
});

describe("list tool", () => {
  it("lists directory entries", async () => {
    await getTool("write").execute({ path: "inputs/a.txt", content: "" });
    const result = await getTool("list").execute({ path: "inputs" });
    expect(result.isError).toBeUndefined();
    const items = JSON.parse(result.content) as Array<{ name: string; type: string }>;
    expect(items.some((item) => item.name === "a.txt" && item.type === "file")).toBe(true);
  });
});

describe("edit tool", () => {
  it("replaces first occurrence of old_string", async () => {
    await getTool("write").execute({ path: "inputs/edit.txt", content: "foo bar foo" });
    const result = await getTool("edit").execute({ path: "inputs/edit.txt", old_string: "foo", new_string: "baz" });
    expect(result.isError).toBeUndefined();
    const readResult = await getTool("read").execute({ path: "inputs/edit.txt" });
    expect(readResult.content).toBe("baz bar foo");
  });

  it("returns error when old_string not found", async () => {
    await getTool("write").execute({ path: "inputs/edit2.txt", content: "hello" });
    const result = await getTool("edit").execute({ path: "inputs/edit2.txt", old_string: "nothere", new_string: "x" });
    expect(result.isError).toBe(true);
  });

  it("blocks absolute path", async () => {
    const result = await getTool("edit").execute({
      path: path.join(os.tmpdir(), "evil.txt"), old_string: "a", new_string: "b",
    });
    expect(result.isError).toBe(true);
  });
});

describe("search tool", () => {
  it("finds matches in allowed directories", async () => {
    await getTool("write").execute({ path: "inputs/a.txt", content: "hello world\nsecond line" });
    await getTool("write").execute({ path: "knowledge_base/b.md", content: "HELLO again" });

    const result = await getTool("grep").execute({ pattern: "hello" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("inputs/a.txt");
    expect(result.content).toContain("1: hello world");
    expect(result.content).toContain("knowledge_base/b.md");
  });

  it("supports searching a single allowed file", async () => {
    await getTool("write").execute({ path: "memory.md", content: "remember this keyword" });

    const result = await getTool("grep").execute({ pattern: "keyword", path: "memory.md" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("memory.md");
  });

  it("returns error for empty pattern", async () => {
    const result = await getTool("grep").execute({ pattern: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("pattern must not be empty");
  });

  it("returns no-match hint", async () => {
    await getTool("write").execute({ path: "inputs/a.txt", content: "hello world" });
    const result = await getTool("grep").execute({ pattern: "notfound" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('No matches found for "notfound"');
  });
});

describe("delete tool", () => {
  it("deletes an allowed file", async () => {
    await getTool("write").execute({ path: "inputs/remove.txt", content: "bye" });
    const result = await getTool("delete").execute({ path: "inputs/remove.txt" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Deleted inputs/remove.txt");

    const readResult = await getTool("read").execute({ path: "inputs/remove.txt" });
    expect(readResult.isError).toBe(true);
  });

  it("rejects deleting a directory", async () => {
    const result = await getTool("delete").execute({ path: "inputs" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cannot delete a directory");
  });

  it("returns file not found for missing files", async () => {
    const result = await getTool("delete").execute({ path: "inputs/missing.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  it("allows deleting an allowed single file", async () => {
    await writeFile(path.join(tmpDir, "memory.md"), "memory", "utf-8");
    const result = await getTool("delete").execute({ path: "memory.md" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Deleted memory.md");
  });
});

describe("read tool (images)", () => {
  async function createPng(): Promise<Buffer> {
    return sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } }).png().toBuffer();
  }

  it("returns image parts as a data URL for vision models", async () => {
    const pngBytes = await createPng();
    await writeFile(path.join(inputsDir, "pic.png"), pngBytes);
    const result = await getTool("read").execute(
      { path: "inputs/pic.png" },
      { sessionId: "s", sessionTitle: "t", supportsImages: true },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("已加载图片 inputs/pic.png");
    expect(result.imageParts).toHaveLength(1);
    const part = result.imageParts![0];
    expect(part.type).toBe("image_url");
    if (part.type === "image_url") {
      expect(part.image_url.url).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`);
      expect(part.image_url.path).toBe("inputs/pic.png");
    }
  });

  it("attaches image when supportsImages is unspecified", async () => {
    await writeFile(path.join(inputsDir, "pic.png"), await createPng());
    const result = await getTool("read").execute({ path: "inputs/pic.png" });
    expect(result.isError).toBeUndefined();
    expect(result.imageParts).toHaveLength(1);
  });

  it("rejects images larger than 5 MiB", async () => {
    await writeFile(path.join(inputsDir, "large.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const result = await getTool("read").execute(
      { path: "inputs/large.png" },
      { sessionId: "s", sessionTitle: "t", supportsImages: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("图片超过 5 MiB 限制");
  });

  it("degrades to a text error for non-vision models", async () => {
    await writeFile(path.join(inputsDir, "pic.png"), await createPng());
    const result = await getTool("read").execute(
      { path: "inputs/pic.png" },
      { sessionId: "s", sessionTitle: "t", supportsImages: false },
    );
    expect(result.isError).toBe(true);
    expect(result.imageParts).toBeUndefined();
    expect(result.content).toContain("当前模型不支持");
  });

  it("rejects unsupported image types", async () => {
    await writeFile(path.join(inputsDir, "pic.bmp"), await createPng());
    const result = await getTool("read").execute(
      { path: "inputs/pic.bmp" },
      { sessionId: "s", sessionTitle: "t", supportsImages: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("不支持的图片类型");
  });

  it("returns error for a missing image", async () => {
    const result = await getTool("read").execute(
      { path: "inputs/nope.png" },
      { sessionId: "s", sessionTitle: "t", supportsImages: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("文件不存在");
  });

  it("blocks absolute paths", async () => {
    const result = await getTool("read").execute(
      { path: path.join(os.tmpdir(), "evil.png") },
      { sessionId: "s", sessionTitle: "t", supportsImages: true },
    );
    expect(result.isError).toBe(true);
  });
});
