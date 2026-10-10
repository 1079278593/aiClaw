import { requestJson, jsonRequest } from "../api.js";
import { escHtml } from "../format.js";
import { buildUserMessageContent, extractUserText } from "../render/messages.js";

const ROUND_ANCHOR_TOP_OFFSET = 22;

export function createChatFeature({
  state,
  socket,
  renderer,
  streaming,
  pickers,
  permissions,
  documents,
  actions,
}) {
  function sendMessage() {
    if (state.isStreaming) { cancelChat(); return; }
    if (!state.inputEl) return;
    const content = state.inputEl.value.trim();
    if ((!content && !state.pendingImages.length) || !state.currentSessionId) return;
    const images = state.pendingImages.map((image) => ({ url: image.url, path: image.path }));
    setSendDisabled(true);
    state.pendingUserBubble = renderer.appendMessage("user", buildUserMessageContent(content, images), undefined, { scroll: false });
    if (state.pendingUserBubble) {
      const msgEl = state.pendingUserBubble.closest(".message");
      if (msgEl) {
        state.currentRoundAnchor = msgEl;
        msgEl.classList.add("message-new");
        msgEl.addEventListener("animationend", () => msgEl.classList.remove("message-new"), { once: true });
      }
    }
    state.userScrolledUp = false;
    scrollRoundAnchorToTop();
    state.currentSessionMessageCount++;
    state.pendingSubmission = { content, images };
    socket.send({
      type: "chatMessage",
      sessionId: state.currentSessionId,
      content,
      images,
      provider: state.currentProvider,
      model: state.currentModel,
      thinkingEffort: state.currentThinkingEffort,
      ...documents.getPreviewContextPayload(),
    });
    documents.clearPreviewSelection();
    state.inputEl.value = "";
    state.inputEl.style.height = "auto";
    state.pendingImages = [];
    pickers.renderPendingImages();
  }

  function cancelChat() {
    if (!state.currentSessionId) return;
    socket.send({ type: "cancelChat", sessionId: state.currentSessionId });
  }

  function updateSendAvailability() {
    if (!state.sendBtn || state.isStreaming) return;
    const hasContent = Boolean(state.inputEl?.value.trim()) || state.pendingImages.length > 0;
    state.sendBtn.disabled = !hasContent || !state.currentSessionId;
  }

  function setSendDisabled(disabled) {
    if (disabled) {
      // Show cancel button while streaming
      if (state.sendBtn) {
        state.sendBtn.disabled = false;
        state.sendBtn.innerHTML = '<i data-lucide="square" class="send-stop-icon"></i>';
        state.sendBtn.title = "取消生成";
        state.sendBtn.setAttribute("aria-label", "取消生成");
        window.lucide?.createIcons();
      }
    } else {
      if (state.sendBtn) {
        state.sendBtn.innerHTML = '<i data-lucide="arrow-up"></i>';
        state.sendBtn.title = "发送";
        state.sendBtn.setAttribute("aria-label", "发送");
        updateSendAvailability();
        window.lucide?.createIcons();
      }
    }
    if (state.inputEl) state.inputEl.disabled = disabled;
  }

  async function restartFromMessage(messageId, text) {
    if (!state.currentSessionId || state.isStreaming || state.isCompacting) return;
    if (!confirm("确定要从这条消息重新开始吗？\n\n这条消息及之后的所有回复将被删除，原文会保留在输入框中供你修改。")) return;
    try {
      const { response, data } = await requestJson(
        `/api/sessions/${state.currentSessionId}/truncate`,
        jsonRequest("POST", { messageId }),
      );
      if (!response.ok) throw new Error(data.error || "Truncation failed");
      await actions.loadSession(state.currentSessionId);
      if (state.inputEl) {
        state.inputEl.value = text;
        state.inputEl.style.height = "auto";
        state.inputEl.style.height = Math.min(state.inputEl.scrollHeight, 200) + "px";
        state.inputEl.focus();
      }
    } catch (error) {
      showError(error?.message || "Restart failed");
    }
  }

  function compactCurrentSession() {
    if (!state.currentSessionId || state.isStreaming || state.isCompacting || state.currentSessionMessageCount < 2) return;
    const select = document.getElementById("compact-keep-rounds");
    const totalRounds = state.currentMessages.filter((message) => message.role === "user").length;
    for (const option of select.options) {
      const keepRounds = Number(option.value);
      option.disabled = keepRounds > 0 && totalRounds <= keepRounds + 1;
    }
    select.value = "0";
    document.getElementById("compact-modal").classList.add("open");
  }

  function closeCompactModal(force = false) {
    if (state.isCompacting && !force) return;
    document.getElementById("compact-modal").classList.remove("open");
  }

  async function doCompact() {
    if (!state.currentSessionId || state.isStreaming || state.isCompacting || state.currentSessionMessageCount < 2) return;
    closeCompactModal(true);
    state.currentRoundAnchor = null;
    state.messagesEl?.classList.remove("round-anchor-active");
    state.isCompacting = true;
    syncCompactButton();
    document.getElementById("compact-confirm-btn").disabled = true;
    const keepRecentRounds = Number(document.getElementById("compact-keep-rounds")?.value || 0);
    state.compactingBubble = renderer.appendMessage("assistant", "");
    streaming.appendTypingDots(state.compactingBubble);
    try {
      const { response, data } = await requestJson(
        `/api/sessions/${state.currentSessionId}/compact`,
        jsonRequest("POST", { keepRecentRounds }),
      );
      if (!response.ok) throw new Error(data.error || "Compaction failed");
      await actions.loadSession(state.currentSessionId);
      state.sessionCache.delete(state.currentSessionId);
      state.compactingBubble = null;
    } catch (error) {
      state.compactingBubble?.parentElement?.remove();
      state.compactingBubble = null;
      showError(error?.message || "Compaction failed");
    } finally {
      state.isCompacting = false;
      document.getElementById("compact-confirm-btn").disabled = false;
      syncCompactButton();
    }
  }

  function formatContextTokens(value) {
    const number = Number(value || 0);
    const absolute = Math.abs(number);
    if (absolute <= 1000) return String(Math.round(number));
    if (absolute < 10000) return `${(number / 1000).toFixed(1)}k`;
    return `${(number / 10000).toFixed(1)}W`;
  }

  function updateTokenDisplay(usage) {
    if (!state.tokenDisplayEl) return;
    if (!usage) {
      state.tokenDisplayEl.textContent = "";
      state.tokenDisplayEl.style.display = "none";
      return;
    }
    const input = usage.inputTokens || 0;
    const output = usage.billingOutputTokens ?? usage.outputTokens ?? 0;
    state.tokenDisplayEl.textContent = formatContextTokens(input + output);
    state.tokenDisplayEl.style.display = "inline-flex";
  }

  function syncCompactButton() {
    if (!state.compactBtnEl) return;
    state.compactBtnEl.disabled = !state.currentSessionId || state.currentSessionMessageCount < 2 || state.isStreaming || state.isCompacting;
  }

  function showError(message) {
    if (!state.messagesEl) return;
    const element = document.createElement("div");
    element.className = "error-message";
    element.innerHTML = `<span class="error-message-dot"></span><span class="error-message-text">${escHtml(message || "Unknown error")}</span>`;
    state.messagesEl.appendChild(element);
    scrollToBottom();
  }

  function scrollToBottom() {
    if (state.messagesEl && !state.userScrolledUp) {
      state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
    }
  }

  function scrollRoundAnchorToTop() {
    const container = state.messagesEl;
    const anchor = state.currentRoundAnchor;
    if (!container || !anchor?.isConnected) return;
    container.classList.add("round-anchor-active");
    const anchorOffset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += anchorOffset - ROUND_ANCHOR_TOP_OFFSET;
  }

  function bindScrollListener() {
    if (!state.messagesEl) return;
    let lastScrollTop = state.messagesEl.scrollTop;
    state.messagesEl.addEventListener("scroll", () => {
      const el = state.messagesEl;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
      if (atBottom) {
        state.userScrolledUp = false;
      } else if (el.scrollTop < lastScrollTop) {
        // User scrolled up explicitly (scrollTop decreased)
        state.userScrolledUp = true;
      }
      // scrolling down but not at bottom: keep current state
      lastScrollTop = el.scrollTop;
    });
  }

  function bindGlobalEvents() {
    document.getElementById("compact-cancel-btn").addEventListener("click", () => closeCompactModal());
    document.getElementById("compact-confirm-btn").addEventListener("click", () => void doCompact());
    document.getElementById("compact-modal").addEventListener("click", (event) => {
      if (event.target.id === "compact-modal") closeCompactModal();
    });
  }

  function handleServerMessage(message) {
    const scopedTypes = ["chatStart", "chatChunk", "chatReasoning", "chatEnd", "chatCancelled", "toolCall", "toolResult", "toolPermissionRequest"];
    if (scopedTypes.includes(message.type) && message.sessionId && message.sessionId !== state.currentSessionId) {
      updateBackgroundSession(message);
      return;
    }
    if (message.type === "error" && message.sessionId && message.sessionId !== state.currentSessionId) {
      updateBackgroundSession(message);
      return;
    }
    if (scopedTypes.includes(message.type) && !acceptStreamEvent(message)) return;

    switch (message.type) {
      case "connected":
        if (state.currentSessionId) actions.joinSession(state.currentSessionId);
        break;
      case "sessionLoaded":
        handleSessionLoaded(message.session, message.requestId);
        break;
      case "chatStart":
        handleChatStart(message);
        break;
      case "chatReasoning":
        state.currentTextSegment = null;
        if (state.streamingBubble) {
          state.streamingReasoningBlock ||= streaming.appendReasoningBlock(state.streamingBubble);
          streaming.appendReasoningChunk(state.streamingReasoningBlock, message.chunk);
        }
        break;
      case "toolCall":
        state.currentTextSegment = null;
        if (state.streamingBubble) state.pendingToolBlocks[message.callId] = streaming.appendToolCallBlock(state.streamingBubble, message.name, message.input);
        break;
      case "toolResult":
        handleToolResult(message);
        break;
      case "chatChunk":
        if (state.streamingBubble) streaming.appendChunk(state.streamingBubble, message.chunk);
        break;
      case "chatEnd":
        handleChatEnd(message);
        break;
      case "chatCancelled":
        handleChatCancelled(message);
        break;
      case "toolPermissionRequest":
        permissions.show(message);
        break;
      case "error":
        handleError(message);
        break;
      default:
        console.warn("Unknown WebSocket message", message);
    }
  }

  function handleSessionLoaded(session, requestId) {
    if (session.id !== state.currentSessionId) return;
    if (requestId && requestId !== state.sessionLoadRequestId) return;
    const local = state.sessions.find((item) => item.id === state.currentSessionId);
    if (local) Object.assign(local, session);
    actions.renderSessionList();
    actions.applySessionRuntimeState(session);
    const cached = state.sessionCache.get(state.currentSessionId);
    const serverCount = session.messages.length;
    const cacheCount = cached ? cached.currentSessionMessageCount : -1;
    if (cached && (cacheCount === serverCount || state.isStreaming)) {
      state.currentSessionMessageCount = serverCount;
      state.currentMessages = session.messages;
      cached.currentMessages = session.messages;
      cached.currentSessionMessageCount = serverCount;
    } else {
      if (cached) state.sessionCache.delete(state.currentSessionId);
      state.currentSessionMessageCount = serverCount;
      state.currentMessages = session.messages;
      state.currentRoundAnchor = null;
      renderer.renderMessages(session.messages);
    }
    syncCompactButton();
  }

  function handleChatStart(message) {
    state.isStreaming = true;
    setSendDisabled(true);
    syncCompactButton();
    state.pendingToolBlocks = {};
    state.streamingReasoningBlock = null;
    state.currentTextSegment = null;
    if (state.pendingUserBubble && message.userMessageId) {
      const messageElement = state.pendingUserBubble.parentElement;
      if (messageElement) {
        messageElement.dataset.messageId = message.userMessageId;
        const userText = state.pendingSubmission ? extractUserText(state.pendingSubmission.content) : "";
        const restart = document.createElement("button");
        restart.className = "restart-round-btn";
        restart.title = "从这里重新开始";
        restart.innerHTML = '<i data-lucide="refresh-ccw"></i>';
        restart.addEventListener("click", (event) => {
          event.stopPropagation();
          void restartFromMessage(message.userMessageId, userText);
        });
        messageElement.appendChild(restart);
        window.lucide?.createIcons();
      }
    }
    if (!state.currentRoundAnchor?.isConnected) {
      const userMessages = state.messagesEl?.querySelectorAll(".message.user");
      state.currentRoundAnchor = userMessages?.[userMessages.length - 1] || null;
      state.userScrolledUp = false;
      scrollRoundAnchorToTop();
    }
    state.streamingBubble = renderer.appendMessage("assistant", "", undefined, { scroll: false });
    // Add entrance animation for the new assistant message
    if (state.streamingBubble) {
      const msgEl = state.streamingBubble.closest(".message");
      if (msgEl) {
        msgEl.classList.add("is-streaming", "message-new");
        msgEl.addEventListener("animationend", () => msgEl.classList.remove("message-new"), { once: true });
      }
    }
    state.typingPlaceholder = streaming.appendTypingDots(state.streamingBubble);
    state.pendingSubmission = null;
    state.pendingUserBubble = null;
  }

  function handleToolResult(message) {
    if (state.pendingToolBlocks[message.callId]) {
      streaming.fillToolResult(state.pendingToolBlocks[message.callId], message.content, message.isError);
      delete state.pendingToolBlocks[message.callId];
    }
    if (!message.isError && ["write", "edit", "move", "delete"].includes(message.name)) documents.refreshDocBrowser();
    state.streamingReasoningBlock = null;
    state.currentTextSegment = null;
    const cached = state.sessionCache.get(state.currentSessionId);
    if (cached) {
      cached.pendingToolBlocks = { ...state.pendingToolBlocks };
      cached.streamingReasoningBlock = null;
    }
  }

  function handleChatCancelled(message) {
    state.isStreaming = false;
    setSendDisabled(false);
    state.inputEl?.focus();
    streaming.removeTypingDots();
    if (state.streamingBubble) streaming.finishStreaming(state.streamingBubble);
    // Append a cancellation marker to the last text segment
    if (state.streamingBubble) {
      const segments = state.streamingBubble.querySelectorAll(".text-segment");
      const last = segments[segments.length - 1];
      if (last) {
        const cancelMark = document.createElement("span");
        cancelMark.className = "cancelled-mark";
        cancelMark.textContent = " (已取消)";
        last.appendChild(cancelMark);
      } else {
        // No text segments — add one with the marker
        const segment = document.createElement("div");
        segment.className = "text-segment markdown-body";
        const cancelMark = document.createElement("span");
        cancelMark.className = "cancelled-mark";
        cancelMark.textContent = "(已取消)";
        segment.appendChild(cancelMark);
        const contentDiv = state.streamingBubble.querySelector(".message-content");
        if (contentDiv) state.streamingBubble.insertBefore(segment, contentDiv);
        else state.streamingBubble.appendChild(segment);
      }
    }
    state.streamingBubble = null;
    state.streamingReasoningBlock = null;
    state.currentTextSegment = null;
    state.pendingToolBlocks = {};
    state.typingPlaceholder = null;
    permissions.clearForSession(message.sessionId);
    void actions.refreshSessionSummary(message.sessionId);
    void actions.refreshRecentModels();
    updateCurrentCache();
    syncCompactButton();
  }

  function handleChatEnd(message) {
    state.isStreaming = false;
    setSendDisabled(false);
    state.inputEl?.focus();
    streaming.removeTypingDots();
    if (state.streamingBubble) streaming.finishStreaming(state.streamingBubble);
    state.streamingBubble = null;
    state.streamingReasoningBlock = null;
    state.currentTextSegment = null;
    state.pendingToolBlocks = {};
    state.typingPlaceholder = null;
    permissions.clearForSession(message.sessionId);
    if (message.contextUsage || message.usage) state.latestUsage = message.contextUsage || message.usage;
    updateTokenDisplay(state.latestUsage);
    void actions.refreshSessionSummary(message.sessionId);
    void actions.refreshRecentModels();
    updateCurrentCache();
    syncCompactButton();
  }

  function handleError(message) {
    state.isStreaming = false;
    setSendDisabled(false);
    state.inputEl?.focus();
    streaming.removeTypingDots();
    if (state.streamingBubble) streaming.finishStreaming(state.streamingBubble);
    state.streamingBubble = null;
    state.streamingReasoningBlock = null;
    state.currentTextSegment = null;
    state.pendingToolBlocks = {};
    state.typingPlaceholder = null;
    if (message.sessionId) permissions.clearForSession(message.sessionId);
    if (state.pendingSubmission) {
      state.inputEl.value = state.pendingSubmission.content || "";
      state.pendingImages = state.pendingSubmission.images || [];
      actions.autoResizeInput();
      pickers.renderPendingImages();
      state.pendingUserBubble?.parentElement?.remove();
      state.pendingSubmission = null;
      state.pendingUserBubble = null;
    }
    state.currentRoundAnchor = null;
    state.messagesEl?.classList.remove("round-anchor-active");
    showError(message.message);
    updateCurrentCache();
    syncCompactButton();
  }

  function updateBackgroundSession(message) {
    const cached = state.sessionCache.get(message.sessionId);
    if (cached) {
      cached.pendingEvents ||= [];
      cached.pendingEvents.push(message);
    }
    if (message.type === "chatEnd" || message.type === "chatCancelled") {
      void actions.refreshSessionSummary(message.sessionId);
      void actions.refreshRecentModels();
    }
  }

  /**
   * A single WebSocket preserves send order, but an old run can still finish
   * after a replacement run has started. runId and sequence make that stale
   * event harmless instead of letting it mutate the visible session.
   */
  function acceptStreamEvent(message) {
    if (message.type === "chatStart") {
      state.currentRunId = message.runId;
      state.lastStreamSequence = message.sequence;
      return true;
    }
    if (!state.isStreaming || message.runId !== state.currentRunId || message.sequence <= state.lastStreamSequence) return false;
    state.lastStreamSequence = message.sequence;
    return true;
  }

  /** Apply events received while this session's DOM was detached. */
  function replaySessionEvents() {
    const cached = state.sessionCache.get(state.currentSessionId);
    if (!cached?.pendingEvents?.length) return;
    const events = cached.pendingEvents.splice(0);
    for (const event of events) handleServerMessage(event);
  }

  function clearCachedStreaming(sessionId) {
    const cached = state.sessionCache.get(sessionId);
    if (!cached) return;
    cached.isStreaming = false;
    cached.streamingBubble = null;
    cached.streamingReasoningBlock = null;
    cached.pendingToolBlocks = {};
    cached.typingPlaceholder = null;
  }

  function updateCurrentCache() {
    const cached = state.sessionCache.get(state.currentSessionId);
    if (!cached) return;
    clearCachedStreaming(state.currentSessionId);
    cached.currentSessionMessageCount = state.currentSessionMessageCount;
    cached.currentMessages = state.currentMessages;
  }

  return {
    bindGlobalEvents,
    compactCurrentSession,
    bindScrollListener,
    handleServerMessage,
    replaySessionEvents,
    restartFromMessage,
    scrollRoundAnchorToTop,
    scrollToBottom,
    sendMessage,
    setSendDisabled,
    showError,
    syncCompactButton,
    updateSendAvailability,
    updateTokenDisplay,
  };
}
