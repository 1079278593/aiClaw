import { renderContent } from "../markdown.js";
import { openImagePreview } from "./image-preview.js";

const USER_MESSAGE_COLLAPSE_THRESHOLD = 400;
const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 5;
const USER_CONTEXT_PATTERN = /^<系统提示>\n([\s\S]*?)\n<\/系统提示>\n用户消息：([\s\S]*)$/;
const PREVIEW_PATH_PATTERN = /^当前用户正在浏览文件：(.*)$/m;
const SELECTION_BLOCK_START = "选中内容：\n```text\n";
const SELECTION_LINE_HINT_PATTERN = /^已选中源文件第\s*\d+\s*行到第\s*\d+\s*行：\n?/;

/** 拆分持久化用户消息里的 <系统提示> 前缀，返回真正展示的文本与引用信息。 */
export function parseUserMessageContent(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const match = USER_CONTEXT_PATTERN.exec(normalized);
  if (!match) return { text: normalized, previewPath: "", selectedText: "" };

  const block = match[1];
  const pathMatch = PREVIEW_PATH_PATTERN.exec(block);
  let selectedText = "";
  const startIndex = block.indexOf(SELECTION_BLOCK_START);
  if (startIndex !== -1) {
    const contentStart = startIndex + SELECTION_BLOCK_START.length;
    // 选中内容里可能本身带 ``` 代码块，从末尾找外层的结束围栏
    const endIndex = block.lastIndexOf("\n```");
    if (endIndex >= contentStart) selectedText = block.slice(contentStart, endIndex);
  }

  return {
    text: match[2],
    previewPath: pathMatch ? pathMatch[1].trim() : "",
    selectedText: selectedText.replace(SELECTION_LINE_HINT_PATTERN, ""),
  };
}

