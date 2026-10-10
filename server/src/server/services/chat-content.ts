import type { MessageContentPart } from "../../types/index.js";

function buildUserContent(content: string, images?: Array<{ url: string; path?: string }>): string | MessageContentPart[] {
  if (!images?.length) return content;
  const parts: MessageContentPart[] = [];
  if (content) parts.push({ type: "text", text: content });
  for (const image of images) {
    parts.push({
      type: "image_url",
      image_url: { url: image.url, ...(image.path ? { path: image.path } : {}) },
    });
  }
  return parts;
}

export function buildPreviewContextSuffix(previewPath?: string, selectedPreviewText?: string): string {
  const trimmedPath = String(previewPath || "").trim();
  const trimmedSelection = String(selectedPreviewText || "").trim();
  if (!trimmedPath && !trimmedSelection) return "";

  const lines = ["<系统提示>"];
  if (trimmedPath) lines.push(`当前用户正在浏览文件：${trimmedPath}`, "");
  if (trimmedSelection) {
    lines.push("选中内容：", "```text", trimmedSelection, "```", "");
  }
  lines.push("用户正在浏览的文件不一定与当前对话直接相关，请结合上下文判断是否需要参考。", "</系统提示>");
  return lines.join("\n");
}

export function buildAugmentedUserContent(
  content: string,
  images: Array<{ url: string; path?: string }> | undefined,
  previewPath?: string,
  selectedPreviewText?: string,
): {
  llmUserContent: string | MessageContentPart[];
  persistedUserContent: string | MessageContentPart[];
  latestUserTextForLog: string;
} {
  const suffix = buildPreviewContextSuffix(previewPath, selectedPreviewText);
  const augmentedText = suffix ? `${suffix}\n用户消息：${content}` : content;
  const llmUserContent = buildUserContent(augmentedText, images);
  return { llmUserContent, persistedUserContent: llmUserContent, latestUserTextForLog: augmentedText };
}
