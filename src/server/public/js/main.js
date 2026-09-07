import * as documents from "./features/documents.js";
import { closeKnowledgeModal } from "./features/knowledge.js";
import { closeUsageModal } from "./features/usage.js";
import { initSettings } from "./features/settings.js";
import { closeGitSyncModal } from "./features/git-sync.js";
import { createChatFeature } from "./features/chat.js";
import { createPermissionFeature } from "./features/permissions.js";
import { createPickerFeature } from "./features/pickers.js";
import { createSessionFeature } from "./features/sessions.js";
import { createChatView } from "./dom.js";
import { createMessageRenderer } from "./render/messages.js";
import { createStreamingRenderer } from "./render/streaming.js";
import { createAppState } from "./state.js";
import { createWebSocketClient } from "./websocket.js";

const state = createAppState();
const actions = {};

const socket = createWebSocketClient({
  onMessage: (message) => actions.handleServerMessage(message),
  onStatus: setConnectionStatus,
});
const permissions = createPermissionFeature({ send: socket.send });
const streaming = createStreamingRenderer({ state });
const renderer = createMessageRenderer({
  state,
  streaming,
  onRestart: (messageId, text) => actions.restartFromMessage(messageId, text),
  scrollToBottom: () => actions.scrollToBottom(),
});
const pickers = createPickerFeature({
  state,
  autoResizeInput: () => actions.autoResizeInput(),
  updateSendAvailability: () => actions.updateSendAvailability?.(),
});
const view = createChatView({ state, documents, pickers, permissions, actions });
const chat = createChatFeature({ state, socket, renderer, streaming, pickers, permissions, documents, actions });
const sessions = createSessionFeature({ state, socket, renderer, pickers, permissions, actions });

Object.assign(actions, view, chat, sessions, {
  appendTypingDots: streaming.appendTypingDots,
});

function setConnectionStatus(connected) {
  document.getElementById("status-dot").className = "status-dot" + (connected ? " connected" : "");
  document.getElementById("status-text").textContent = connected ? "已连接" : "未连接";
  if (connected) {
    permissions.sync();
    state.disconnectNotified = false;
    if (state.currentSessionId) actions.joinSession(state.currentSessionId);
    return;
  }
  if (state.currentSessionId && !state.disconnectNotified) {
    state.disconnectNotified = true;
    actions.showError("Connection lost. Reconnecting...");
  }
}

function openHelpModal() {
  document.getElementById("help-modal").classList.add("open");
}

function closeHelpModal() {
  document.getElementById("help-modal").classList.remove("open");
}

function bindGlobalEvents() {
  document.getElementById("help-btn").addEventListener("click", openHelpModal);
  document.getElementById("help-close-btn").addEventListener("click", closeHelpModal);
  document.getElementById("usage-close-btn").addEventListener("click", closeUsageModal);
  document.getElementById("knowledge-close-btn").addEventListener("click", closeKnowledgeModal);
  document.getElementById("git-sync-close-btn").addEventListener("click", closeGitSyncModal);
  document.getElementById("usage-modal").addEventListener("click", (event) => {
    if (event.target.id === "usage-modal") closeUsageModal();
  });
  document.getElementById("knowledge-modal").addEventListener("click", (event) => {
    if (event.target.id === "knowledge-modal") closeKnowledgeModal();
  });
  document.getElementById("git-sync-modal").addEventListener("click", (event) => {
    if (event.target.id === "git-sync-modal") closeGitSyncModal();
  });
  document.getElementById("help-modal").addEventListener("click", (event) => {
    if (event.target.id === "help-modal") closeHelpModal();
  });
  document.addEventListener("selectionchange", documents.updateSelectedPreviewTextFromSelection);
  pickers.bindGlobalEvents();
  chat.bindGlobalEvents();
  // Render initial static lucide icons
  window.lucide?.createIcons();
}

async function boot() {
  initSettings();
  documents.configureDocuments({
    showError: actions.showError,
  });
  bindGlobalEvents();
  await actions.loadClientConfig();
  await actions.loadAppState();
  void documents.initExplorer();
  await actions.loadSessions();
  socket.connect();
}

void boot();