export function createMessageRenderer({ state, streaming, onRestart, scrollToBottom }) {
  function renderMessages(messages) {
    if (!state.messagesEl) return;
    state.messagesEl.classList.remove("round-anchor-active");
    if (!messages.length) {
      state.messagesEl.innerHTML =
        '<div id="empty-state" class="empty-state"><div class="empty-state-icon"><i data-lucide="message-circle"></i></div><p class="empty-state-title">发送消息开始对话</p></div>';
      window.lucide?.createIcons();
      return;
    }
    state.messagesEl.innerHTML = "";
    const toolBlocks = {};
    // All consecutive assistant messages between two user messages share ONE
    // bubble — the same linear block flow that streaming uses.  This avoids
    // separate .message wrappers with flex-gap that look like blank lines.
    let assistantBubble = null;

    for (const message of messages) {
      if (message.role === "system") continue;

      if (message.role === "tool") {
        const block = toolBlocks[message.tool_call_id];
        if (block) {
          streaming.fillToolResult(block, message.content || "", isHistoricalToolError(message.content));
          delete toolBlocks[message.tool_call_id];
        }
        continue;
      }

      if (message.role === "user") {
        assistantBubble = null;
        appendMessage("user", message.content || "", message.id);
        continue;
      }

      // ---- assistant messages ----
      if (!assistantBubble) assistantBubble = createAssistantBubble();

      // Render reasoning_content before tool calls / text (chronological order)
      if (message.reasoning_content) {
        appendReasoningBlock(assistantBubble, message.reasoning_content);
      }

      if (message.tool_calls) {
        if (message.content) appendTextBlock(assistantBubble, message.content, { process: true });
        for (const toolCall of message.tool_calls) {
          // after:false → insert before .message-content so chronological order
          // is preserved when later blocks (text / tool) are added.
          const block = streaming.appendToolCallBlock(
            assistantBubble,
            getToolCallName(toolCall),
            getToolCallInput(toolCall),
            { after: false },
          );
          if (toolCall.id) toolBlocks[toolCall.id] = block;
        }
        continue;
      }

      // plain assistant reply (no tool_calls)
      appendTextBlock(assistantBubble, message.content || "");
    }
    scrollToBottom();
    window.lucide?.createIcons();
  }

  /** Create a single assistant bubble (with hidden .message-content) that
   *  all consecutive assistant blocks share — exactly like the streaming path. */
  function createAssistantBubble() {
    if (!state.messagesEl) return null;
    const message = document.createElement("div");
    message.className = "message assistant";
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    // Hidden .message-content — text lives in chronologically-ordered text-segments.
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.style.display = "none";
    bubble.appendChild(contentDiv);
    message.appendChild(bubble);
    state.messagesEl.appendChild(message);
    return bubble;
  }

  /** Append a completed text block before .message-content so it stays in
   *  chronological order relative to reasoning / tool blocks already there. */
  function appendTextBlock(bubble, content, { process = false } = {}) {
    const segment = document.createElement("div");
    segment.className = `text-segment markdown-body${process ? " process-step" : ""}`;
    segment.dataset.raw = content;
    const rendered = formatMessageContent(content);
    renderContent(segment, rendered);
    const contentDiv = bubble.querySelector(".message-content");
    if (contentDiv) bubble.insertBefore(segment, contentDiv);
    else bubble.appendChild(segment);
  }

  /** Append a reasoning block (collapsed <details>) to the bubble, matching
   *  the streaming rendering style. */
  function appendReasoningBlock(bubble, content) {
    const details = document.createElement("details");
    details.className = "reasoning-block process-step";
    const summary = document.createElement("summary");
    const dot = document.createElement("span");
    dot.className = "bullet-dot";
    summary.appendChild(dot);
    const label = document.createElement("span");
    label.style.fontSize = "12px";
    label.style.letterSpacing = "0.03em";
    label.textContent = "Thinking";
    summary.appendChild(label);
    const caret = document.createElement("span");
    caret.className = "details-caret";
    caret.textContent = "›";
    summary.appendChild(caret);
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "reasoning-content";
    body.textContent = content || "";
    details.appendChild(body);
    const contentDiv = bubble.querySelector(".message-content");
    if (contentDiv) bubble.insertBefore(details, contentDiv);
    else bubble.appendChild(details);
  }

  function appendMessage(role, content, messageId, { scroll = true, reference } = {}) {
    if (!state.messagesEl) return null;
    state.messagesEl.querySelector("#empty-state")?.remove();
    const message = document.createElement("div");
    message.className = `message ${role}`;
    if (messageId) message.dataset.messageId = messageId;
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    const renderedText = role === "user" ? formatUserMessageContent(content) : formatMessageContent(content);
    contentDiv.dataset.raw = renderedText;
    if (role === "user" && Array.isArray(content)) {
      appendUserMessageParts(contentDiv, content);
    } else if (role === "assistant" && typeof content === "string" && content) {
      contentDiv.classList.add("markdown-body");
      renderContent(contentDiv, renderedText);
    } else {
      contentDiv.textContent = renderedText;
    }
    bubble.appendChild(contentDiv);

    if (role === "user" && shouldCollapseUserMessage(content)) {
      appendUserMessageToggle(bubble, contentDiv);
    }

    if (role === "user" && messageId) {
      const restart = document.createElement("button");
      restart.className = "restart-round-btn";
      restart.title = "从这里重新开始";
      restart.innerHTML = '<i data-lucide="refresh-ccw"></i>';
      restart.addEventListener("click", (event) => {
        event.stopPropagation();
        onRestart(messageId, extractUserText(content));
      });
      message.appendChild(restart);
    }
    message.appendChild(bubble);
    if (role === "user") {
      const referenceData = reference === undefined ? getUserReference(content) : normalizeUserReference(reference);
      if (referenceData) appendUserReference(bubble, referenceData);
    }
    state.messagesEl.appendChild(message);
    if (scroll) scrollToBottom();
    window.lucide?.createIcons();
    return bubble;
  }

  return { appendMessage, renderMessages };
}

export function buildUserMessageContent(text, images) {
  if (!images?.length) return text;
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: image.url, path: image.path } });
  }
  return parts;
}

/** 用户消息（含图片）按内容分支构建 DOM：文本段 + 可点击预览的缩略图。
    连续图片归入同一个横向 flex 行（.message-image-row），多图不竖向堆叠。 */
function appendUserMessageParts(contentDiv, parts) {
  let imageRow = null;
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      imageRow = null;
      const textEl = document.createElement("div");
      textEl.className = "user-message-text";
      textEl.textContent = extractDisplayUserText(part.text);
      contentDiv.appendChild(textEl);
    } else if (part.type === "image_url" && part.image_url?.url) {
      if (!imageRow) {
        imageRow = document.createElement("div");
        imageRow.className = "message-image-row";
        contentDiv.appendChild(imageRow);
      }
      imageRow.appendChild(createImageThumb(part.image_url.url, part.image_url.path));
    }
  }
}

function createImageThumb(url, path) {
  const img = document.createElement("img");
  img.className = "message-image-thumb";
  img.src = url;
  img.alt = path || "clipboard:image.png";
  img.title = path || "clipboard:image.png";
  img.loading = "lazy";
  img.addEventListener("click", () => openImagePreview(url, path));
  return img;
}

