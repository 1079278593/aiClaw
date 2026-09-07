import type { TriliumToolConfig } from "../config/schema.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import { createTriliumClient, type TriliumClient, type TriliumNote } from "../trilium/client.js";
import { formatTriliumRef, isTriliumEnabled, parseTriliumNoteId } from "../trilium/paths.js";
import { triliumContentToPreview } from "../trilium/preview.js";

const DEFAULT_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;

function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

function sliceTextContent(raw: string, offset?: number, limit?: number): string {
  const lines = raw.split("\n");
  const totalLines = lines.length;
  const start = offset !== undefined ? Math.max(0, offset - 1) : 0;
  const end = start + (limit ?? DEFAULT_READ_LINES);
  let content = lines.slice(start, end).join("\n");
  const notices: string[] = [];
  if (end < totalLines) {
    notices.push(`笔记共 ${totalLines} 行，本次返回第 ${start + 1}–${Math.min(end, totalLines)} 行，可用 offset=${end + 1} 继续读取`);
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_READ_BYTES) {
    content = truncateToBytes(content, MAX_READ_BYTES);
    notices.push(`内容超过 ${MAX_READ_BYTES / 1024} KB 单次上限，已按字节截断，请用更小的 limit 分段读取`);
  }
  if (notices.length > 0) content += `\n\n[read 截断：${notices.join("；")}]`;
  return content;
}

function formatToolError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: message, isError: true };
}

function noteSummary(note: TriliumNote): string {
  const childCount = note.childNoteIds?.length ?? 0;
  const suffix = childCount > 0 ? `  子笔记 ${childCount}` : "";
  return `${formatTriliumRef(note.noteId)}  ${note.title}  (${note.type})${suffix}`;
}

export function createTriliumTools(config: TriliumToolConfig, client?: TriliumClient): ToolDefinition[] {
  if (!isTriliumEnabled(config.enabled, config.token)) return [];
  const trilium = client ?? createTriliumClient(config);

  const searchTool: ToolDefinition<{ query: string; limit?: number }> = {
    name: "trilium_search",
    description:
      "在 Trilium 笔记库中搜索（只读）。返回 noteId、标题和类型。读取正文请再用 trilium_read。不要尝试写入或删除 Trilium 笔记。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，支持 Trilium 搜索语法" },
        limit: { type: "number", description: "最多返回条数，可选" },
      },
      required: ["query"],
    },
    async execute(input) {
      try {
        const notes = await trilium.searchNotes(input.query, { limit: input.limit ?? 20 });
        if (!notes.length) return { content: "未找到匹配的 Trilium 笔记" };
        return { content: notes.map(noteSummary).join("\n") };
      } catch (error) {
        return formatToolError(error);
      }
    },
  };

  const listTool: ToolDefinition<{ noteId?: string }> = {
    name: "trilium_list",
    description:
      "列出 Trilium 某篇笔记的子笔记（只读）。不传 noteId 时列出配置的根节点（ancestorNoteId 或 root）下的子笔记。",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "父笔记 ID，或 trilium:{noteId}" },
      },
    },
    async execute(input) {
      try {
        const parentId = input.noteId ? parseTriliumNoteId(input.noteId) : undefined;
        const notes = await trilium.listChildren(parentId);
        if (!notes.length) return { content: "没有子笔记" };
        return { content: notes.map(noteSummary).join("\n") };
      } catch (error) {
        return formatToolError(error);
      }
    },
  };

  const readTool: ToolDefinition<{ noteId: string; offset?: number; limit?: number }> = {
    name: "trilium_read",
    description:
      "读取一篇 Trilium 笔记的正文（只读）。noteId 可以是裸 ID 或 trilium:{noteId}。文本笔记会转成可读文本；默认最多 2000 行 / 50KB，可用 offset 与 limit 续读。不能修改 Trilium。",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "笔记 ID，或 trilium:{noteId}" },
        offset: { type: "number", description: "从 1 开始的行号" },
        limit: { type: "number", description: "读取行数，默认 2000" },
      },
      required: ["noteId"],
    },
    async execute(input) {
      try {
        const noteId = parseTriliumNoteId(input.noteId);
        const note = await trilium.getNote(noteId);
        const raw = await trilium.getNoteContent(noteId);
        const { content, supported } = triliumContentToPreview(note, raw);
        if (!supported) return { content, isError: true };
        const header = `${note.title}\n${formatTriliumRef(note.noteId)}\n`;
        return { content: header + sliceTextContent(content, input.offset, input.limit) };
      } catch (error) {
        return formatToolError(error);
      }
    },
  };

  return [searchTool, listTool, readTool];
}
