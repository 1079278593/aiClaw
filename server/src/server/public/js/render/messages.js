import { renderContent } from "../markdown.js";

const USER_MESSAGE_COLLAPSE_THRESHOLD = 400;
const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 5;

export function createMessageRenderer({ state, streaming, onRestart, scrollToBottom }) {
  function renderMessages(messages) {
    if (!state.messagesEl) return;
    state.messagesEl.classList.remove("round-anchor-active");
    if (!messages.length) {
      state.messagesEl.innerHTML = '<div id="empty-state" class="empty-state"><div class="empty-state-icon"><i data-lucide="message-circle"></i></div><p class="empty-state-title">发送消息开始对话</p></div>';
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

  function appendMessage(role, content, messageId, { scroll = true } = {}) {
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
    if (role === "assistant" && typeof content === "string" && content) {
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

export function extractUserText(content) {
  if (typeof content === "string") return extractDisplayUserText(content);
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => extractDisplayUserText(part.text)).join("\n");
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
  return formatMessageContent(content.map((part) =>
    part.type === "text" && part.text ? { ...part, text: extractDisplayUserText(part.text) } : part,
  ));
}

function extractDisplayUserText(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const match = /^<系统提示>\n[\s\S]*?\n<\/系统提示>\n用户消息：([\s\S]*)$/.exec(normalized);
  return match ? match[1] : normalized;
}

function shouldCollapseUserMessage(content) {
  const text = extractUserText(content);
  return Array.from(text).length > USER_MESSAGE_COLLAPSE_THRESHOLD
    || text.split(/\r?\n/).length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD;
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