export function extractUserText(content) {
  if (typeof content === "string") return extractDisplayUserText(content);
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => extractDisplayUserText(part.text))
    .join("\n");
}

function formatMessageContent(content) {
  if (typeof content === "string") return content || "";
  if (!Array.isArray(content)) return "";
  const lines = [];
  for (const part of content) {
    if (part.type === "text" && part.text) lines.push(part.text);
    if (part.type === "image_url") lines.push(`[图片] ${part.image_url?.path || "clipboard:image.png"}`);
  }
  return lines.join("\n");
}

function formatUserMessageContent(content) {
  if (typeof content === "string") return extractDisplayUserText(content);
  if (!Array.isArray(content)) return "";
  return formatMessageContent(
    content.map((part) =>
      part.type === "text" && part.text ? { ...part, text: extractDisplayUserText(part.text) } : part,
    ),
  );
}

function extractDisplayUserText(text) {
  return parseUserMessageContent(text).text;
}

function getUserReference(content) {
  if (typeof content === "string") {
    const parsed = parseUserMessageContent(content);
    return parsed.previewPath || parsed.selectedText ? parsed : null;
  }
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part?.type !== "text" || !part.text) continue;
    const parsed = parseUserMessageContent(part.text);
    if (parsed.previewPath || parsed.selectedText) return parsed;
  }
  return null;
}

function normalizeUserReference(reference) {
  if (!reference || typeof reference !== "object") return null;
  const previewPath = String(reference.previewPath || "").trim();
  const selectedText = String(reference.selectedText ?? reference.selectedPreviewText ?? "").replace(
    SELECTION_LINE_HINT_PATTERN,
    "",
  );
  if (!previewPath && !selectedText.trim()) return null;
  return { previewPath, selectedText };
}

function appendUserReference(bubble, reference) {
  const wrap = document.createElement("div");
  wrap.className = "message-reference";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "message-reference-toggle";
  toggle.title = "查看引用内容";
  toggle.setAttribute("aria-label", "查看引用内容");
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = '<i data-lucide="chevron-right"></i>';

  const panel = document.createElement("div");
  panel.className = "message-reference-panel";
  panel.hidden = true;

  if (reference.previewPath) {
    const row = document.createElement("div");
    row.className = "message-reference-row";
    const label = document.createElement("span");
    label.className = "message-reference-label";
    label.textContent = "引用文件：";
    const path = document.createElement("span");
    path.className = "message-reference-path";
    path.textContent = reference.previewPath;
    row.append(label, path);
    panel.appendChild(row);
  }

  if (reference.selectedText.trim()) {
    const row = document.createElement("div");
    row.className = "message-reference-row";
    const label = document.createElement("span");
    label.className = "message-reference-label";
    label.textContent = "引用文字：";
    const text = document.createElement("pre");
    text.className = "message-reference-text";
    text.textContent = reference.selectedText;
    row.append(label, text);
    panel.appendChild(row);
  }

  toggle.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.classList.toggle("is-open", open);
    toggle.title = open ? "收起引用内容" : "查看引用内容";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(open));
  });

  wrap.append(toggle, panel);
  bubble.appendChild(wrap);
}

function shouldCollapseUserMessage(content) {
  const text = extractUserText(content);
  return (
    Array.from(text).length > USER_MESSAGE_COLLAPSE_THRESHOLD ||
    text.split(/\r?\n/).length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD
  );
}

function appendUserMessageToggle(bubble, contentDiv) {
  bubble.classList.add("is-collapsible", "is-collapsed");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "user-message-toggle";
  toggle.textContent = "展开";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "展开完整用户消息");
  toggle.addEventListener("click", () => {
    const isCollapsed = bubble.classList.toggle("is-collapsed");
    toggle.textContent = isCollapsed ? "展开" : "收起";
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.setAttribute("aria-label", isCollapsed ? "展开完整用户消息" : "收起用户消息");
    if (isCollapsed) contentDiv.scrollIntoView({ block: "nearest" });
  });
  bubble.appendChild(toggle);
}

function getToolCallName(toolCall) {
  return toolCall?.function?.name || toolCall?.name || "Tool";
}

function getToolCallInput(toolCall) {
  const args = toolCall?.function?.arguments;
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function isHistoricalToolError(content) {
  return /^(Tool error:|Tool not found:|Failed to |old_string not found\b)/i.test(String(content || ""));
}
