import type { TriliumNote } from "./client.js";
import { htmlToReadableText } from "./html.js";

const PREVIEWABLE_TYPES = new Set(["text", "code", "book", "doc"]);

export function isTriliumPreviewable(type: string): boolean {
  return PREVIEWABLE_TYPES.has(type);
}

export function triliumNoteKind(note: TriliumNote): "file" | "directory" {
  return (note.childNoteIds?.length ?? 0) > 0 ? "directory" : "file";
}

export function triliumContentToPreview(note: TriliumNote, raw: string): {
  content: string;
  supported: boolean;
  kind: "text" | "unsupported";
} {
  if (!isTriliumPreviewable(note.type)) {
    return { content: `笔记类型 ${note.type} 暂不支持预览`, supported: false, kind: "unsupported" };
  }
  if (note.type === "code") return { content: raw, supported: true, kind: "text" };
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  return {
    content: looksLikeHtml ? htmlToReadableText(raw) : raw,
    supported: true,
    kind: "text",
  };
}
