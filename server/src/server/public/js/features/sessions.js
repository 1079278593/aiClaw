import { requestJson, jsonRequest } from "../api.js";
import { escHtml } from "../format.js";

export function createSessionFeature({ state, socket, renderer, pickers, permissions, actions }) {
  async function loadClientConfig() {
    const { data } = await requestJson("/api/config");
    state.availableProviders = Array.isArray(data?.availableProviders) ? data.availableProviders : ["zai"];
    state.providerConfigs = data?.providers || {};
    state.defaultProvider = data?.defaultProvider || "zai";
    state.defaultModel = data?.defaultModel || "glm-4.7";
    state.defaultThinkingEffort = data?.defaultThinkingEffort || "off";
    state.gitSyncEnabled = data?.gitSyncEnabled === true;
    state.currentProvider = state.defaultProvider;
    state.currentModel = state.defaultModel;
    state.currentThinkingEffort = state.defaultThinkingEffort;
    const current = state.sessions.find((session) => session.id === state.currentSessionId);
    if (current) applySessionRuntimeState(current);
    actions.syncModelControls();
  }

  async function loadAppState() {
    try {
      const { data } = await requestJson("/api/app-state");
      state.lastActiveSessionId = data?.lastActiveSessionId || null;
      state.recentModels = Array.isArray(data?.recentModels) ? data.recentModels : [];
    } catch {
      state.lastActiveSessionId = null;
      state.recentModels = [];
    }
  }

  async function loadSessions() {
    const { data } = await requestJson("/api/sessions");
    state.sessions = data.sessions || [];
    renderSessionList();
    if (!state.sessions.length) {
      state.currentSessionId = null;
      state.latestUsage = null;
      state.currentSessionMessageCount = 0;
      state.currentMessages = [];
      actions.renderChatArea();
      return;
    }
    if (!state.currentSessionId) {
      const preferred = state.sessions.find((session) => session.id === state.lastActiveSessionId) || state.sessions[0];
      selectSession(preferred.id);
    }
  }

  async function createSession() {
    const { response, data } = await requestJson("/api/sessions", jsonRequest("POST", {}));
    if (!response.ok || !data.session) {
      actions.showError(data.error || "创建对话失败");
      return;
    }
    state.sessions.unshift(data.session);
    renderSessionList();
    selectSession(data.session.id);
  }

  async function renameSessionById(id) {
    const session = state.sessions.find((item) => item.id === id);
    if (!session) return;
    const input = prompt("请输入新的对话名称：", session.title);
    if (input == null) return;
    const title = input.trim();
    if (!title || title === session.title) return;
    const { response, data } = await requestJson(`/api/sessions/${id}`, jsonRequest("PATCH", { title }));
    if (!response.ok || !data.session) {
      actions.showError(data.error || "重命名失败");
      return;
    }
    Object.assign(session, data.session);
    state.sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    renderSessionList();
    if (state.currentSessionId === id) {
      const titleEl = document.getElementById("chat-title");
      if (titleEl) titleEl.textContent = data.session.title;
    }
  }

  function joinSession(id) {
    state.sessionLoadRequestId = `${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    socket.send({ type: "joinSession", sessionId: id, requestId: state.sessionLoadRequestId });
  }

  async function loadSession(id) {
    const { response, data } = await requestJson(`/api/sessions/${id}`);
    if (response.ok && data.session?.id === state.currentSessionId) {
      applySessionRuntimeState(data.session);
      state.currentSessionMessageCount = data.session.messages.length;
      state.currentMessages = data.session.messages;
      state.currentRoundAnchor = null;
      renderer.renderMessages(data.session.messages);
      actions.syncCompactButton();
    }
  }

  function applySessionRuntimeState(session) {
    state.currentProvider = session?.lastProvider || state.defaultProvider;
    state.currentModel = session?.lastModel || state.defaultModel;
    state.currentThinkingEffort = session?.lastThinkingEffort || state.defaultThinkingEffort;
    actions.syncModelControls();
  }

  async function refreshSessionSummary(id) {
    const { response, data } = await requestJson(`/api/sessions/${id}`);
    if (!response.ok || !data.session) return;
    const session = state.sessions.find((item) => item.id === id);
    if (!session) return;
    Object.assign(session, data.session);
    if (id === state.currentSessionId) {
      state.currentSessionMessageCount = data.session.messages.length;
      state.currentMessages = data.session.messages;
    }
    const cached = state.sessionCache.get(id);
    if (cached) {
      cached.currentSessionMessageCount = data.session.messages.length;
      cached.currentMessages = data.session.messages;
    }
    renderSessionList();
  }

  function saveSessionState(sessionId) {
    if (!sessionId || !state.messagesEl) return;
    // Timers close over the mutable current session state. Stop them before
    // switching so a delayed callback cannot update another session's DOM.
    if (state.processTimer !== null) {
      clearTimeout(state.processTimer);
      state.processTimer = null;
    }
    const childNodes = [];
    while (state.messagesEl.firstChild) childNodes.push(state.messagesEl.removeChild(state.messagesEl.firstChild));
    const existing = state.sessionCache.get(sessionId);
    state.sessionCache.set(sessionId, {
      childNodes,
      isStreaming: state.isStreaming,
      currentRunId: state.currentRunId,
      lastStreamSequence: state.lastStreamSequence,
      streamingBubble: state.streamingBubble,
      streamingReasoningBlock: state.streamingReasoningBlock,
      currentTextSegment: state.currentTextSegment,
      pendingToolBlocks: { ...state.pendingToolBlocks },
      typingPlaceholder: state.typingPlaceholder,
      compactingBubble: state.compactingBubble,
      pendingSubmission: state.pendingSubmission,
      pendingUserBubble: state.pendingUserBubble,
      latestUsage: state.latestUsage,
      currentSessionMessageCount: state.currentSessionMessageCount,
      currentMessages: [...state.currentMessages],
      pendingImages: [...state.pendingImages],
      currentProvider: state.currentProvider,
      currentModel: state.currentModel,
      currentThinkingEffort: state.currentThinkingEffort,
      isCompacting: state.isCompacting,
      userScrolledUp: state.userScrolledUp,
      hasRoundAnchor: state.messagesEl.classList.contains("round-anchor-active"),
      visibleProcessStep: state.visibleProcessStep,
      pendingProcessStep: state.pendingProcessStep,
      visibleProcessSince: state.visibleProcessSince,
      pendingEvents: existing?.pendingEvents || [],
    });
  }

  function restoreSessionState(sessionId) {
    const cached = state.sessionCache.get(sessionId);
    if (!cached || !state.messagesEl) return false;
    while (state.messagesEl.firstChild) state.messagesEl.removeChild(state.messagesEl.firstChild);
    for (const node of cached.childNodes) state.messagesEl.appendChild(node);
    state.isStreaming = cached.isStreaming;
    state.currentRunId = cached.currentRunId || null;
    state.lastStreamSequence = cached.lastStreamSequence || 0;
    state.streamingBubble = cached.streamingBubble;
    state.streamingReasoningBlock = cached.streamingReasoningBlock;
    state.currentTextSegment = cached.currentTextSegment || null;
    state.pendingToolBlocks = cached.pendingToolBlocks;
    state.typingPlaceholder = cached.typingPlaceholder;
    state.compactingBubble = cached.compactingBubble;
    state.pendingSubmission = cached.pendingSubmission;
    state.pendingUserBubble = cached.pendingUserBubble;
    state.latestUsage = cached.latestUsage;
    state.currentSessionMessageCount = cached.currentSessionMessageCount;
    state.currentMessages = cached.currentMessages;
    state.pendingImages = cached.pendingImages;
    state.currentProvider = cached.currentProvider;
    state.currentModel = cached.currentModel;
    state.currentThinkingEffort = cached.currentThinkingEffort;
    state.isCompacting = cached.isCompacting;
    state.userScrolledUp = cached.userScrolledUp || false;
    const userMessages = state.messagesEl.querySelectorAll(".message.user");
    state.currentRoundAnchor = userMessages[userMessages.length - 1] || null;
    state.messagesEl.classList.toggle("round-anchor-active", Boolean(cached.hasRoundAnchor));
    state.visibleProcessStep = cached.visibleProcessStep || null;
    state.pendingProcessStep = cached.pendingProcessStep || null;
    state.visibleProcessSince = cached.visibleProcessSince || 0;
    state.processTimer = null;
    return true;
  }

  function selectSession(id) {
    const target = state.sessions.find((session) => session.id === id);
    permissions.hideActive();
    saveSessionState(state.currentSessionId);
    state.currentSessionId = id;
    // 若会话列表面板正打开着（show-home），切换到新会话后自动收起
    actions.setChatHomeVisible?.(false);
    const inputSnapshot = state.inputEl?.value ?? "";
    const restored = restoreSessionState(id);
    if (!restored) {
      resetRuntimeState(target);
      renderSessionList();
      actions.renderChatArea();
      // Trigger session-enter animation on the newly created messages container
      if (state.messagesEl) {
        state.messagesEl.classList.add("session-enter");
        state.messagesEl.addEventListener("animationend", () => {
          state.messagesEl?.classList.remove("session-enter");
        }, { once: true });
      }
      if (state.inputEl && inputSnapshot) {
        state.inputEl.value = inputSnapshot;
        actions.autoResizeInput();
      }
    } else {
      const title = document.getElementById("chat-title");
      if (title) title.textContent = target?.title || "";
      actions.updateTokenDisplay(state.latestUsage);
      actions.syncCompactButton();
      renderSessionList();
      actions.syncModelControls();
      pickers.renderPendingImages();
      if (state.messagesEl?.classList.contains("round-anchor-active")) actions.scrollRoundAnchorToTop();
      else actions.scrollToBottom();
      if (state.isStreaming && !state.streamingBubble) {
        state.streamingBubble = renderer.appendMessage("assistant", "", undefined, { scroll: false });
        state.typingPlaceholder = actions.appendTypingDots(state.streamingBubble);
      }
      actions.replaySessionEvents();
    }
    actions.setSendDisabled(restored ? state.isStreaming : false);
    permissions.showForSession(id);
    joinSession(id);
  }

  function resetRuntimeState(session) {
    state.isStreaming = false;
    state.currentRunId = null;
    state.lastStreamSequence = 0;
    state.streamingBubble = null;
    state.streamingReasoningBlock = null;
    state.pendingToolBlocks = {};
    state.typingPlaceholder = null;
    state.compactingBubble = null;
    state.currentProvider = session?.lastProvider || state.defaultProvider;
    state.currentModel = session?.lastModel || state.defaultModel;
    state.currentThinkingEffort = session?.lastThinkingEffort || state.defaultThinkingEffort;
    state.latestUsage = null;
    state.currentSessionMessageCount = 0;
    state.currentMessages = [];
    state.pendingImages = [];
    state.userScrolledUp = false;
    state.currentRoundAnchor = null;
    state.visibleProcessStep = null;
    state.pendingProcessStep = null;
    state.visibleProcessSince = 0;
    state.processTimer = null;
  }

  async function deleteSessionById(id) {
    if (!confirm("确定删除这个对话吗？")) return;
    await requestJson(`/api/sessions/${id}`, { method: "DELETE" });
    state.sessions = state.sessions.filter((session) => session.id !== id);
    state.sessionCache.delete(id);
    if (state.currentSessionId === id) {
      // 当前会话被删除：先断开 currentSessionId，再走与点击切换一致的 selectSession
      // 路径，确保缓存恢复、排队事件重放（replaySessionEvents）、运行时状态重置等
      // 逻辑完整执行，避免残留生成状态（typing-dots 永久跳动）。
      state.currentSessionId = null;
      const next = state.sessions[0]?.id || null;
      if (next) {
        selectSession(next);
      } else {
        state.latestUsage = null;
        state.currentSessionMessageCount = 0;
        state.currentMessages = [];
        actions.renderChatArea();
      }
    }
    renderSessionList();
  }

  function renderSessionList() {
    const list = document.getElementById("session-list");
    if (!list) return;
    if (!state.sessions.length) {
      list.innerHTML = '<div class="session-list-empty">暂无对话</div>';
      return;
    }
    list.innerHTML = state.sessions.map((session) => `
      <div class="session-item ${session.id === state.currentSessionId ? "active" : ""}" data-id="${session.id}">
        <div class="session-item-content"><div class="session-title" title="双击重命名">${escHtml(session.title)}</div><div class="session-meta">${session.messages?.filter((message) => message.role === "user").length || 0} 条消息</div></div>
        <button class="session-delete-btn" data-id="${session.id}" title="删除对话" aria-label="删除对话"><i data-lucide="trash-2"></i></button>
      </div>`).join("");
    window.lucide?.createIcons();
    list.querySelectorAll(".session-item").forEach((element) => {
      element.addEventListener("click", (event) => {
        if (!event.target.closest(".session-delete-btn")) selectSession(element.dataset.id);
      });
    });
    list.querySelectorAll(".session-delete-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void deleteSessionById(button.dataset.id);
      });
    });
    list.querySelectorAll(".session-title").forEach((element) => {
      element.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        void renameSessionById(element.closest(".session-item")?.dataset.id);
      });
    });
  }

  return {
    applySessionRuntimeState,
    createSession,
    joinSession,
    loadAppState,
    loadClientConfig,
    loadSession,
    loadSessions,
    refreshSessionSummary,
    renameSessionById,
    renderSessionList,
    selectSession,
  };
}
