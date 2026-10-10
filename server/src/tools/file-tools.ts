/**
 * File tools: list, read (text & images), write, edit, search, delete
 * All operations are guarded by assertPathAllowed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import type { MessageContentPart } from "../types/index.js";
import { MAX_IMAGE_BYTES, normalizeImageBuffer } from "../media/image.js";
import { assertPathAllowed, resolvePath, ToolError } from "./fs-policy.js";

type ListInput = { path: string };
type ReadInput = { path: string; offset?: number; limit?: number };
type WriteInput = { path: string; content: string };
type EditInput = { path: string; old_string: string; new_string: string };
type GrepInput = { pattern: string; path?: string };
type MoveInput = { path: string; new_path: string };
type DeleteInput = { path: string };
type FilePolicy = { allowedDirs: string[]; allowedFiles: string[] };

// Image types that vision models reliably accept as data URLs.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

// Guardrails so a huge text file cannot flood the model context. A read without
// an explicit `limit` returns at most DEFAULT_READ_LINES lines, and the returned
// text is byte-capped at MAX_READ_BYTES regardless. Overflow is soft-truncated
// with a notice telling the model how to continue (offset) rather than rejected.
const DEFAULT_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024; // 50 KiB per read

// Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
// multi-byte character (back off past any trailing continuation bytes).
function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

// Slice `raw` to the requested line range, applying the default line cap and the
// byte cap. Appends a Chinese notice when either cap truncates the output.
function sliceTextContent(raw: string, offset?: number, limit?: number): string {
  const lines = raw.split("\n");
  const totalLines = lines.length;
  const start = offset !== undefined ? Math.max(0, offset - 1) : 0;
  const end = start + (limit ?? DEFAULT_READ_LINES);
  let content = lines.slice(start, end).join("\n");
  const notices: string[] = [];
  if (end < totalLines) {
    notices.push(`文件共 ${totalLines} 行，本次返回第 ${start + 1}–${Math.min(end, totalLines)} 行，可用 offset=${end + 1} 继续读取`);
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_READ_BYTES) {
    content = truncateToBytes(content, MAX_READ_BYTES);
    notices.push(`内容超过 ${MAX_READ_BYTES / 1024} KB 单次上限，已按字节截断，请用更小的 limit 分段读取或用 grep 搜索`);
  }
  if (notices.length > 0) content += `\n\n[read 截断：${notices.join("；")}]`;
  return content;
}

function toRelativePath(resolved: string): string {
  return path.relative(resolvePath("."), resolved).replaceAll("\\", "/");
}

async function collectFiles(root: string): Promise<string[]> {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) return [root];

  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }

  return out;
}

function makeListTool(policy: FilePolicy): ToolDefinition<ListInput> {
  return {
    name: "list",
    description: "列出允许目录下的文件和目录。使用相对于数据目录的路径，例如 'inputs' 或 'knowledge_base'。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "相对目录路径，例如 'inputs' 或 'knowledge_base'" } },
      required: ["path"],
    },
    async execute(input) {
      try {
        const resolved = resolvePath(input.path);
        assertPathAllowed(resolved, policy.allowedDirs, policy.allowedFiles);
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        }));
        return { content: JSON.stringify(items, null, 2) };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        return { content: `Failed to list ${input.path}: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

// Read an image as a multimodal tool result. Gated on the active model's vision
// support and a 5 MiB size limit; larger images are normalized before encoding.
async function readImageAsParts(
  resolved: string,
  inputPath: string,
  ext: string,
  context?: ToolContext,
): Promise<ToolResult> {
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) {
    return { content: `不支持的图片类型：${inputPath}（仅支持 png/jpg/jpeg/gif/webp）`, isError: true };
  }
  // Only vision models can receive the image bytes.
  if (context?.supportsImages === false) {
    return { content: `当前模型不支持查看图片，无法读取 ${inputPath}`, isError: true };
  }
  const stats = await fs.stat(resolved);
  if (stats.size > MAX_IMAGE_BYTES) {
    return { content: "图片超过 5 MiB 限制", isError: true };
  }
  const buffer = await fs.readFile(resolved);
  const normalized = await normalizeImageBuffer(buffer);
  const url = `data:${normalized.mimeType};base64,${normalized.buffer.toString("base64")}`;
  const relPath = inputPath.replaceAll("\\", "/");
  const imageParts: MessageContentPart[] = [{ type: "image_url", image_url: { url, path: relPath } }];
  return { content: `已加载图片 ${relPath}`, imageParts };
}

function makeReadTool(policy: FilePolicy): ToolDefinition<ReadInput> {
  return {
    name: "read",
    description:
      "读取允许目录或允许单个文件中的文件。使用相对于数据目录的路径，例如 'inputs/notes.txt' 或 'inputs/photo.png'。文本文件返回内容，默认最多返回 2000 行且不超过 50KB，超出会截断并提示；可用 offset（从1开始的行号）和 limit 读取指定范围的行，大文件用 offset 分段续读。图片文件（png/jpg/jpeg/gif/webp）会作为图片返回，供视觉模型查看。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对文件路径，例如 'inputs/notes.txt' 或 'inputs/photo.png'" },
        offset: { type: "number", description: "从1开始的行号，指定从哪一行开始读取（仅文本文件，可选）" },
        limit: { type: "number", description: "要读取的行数（仅文本文件，可选，默认 2000）" },
      },
      required: ["path"],
    },
    async execute(input, context) {
      try {
        const resolved = resolvePath(input.path);
        assertPathAllowed(resolved, policy.allowedDirs, policy.allowedFiles);
        const ext = path.extname(resolved).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          return await readImageAsParts(resolved, input.path, ext, context);
        }
        const raw = await fs.readFile(resolved, "utf-8");
        return { content: sliceTextContent(raw, input.offset, input.limit) };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `文件不存在：${input.path}`, isError: true };
        }
        return { content: `Failed to read ${input.path}: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function makeWriteTool(policy: FilePolicy): ToolDefinition<WriteInput> {
  return {
    name: "write",
    description: "将内容写入允许目录或允许单个文件中的文件。使用相对于数据目录的路径，例如 'inputs/notes.txt' 或 'memory.md'。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对文件路径，例如 'inputs/notes.txt' 或 'memory.md'" },
        content: { type: "string", description: "要写入的内容" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      try {
        const resolved = resolvePath(input.path);
        assertPathAllowed(resolved, policy.allowedDirs, policy.allowedFiles);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, input.content, "utf-8");
        return { content: `Written to ${input.path}` };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        return { content: `Failed to write ${input.path}: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function makeEditTool(policy: FilePolicy): ToolDefinition<EditInput> {
  return {
    name: "edit",
    description: "在允许的文件中，将第一次出现的 old_string 替换为 new_string。使用相对于数据目录的路径，例如 'inputs/notes.txt' 或 'memory.md'。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对文件路径，例如 'inputs/notes.txt' 或 'memory.md'" },
        old_string: { type: "string", description: "要查找并替换的字符串" },
        new_string: { type: "string", description: "替换后的字符串" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input) {
      try {
        const resolved = resolvePath(input.path);
        assertPathAllowed(resolved, policy.allowedDirs, policy.allowedFiles);
        const original = await fs.readFile(resolved, "utf-8");

        // Try exact match first
        if (original.includes(input.old_string)) {
          const updated = original.replace(input.old_string, input.new_string);
          await fs.writeFile(resolved, updated, "utf-8");
          return { content: `Edited ${input.path}` };
        }

        // Try CRLF → LF normalization (Windows line endings vs LLM-generated LF)
        const normalized = original.replace(/\r\n/g, "\n");
        const normalizedOld = input.old_string.replace(/\r\n/g, "\n");
        if (normalized.includes(normalizedOld)) {
          const normalizedNew = input.new_string.replace(/\r\n/g, "\n");
          const updated = normalized.replace(normalizedOld, normalizedNew);
          await fs.writeFile(resolved, updated, "utf-8");
          return { content: `Edited ${input.path}` };
        }

        return { content: `old_string not found in ${input.path}`, isError: true };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        return { content: `Failed to edit ${input.path}: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function makeGrepTool(policy: FilePolicy): ToolDefinition<GrepInput> {
  return {
    name: "grep",
    description: "在允许目录或允许单个文件下搜索文件内容中的文本模式。返回匹配的文件路径、行号和行文本。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜索的文本，不区分大小写" },
        path: { type: "string", description: "可选的相对文件或目录路径，用于限制搜索范围" },
      },
      required: ["pattern"],
    },
    async execute(input) {
      try {
        if (!input.pattern?.trim()) {
          return { content: "pattern must not be empty", isError: true };
        }

        const roots = input.path
          ? [resolvePath(input.path)]
          : [...policy.allowedDirs, ...policy.allowedFiles];

        for (const root of roots) {
          assertPathAllowed(root, policy.allowedDirs, policy.allowedFiles);
        }

        const matches: Array<{ file: string; line: number; text: string }> = [];
        const needle = input.pattern.toLowerCase();
        let truncated = false;

        for (const root of roots) {
          let files: string[] = [];
          try {
            files = await collectFiles(root);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw err;
          }
          for (const file of files) {
            try {
              const content = await fs.readFile(file, "utf-8");
              const lines = content.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (!lines[i].toLowerCase().includes(needle)) continue;
                matches.push({
                  file: toRelativePath(file),
                  line: i + 1,
                  text: lines[i].trim(),
                });
                if (matches.length >= 200) {
                  truncated = true;
                  break;
                }
              }
            } catch {
              // Skip unreadable files and continue the overall search.
            }

            if (truncated) break;
          }
          if (truncated) break;
        }

        if (matches.length === 0) {
          return { content: `No matches found for "${input.pattern}"` };
        }

        const grouped = new Map<string, Array<{ line: number; text: string }>>();
        for (const match of matches) {
          const entries = grouped.get(match.file) ?? [];
          entries.push({ line: match.line, text: match.text });
          grouped.set(match.file, entries);
        }

        const blocks = Array.from(grouped.entries()).map(([file, entries]) => [
          file,
          ...entries.map((entry) => `  ${entry.line}: ${entry.text}`),
        ].join("\n"));

        return { content: blocks.join("\n") + (truncated ? "\n\nresults truncated" : "") };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        return { content: `Failed to search: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function makeMoveTool(policy: FilePolicy): ToolDefinition<MoveInput> {
  return {
    name: "move",
    description: "在允许目录内重命名或移动文件。源路径和目标路径都必须在允许目录内。使用相对于数据目录的路径。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "当前相对文件路径，例如 'inputs/old.txt'" },
        new_path: { type: "string", description: "新的相对文件路径，例如 'inputs/new.txt'" },
      },
      required: ["path", "new_path"],
    },
    async execute(input) {
      try {
        const resolved = resolvePath(input.path);
        const resolvedNew = resolvePath(input.new_path);
        assertPathAllowed(resolved, policy.allowedDirs, policy.allowedFiles);
        assertPathAllowed(resolvedNew, policy.allowedDirs, policy.allowedFiles);
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          return { content: "cannot move a directory", isError: true };
        }
        await fs.mkdir(path.dirname(resolvedNew), { recursive: true });
        await fs.rename(resolved, resolvedNew);
        return { content: `Moved ${input.path} to ${input.new_path}` };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: "file not found", isError: true };
        }
        return { content: `Failed to move ${input.path}: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function makeDeleteTool(policy: FilePolicy): ToolDefinition<DeleteInput> {
  return {
    name: "delete",
    description: "删除允许目录或允许单个文件中的文件。只能删除文件，不能删除目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对文件路径，例如 'inputs/old.txt' 或 'memory.md'" },
      },
      required: ["path"],
    },
    async execute(input) {
      try {
        const resolved = resolvePath(input.path);
        assertPathAllowed(resolved, policy.allowedDirs, policy.allowedFiles);
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          return { content: "cannot delete a directory", isError: true };
        }
        await fs.unlink(resolved);
        return { content: `Deleted ${input.path}` };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: "file not found", isError: true };
        }
        return { content: `Failed to delete ${input.path}: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

export function createFileTools(allowedDirs: string[], allowedFiles: string[] = []): ToolDefinition[] {
  const policy = { allowedDirs, allowedFiles };
  return [
    makeListTool(policy),
    makeReadTool(policy),
    makeWriteTool(policy),
    makeEditTool(policy),
    makeGrepTool(policy),
    makeMoveTool(policy),
    makeDeleteTool(policy),
  ];
}
