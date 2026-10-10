import { escapeHtml } from "../format.js";

export function createPermissionFeature({ send }) {
  let writePermOpen = localStorage.getItem("toolWritePermOpen") === "true";
  /** Map<requestId, permission message> — requests survive session switches. */
  const pendingRequests = new Map();
  /** The requestId currently displayed in the dialog */
  let activeRequestId = null;

  let _escapeBound = false;

  function init() {
    const checkbox = document.getElementById("write-perm-checkbox");
    if (!checkbox) return;
    checkbox.checked = writePermOpen;
    checkbox.addEventListener("change", () => {
      writePermOpen = checkbox.checked;
      localStorage.setItem("toolWritePermOpen", String(writePermOpen));
      sync();
    });
    document.getElementById("tool-permission-allow")?.addEventListener("click", () => resolve(true));
    document.getElementById("tool-permission-deny")?.addEventListener("click", () => resolve(false));
    // Esc to deny — bind only once since it's on document, not on a recreated element
    if (!_escapeBound) {
      _escapeBound = true;
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && document.getElementById("tool-permission-dialog")?.classList.contains("open")) {
          event.preventDefault();
          resolve(false);
        }
      });
    }
  }

  function sync() {
    send({ type: "setWritePermission", enabled: writePermOpen });
  }

  function renderDialog(message) {
    const titleEl = document.getElementById("tool-permission-title");
    const bodyEl = document.getElementById("tool-permission-body");
    const dialog = document.getElementById("tool-permission-dialog");
    const titleMap = {
      write: "写入文件",
      edit: "编辑文件",
      delete: "删除文件",
      move: "移动文件",
      web_search: "Web Search",
      web_fetch: "Web Fetch",
    };
    titleEl.textContent = titleMap[message.toolName] ?? "操作确认";

    const details = message.details || {};
    const rows = [];
    if (details.path) rows.push({ label: "路径", value: details.path });
    if (details.newPath) rows.push({ label: "新路径", value: details.newPath });
    if (details.preview) rows.push({ label: "内容", value: details.preview + (details.preview.length >= 100 ? "…" : "") });
    if (details.oldPreview !== undefined) rows.push({ label: "替换前", value: details.oldPreview + (details.oldPreview.length >= 80 ? "…" : "") });
    if (details.newPreview !== undefined) rows.push({ label: "替换后", value: details.newPreview + (details.newPreview.length >= 80 ? "…" : "") });
    if (details.query) rows.push({ label: "搜索词", value: details.query });
    if (details.urls) rows.push({ label: "URL", value: details.urls });

    bodyEl.innerHTML = rows.map((row) =>
      `<div class="perm-row"><span class="perm-label">${row.label}</span><span class="perm-value">${escapeHtml(row.value)}</span></div>`,
    ).join("");
    dialog.classList.add("open");
  }

  function show(message) {
    const dialog = document.getElementById("tool-permission-dialog");
    pendingRequests.set(message.requestId, message);
    dialog.classList.remove("open");
    activeRequestId = message.requestId;
    renderDialog(message);
  }

  function resolve(allowed) {
    if (!activeRequestId) return;
    const requestId = activeRequestId;
    pendingRequests.delete(requestId);
    activeRequestId = null;
    document.getElementById("tool-permission-dialog")?.classList.remove("open");
    send({ type: "toolPermissionResponse", requestId, allowed });
  }

  /** Hide the dialog without resolving its server-side permission request. */
  function hideActive() {
    document.getElementById("tool-permission-dialog")?.classList.remove("open");
    activeRequestId = null;
  }

  function showForSession(sessionId) {
    for (const message of pendingRequests.values()) {
      if (message.sessionId === sessionId) {
        show(message);
        return true;
      }
    }
    return false;
  }

  function clearForSession(sessionId) {
    for (const [requestId, message] of pendingRequests) {
      if (message.sessionId === sessionId) pendingRequests.delete(requestId);
    }
    if (activeRequestId && !pendingRequests.has(activeRequestId)) {
      activeRequestId = null;
      document.getElementById("tool-permission-dialog")?.classList.remove("open");
    }
  }

  return {
    init,
    show,
    sync,
    hideActive,
    showForSession,
    clearForSession,
    pendingCount: () => pendingRequests.size,
  };
}
