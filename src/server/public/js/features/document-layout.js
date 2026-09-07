/* Panel width management for the Cursor-like three-column workspace.
 *
 * Left: file explorer (#sidebar)  →  #explorer-resize
 * Right: AI chat (#chat-panel)     →  #chat-rail-resize
 */

let explorerWidth = Number(localStorage.getItem("explorerWidth") || 270);
if (!Number.isFinite(explorerWidth)) explorerWidth = 270;
explorerWidth = Math.min(360, Math.max(180, explorerWidth));

let chatPanelWidth = Number(localStorage.getItem("chatPanelWidth") || 440);
if (!Number.isFinite(chatPanelWidth)) chatPanelWidth = 440;
chatPanelWidth = Math.min(640, Math.max(320, chatPanelWidth));

export function getChatPanelWidth() {
  return chatPanelWidth;
}

export function applyExplorerWidth() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || sidebar.classList.contains("collapsed")) return;
  sidebar.style.width = `${explorerWidth}px`;
}

export function initDocExplorerResizeHandle() {
  const handle = document.getElementById("explorer-resize");
  const sidebar = document.getElementById("sidebar");
  if (!handle || !sidebar || handle.dataset.initialized) return;
  handle.dataset.initialized = "true";

  handle.addEventListener("mousedown", (event) => {
    if (sidebar.classList.contains("collapsed")) return;
    event.preventDefault();
    handle.classList.add("dragging");
    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const onMove = (moveEvent) => {
      explorerWidth = Math.min(360, Math.max(180, startWidth + moveEvent.clientX - startX));
      sidebar.style.width = `${explorerWidth}px`;
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      localStorage.setItem("explorerWidth", String(explorerWidth));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

export function initChatRailResizeHandle() {
  const handle = document.getElementById("chat-rail-resize");
  const panel = document.getElementById("chat-panel");
  if (!handle || !panel || handle.dataset.initialized) return;
  handle.dataset.initialized = "true";

  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    handle.classList.add("dragging");
    const panelRight = panel.getBoundingClientRect().right;
    const onMove = (moveEvent) => {
      chatPanelWidth = Math.min(640, Math.max(320, panelRight - moveEvent.clientX));
      panel.style.width = `${chatPanelWidth}px`;
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      localStorage.setItem("chatPanelWidth", String(chatPanelWidth));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// Kept for backwards compatibility with older call sites.
export function initSidebarResizeHandle() {
  // no-op: explorer width is managed by initDocExplorerResizeHandle
}

export function getDocRailWidth() {
  return chatPanelWidth;
}
