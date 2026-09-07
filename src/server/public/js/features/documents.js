import { escHtml } from "../format.js";
import { renderContent } from "../markdown.js";
import { initDocExplorerResizeHandle } from "./document-layout.js";
import { getDocSelectionSummary, getSourceLineNumberFromOffset } from "./document-selection.js";

let reportError = (message) => console.error(message);
export function configureDocuments(options) {
  reportError = options.showError;
}

const LOCAL_DOC_BROWSER_ROOTS = ["knowledge_base", "inputs"];
const TRILIUM_ROOT = "trilium";
let triliumEnabled = false;

function getDocBrowserRoots() {
  return triliumEnabled ? [...LOCAL_DOC_BROWSER_ROOTS, TRILIUM_ROOT] : LOCAL_DOC_BROWSER_ROOTS;
}

function isTriliumDocPath(path) {
  return typeof path === "string" && (path === TRILIUM_ROOT || path.startsWith(`${TRILIUM_ROOT}/`));
}
const DOC_ROOT_KEY = "docRootPath";
const DOC_TABS_KEY = "docOpenTabs";
const DOC_RECENT_KEY = "docRecentOpened";
const MAX_RECENT_OPENED = 3;
const EXPANDED_DIRS_KEY = "docExpandedDirs";

let docRootPath = loadDocRootPath();

/** childrenCache: Map<directoryPath, DocBrowserEntry[]> — one level per key */
const childrenCache = new Map();
/** expandedDirs: Set<directoryPath> — directories whose children are shown */
let expandedDirs = new Set(loadExpandedDirs());

// 打开的标签页（跨会话/刷新保留）：{ path, editMode, sticky, label, scrollTop }
let openTabs = loadOpenTabs();
let activeTabPath = openTabs.length ? openTabs[0].path : null;

// 最近打开过的文件路径（最多 3 个，MRU 顺序，跨会话/刷新保留），用于 @ 引用时置顶
let recentOpenedPaths = loadRecentOpened();

// 发送消息时是否附带当前浏览文件路径与选中文本（跨会话保留，默认开启）
let attachDocContext = loadAttachDocContext();

// 当前活动标签的内容状态
let docPreviewContent = "";
let docPreviewSupported = true;
let docPreviewKind = "text";
let selectedPreviewText = "";
let selectedPreviewSummary = "";
let selectedPreviewStartLine = 0;
let selectedPreviewEndLine = 0;

function loadDocRootPath() {
  try {
    const stored = localStorage.getItem(DOC_ROOT_KEY);
    if (stored === TRILIUM_ROOT || LOCAL_DOC_BROWSER_ROOTS.includes(stored)) return stored;
  } catch {
    // ignore
  }
  return LOCAL_DOC_BROWSER_ROOTS[0];
}

function saveDocRootPath() {
  try {
    localStorage.setItem(DOC_ROOT_KEY, docRootPath);
  } catch {
    // ignore
  }
}

function loadExpandedDirs() {
  try {
    const stored = JSON.parse(localStorage.getItem(EXPANDED_DIRS_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((path) => typeof path === "string" && path);
  } catch {
    return [];
  }
}

function saveExpandedDirs() {
  try {
    localStorage.setItem(EXPANDED_DIRS_KEY, JSON.stringify([...expandedDirs]));
  } catch {
    // ignore
  }
}

function loadOpenTabs() {
  try {
    const stored = JSON.parse(localStorage.getItem(DOC_TABS_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((tab) => tab && typeof tab.path === "string" && tab.path)
      .map((tab) => ({
        path: tab.path,
        editMode: isTriliumDocPath(tab.path) ? false : tab.editMode === true,
        sticky: tab.sticky !== false,
        label: typeof tab.label === "string" ? tab.label : undefined,
      }));
  } catch {
    return [];
  }
}

function saveOpenTabs() {
  try {
    localStorage.setItem(DOC_TABS_KEY, JSON.stringify(openTabs));
  } catch {
    // ignore
  }
}

function loadRecentOpened() {
  try {
    const stored = JSON.parse(localStorage.getItem(DOC_RECENT_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((path) => typeof path === "string" && path)
      .slice(0, MAX_RECENT_OPENED);
  } catch {
    return [];
  }
}

function saveRecentOpened() {
  try {
    localStorage.setItem(DOC_RECENT_KEY, JSON.stringify(recentOpenedPaths));
  } catch {
    // ignore
  }
}

function recordRecentOpened(path) {
  recentOpenedPaths = [path, ...recentOpenedPaths.filter((item) => item !== path)].slice(0, MAX_RECENT_OPENED);
  saveRecentOpened();
}

export function getRecentOpenedPaths() {
  return [...recentOpenedPaths];
}

function loadAttachDocContext() {
  try {
    return localStorage.getItem("docAttachContext") !== "false";
  } catch {
    return true;
  }
}

function getActiveTabEditMode() {
  return openTabs.find((tab) => tab.path === activeTabPath)?.editMode ?? false;
}

function getDocSelectionStatusText() {
  if (!selectedPreviewText || !selectedPreviewStartLine || !selectedPreviewEndLine) return "";
  return `已选中源文件第 ${selectedPreviewStartLine} 行到第 ${selectedPreviewEndLine} 行`;
}

/* ------------------------------------------------------------------ *
 *  Generic expandable directory tree (left column)
 *
 *  Each directory row toggles its children; child directories are
 *  indented by nesting depth. Children for a directory are fetched
 *  lazily from /api/documents/tree and cached. The same logic is used
 *  for knowledge_base / inputs / trilium roots.
 * ------------------------------------------------------------------ */

async function fetchDocTree(path) {
  const res = await fetch(`/api/documents/tree?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "读取目录失败");
  return Array.isArray(data.entries) ? data.entries : [];
}

async function fetchDocContent(path) {
  const res = await fetch(`/api/documents/content?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error || "读取文件失败");
    // 404 表示文件不存在/已被删除，调用方可据此静默处理而非弹错误提示
    error.notFound = res.status === 404;
    throw error;
  }
  return data;
}

/** Entry depth for indentation. Direct children of a root sit at level 0. */
async function ensureChildren(path) {
  if (childrenCache.has(path)) return childrenCache.get(path);
  const entries = await fetchDocTree(path);
  childrenCache.set(path, entries);
  return entries;
}

async function expandDir(path) {
  try {
    await ensureChildren(path);
  } catch (error) {
    reportError((error && error.message) ? error.message : "读取目录失败");
    return false;
  }
  expandedDirs.add(path);
  saveExpandedDirs();
  renderFileTree();
  return true;
}

function collapseDir(path) {
  expandedDirs.delete(path);
  saveExpandedDirs();
  renderFileTree();
}

async function toggleDir(path) {
  if (expandedDirs.has(path)) collapseDir(path);
  else await expandDir(path);
}

/** Collect the currently visible rows (depth-first) under the active root. */
function collectVisibleRows() {
  const rows = [];
  const walk = (entries, depth) => {
    for (const entry of entries) {
      rows.push({ entry, depth });
      if (entry.kind === "directory" && expandedDirs.has(entry.path)) {
        const children = childrenCache.get(entry.path);
        if (children) walk(children, depth + 1);
      }
    }
  };
  const entries = childrenCache.get(docRootPath);
  if (entries) walk(entries, 0);
  return rows;
}

async function openFileFromTree(path) {
  const ok = await openDocPreview(path);
  if (ok) renderFileTree();
  return ok;
}

function renderFileTree() {
  const tree = document.getElementById("file-tree");
  if (!tree) return;
  const rows = collectVisibleRows();
  if (!rows.length) {
    tree.innerHTML = '<div class="file-tree-empty">此目录为空</div>';
    return;
  }
  tree.innerHTML = rows.map(({ entry, depth }) => {
    const isDir = entry.kind === "directory";
    const expanded = isDir && expandedDirs.has(entry.path);
    const active = !isDir && entry.path === activeTabPath;
    const chevron = isDir
      ? `<span class="tree-chevron ${expanded ? "open" : ""}"><i data-lucide="chevron-right"></i></span>`
      : '<span class="tree-chevron tree-chevron-placeholder"></span>';
    const icon = isDir ? "folder" : (expanded ? "" : "file");
    return `
      <div class="file-tree-row ${active ? "active" : ""}" data-path="${escHtml(entry.path)}" data-kind="${entry.kind}"
           style="padding-left:${10 + depth * 15}px" role="treeitem" ${isDir ? `aria-expanded="${String(expanded)}"` : ""}>
        ${chevron}
        <span class="tree-icon"><i data-lucide="${isDir ? (expanded ? "folder-open" : "folder") : icon}"></i></span>
        <span class="tree-label" title="${escHtml(entry.path)}">${escHtml(entry.name)}</span>
      </div>`;
  }).join("");
  window.lucide?.createIcons();

  tree.querySelectorAll(".file-tree-row").forEach((row) => {
    row.addEventListener("click", () => {
      const path = row.dataset.path;
      const kind = row.dataset.kind;
      if (kind === "directory") void toggleDir(path);
      else void openFileFromTree(path);
    });
  });
}

function renderRootTabs() {
  const container = document.getElementById("file-root-tabs");
  if (!container) return;
  const roots = getDocBrowserRoots();
  container.innerHTML = `
    ${roots.map((root) => `
      <button class="file-root-tab ${root === docRootPath ? "active" : ""}" data-root="${escHtml(root)}" type="button"
              role="tab" aria-selected="${root === docRootPath ? "true" : "false"}" title="${root}">
        <i data-lucide="${root === docRootPath ? "folder-open" : "folder"}" class="file-root-tab-icon"></i>
        <span class="file-root-tab-label">${escHtml(root === TRILIUM_ROOT ? "trilium（只读）" : root)}</span>
      </button>`).join("")}
    <button id="file-refresh-btn" class="icon-button file-refresh-btn" type="button" title="刷新目录" aria-label="刷新目录">
      <i data-lucide="refresh-cw"></i>
    </button>`;
  window.lucide?.createIcons();

  container.querySelectorAll(".file-root-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const root = button.dataset.root;
      if (!root || root === docRootPath) return;
      setDocRoot(root);
    });
  });
  container.querySelector("#file-refresh-btn")?.addEventListener("click", () => void refreshDocBrowser());
}

async function setDocRoot(root) {
  docRootPath = root;
  saveDocRootPath();
  try {
    await ensureChildren(root);
  } catch (error) {
    reportError((error && error.message) ? error.message : "读取目录失败");
  }
  renderRootTabs();
  renderFileTree();
}

/** Bind the left explorer once (elements are static in index.html). */
export async function initExplorer() {
  const explorer = document.getElementById("file-explorer");
  if (!explorer || explorer.dataset.initialized) return;
  explorer.dataset.initialized = "true";

  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    triliumEnabled = data?.triliumEnabled === true;
  } catch {
    triliumEnabled = false;
  }
  if (!getDocBrowserRoots().includes(docRootPath)) {
    docRootPath = LOCAL_DOC_BROWSER_ROOTS[0];
    saveDocRootPath();
  }
  renderRootTabs();
  try {
    await ensureChildren(docRootPath);
  } catch {
    childrenCache.set(docRootPath, []);
  }
  renderFileTree();
  initDocExplorerResizeHandle();
}

/* ------------------------------------------------------------------ *
 *  Middle document reader (tabs + preview + edit)
 * ------------------------------------------------------------------ */

export function saveDocPreviewScrollPosition() {
  saveActiveTabScrollPosition();
}

// 把当前预览区的滚动位置记录到活动标签上（切换标签/重建 DOM 前调用）
function saveActiveTabScrollPosition() {
  const tab = openTabs.find((item) => item.path === activeTabPath);
  const el = document.getElementById("doc-preview-content");
  if (tab && el) tab.scrollTop = el.scrollTop;
}

// 渲染后按标签自身记录的滚动位置恢复；期间若已切走则跳过，避免污染新标签
function restorePreviewScroll(container) {
  const path = activeTabPath;
  requestAnimationFrame(() => {
    if (activeTabPath !== path || !container.isConnected) return;
    const tab = openTabs.find((item) => item.path === path);
    const target = tab?.scrollTop ?? 0;
    const maxScroll = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.min(target, Math.max(0, maxScroll));
  });
}

export function clearPreviewSelection() {
  selectedPreviewText = "";
  selectedPreviewSummary = "";
  selectedPreviewStartLine = 0;
  selectedPreviewEndLine = 0;
  updateDocSelectionStatus();
}

function isEditableText() {
  return Boolean(
    activeTabPath
    && openTabs.find((tab) => tab.path === activeTabPath)
    && docPreviewKind === "text"
    && !isTriliumDocPath(activeTabPath),
  );
}

async function saveCurrentTabEdit() {
  if (!getActiveTabEditMode() || !isEditableText()) return true;
  const container = document.getElementById("doc-preview-content");
  const textarea = container?.querySelector(".doc-edit-textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) return true;
  try {
    const res = await fetch("/api/documents/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: activeTabPath, content: textarea.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存失败");
    docPreviewContent = textarea.value;
    return true;
  } catch (error) {
    reportError((error && error.message) ? error.message : "保存文件失败");
    return false;
  }
}

export async function saveActiveDoc({ stayInEdit = false } = {}) {
  const ok = await saveCurrentTabEdit();
  if (!ok) return false;
  if (!stayInEdit) {
    const tab = openTabs.find((item) => item.path === activeTabPath);
    if (tab) tab.editMode = false;
    saveOpenTabs();
    clearPreviewSelection();
    updateDocPreviewPanel();
  }
  renderDocTabs();
  updateDocSelectionStatus();
  return true;
}

async function toggleDocEdit() {
  if (!isEditableText()) return;
  const tab = openTabs.find((item) => item.path === activeTabPath);
  const container = document.getElementById("doc-preview-content");
  let scrollRatio = 0;
  if (tab.editMode) {
    if (container) {
      const textarea = container.querySelector(".doc-edit-textarea");
      if (textarea instanceof HTMLTextAreaElement) {
        const maxScroll = textarea.scrollHeight - textarea.clientHeight;
        scrollRatio = maxScroll > 0 ? textarea.scrollTop / maxScroll : 0;
      }
    }
    const ok = await saveCurrentTabEdit();
    if (!ok) return;
    tab.editMode = false;
    saveOpenTabs();
    updateDocPreviewPanel();
    if (container) {
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTop = Math.min(scrollRatio * maxScroll, maxScroll);
      tab.scrollTop = container.scrollTop;
    }
  } else {
    if (container) {
      const maxScroll = container.scrollHeight - container.clientHeight;
      scrollRatio = maxScroll > 0 ? container.scrollTop / maxScroll : 0;
    }
    tab.editMode = true;
    saveOpenTabs();
    clearPreviewSelection();
    updateDocPreviewPanel();
    const textarea = container?.querySelector(".doc-edit-textarea");
    if (textarea instanceof HTMLTextAreaElement) {
      const maxScroll = textarea.scrollHeight - textarea.clientHeight;
      textarea.scrollTop = Math.min(scrollRatio * maxScroll, maxScroll);
      tab.scrollTop = textarea.scrollTop;
      textarea.focus();
    }
  }
  renderDocTabs();
  updateDocSelectionStatus();
}

function updateDocSelectionStatus() {
  const linesEl = document.querySelector("#doc-selection-status .doc-selection-lines");
  const summaryEl = document.querySelector("#doc-selection-status .doc-selection-summary");
  if (linesEl && !linesEl.dataset.flashing) linesEl.textContent = getDocSelectionStatusText();
  if (summaryEl) summaryEl.textContent = selectedPreviewSummary ? `"${selectedPreviewSummary}"` : "";
  const editMode = getActiveTabEditMode();
  const editIcon = editMode ? "log-out" : "pencil";
  const editDisabled = !isEditableText();
  const editBtn = document.getElementById("doc-edit-btn");
  if (editBtn) {
    if (editBtn.dataset.icon !== editIcon) {
      editBtn.dataset.icon = editIcon;
      editBtn.innerHTML = `<i data-lucide="${editIcon}"></i>`;
      window.lucide?.createIcons();
    }
    editBtn.disabled = editDisabled;
    editBtn.title = editMode ? "保存并退出编辑" : "编辑此文档";
    editBtn.setAttribute("aria-label", editBtn.title);
  }
  const saveBtn = document.getElementById("doc-save-btn");
  if (saveBtn) {
    saveBtn.hidden = !(editMode && isEditableText());
    saveBtn.disabled = !(editMode && isEditableText());
    saveBtn.title = "保存修改（Ctrl/Cmd+S）";
  }
}

function flashDocStatus(message) {
  const linesEl = document.querySelector("#doc-selection-status .doc-selection-lines");
  if (!linesEl) return;
  linesEl.dataset.flashing = "true";
  linesEl.textContent = message;
  window.clearTimeout(linesEl._flashTimer);
  linesEl._flashTimer = window.setTimeout(() => {
    delete linesEl.dataset.flashing;
    updateDocSelectionStatus();
  }, 1800);
}

export function getSelectedPreviewPayload() {
  if (!selectedPreviewText) return undefined;
  const header = getDocSelectionStatusText();
  return `${header}：\n${selectedPreviewText}`;
}

export function getPreviewContextPayload() {
  // 关闭附带时返回空对象，chat.js 展开后不会携带任何文件上下文字段
  if (!attachDocContext) return {};
  return {
    previewPath: activeTabPath || undefined,
    selectedPreviewText: getSelectedPreviewPayload(),
  };
}

export function getAttachDocContext() {
  return attachDocContext;
}

export function toggleAttachDocContext() {
  attachDocContext = !attachDocContext;
  try {
    localStorage.setItem("docAttachContext", String(attachDocContext));
  } catch {
    // ignore
  }
  return attachDocContext;
}

export function getOpenTabPaths() {
  return openTabs.map((tab) => tab.path);
}

export function updateSelectedPreviewTextFromSelection() {
  if (getActiveTabEditMode() || docPreviewKind !== "text") return;
  const preview = document.getElementById("doc-preview-content");
  const selection = window.getSelection();
  if (!preview || !selection || selection.rangeCount === 0) {
    return;
  }
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!common || !preview.contains(common)) {
    return;
  }
  const nextText = selection.toString().trim();
  if (!nextText) return;
  selectedPreviewText = nextText;
  selectedPreviewSummary = getDocSelectionSummary(nextText);
  selectedPreviewStartLine = getSourceLineNumberFromOffset(preview, range.startContainer, range.startOffset, "start");
  selectedPreviewEndLine = getSourceLineNumberFromOffset(preview, range.endContainer, range.endOffset, "end");
  updateDocSelectionStatus();
}

function updateDocPreviewPanel() {
  const content = document.getElementById("doc-preview-content");
  if (!content) return;
  content.classList.toggle("unsupported", !docPreviewSupported);
  content.classList.toggle("image-preview", docPreviewKind === "image");
  if (!activeTabPath) {
    content.classList.remove("markdown-body");
    content.classList.remove("image-preview");
    content.innerHTML = "";
    content.appendChild(buildDocEmptyState());
    return;
  }
  if (!docPreviewSupported) {
    content.classList.remove("markdown-body");
    content.textContent = docPreviewContent || "暂不支持预览";
    return;
  }
  if (docPreviewKind === "image") {
    content.classList.remove("markdown-body");
    content.innerHTML = "";
    const img = document.createElement("img");
    img.className = "doc-preview-image";
    img.src = docPreviewContent || "";
    img.alt = activeTabPath;
    content.appendChild(img);
    return;
  }
  if (getActiveTabEditMode()) {
    content.classList.remove("markdown-body");
    content.innerHTML = `<textarea class="doc-edit-textarea" spellcheck="false">${escHtml(docPreviewContent || "")}</textarea>`;
    const textarea = content.querySelector(".doc-edit-textarea");
    if (textarea) restorePreviewScroll(textarea);
    return;
  }
  content.classList.add("markdown-body");
  const basePath = activeTabPath ? activeTabPath.replace(/[^/\\]*$/, "") : "";
  renderContent(content, docPreviewContent, basePath);
  restorePreviewScroll(content);
}

function buildDocEmptyState() {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state doc-empty-state";
  wrapper.innerHTML = `
    <div class="empty-state-icon"><i data-lucide="file-text"></i></div>
    <p class="empty-state-title">文档阅读</p>
    <p class="empty-state-copy">在左侧文件栏选择一个文件，这里会展示其内容</p>`;
  return wrapper;
}

async function loadActiveTabContent() {
  if (!activeTabPath) {
    docPreviewContent = "";
    docPreviewSupported = true;
    docPreviewKind = "text";
    clearPreviewSelection();
    updateDocPreviewPanel();
    updateDocSelectionStatus();
    return false;
  }
  try {
    const data = await fetchDocContent(activeTabPath);
    docPreviewContent = data.content || "";
    docPreviewSupported = data.supported !== false;
    docPreviewKind = data.kind || (docPreviewSupported ? "text" : "unsupported");
    const tab = openTabs.find((item) => item.path === activeTabPath);
    if (tab && data.title) tab.label = data.title;
    saveOpenTabs();
    clearPreviewSelection();
    recordRecentOpened(activeTabPath);
    updateDocPreviewPanel();
    updateDocSelectionStatus();
    return true;
  } catch (error) {
    if (error && error.notFound) {
      // 文件已被删除（如模型执行 delete 工具后刷新）：静默失效，
      // 由调用方（refreshDocBrowser 等）关闭对应标签，不弹出错误提示。
      docPreviewContent = "";
      docPreviewSupported = false;
      docPreviewKind = "unsupported";
      clearPreviewSelection();
      updateDocPreviewPanel();
      updateDocSelectionStatus();
      return false;
    }
    reportError((error && error.message) ? error.message : "读取文件失败");
    return false;
  }
}

async function openDocPreview(path) {
  if (openTabs.some((tab) => tab.path === path)) {
    // 已打开：直接激活（保留其固定/临时状态）
    await activateTab(path);
    return true;
  }
  // 存在临时标签（斜体、未固定）时替换它，否则新建临时标签
  const tempIndex = openTabs.findIndex((tab) => !tab.sticky);
  const replacedPath = tempIndex !== -1 ? openTabs[tempIndex].path : null;
  if (tempIndex !== -1) {
    if (openTabs[tempIndex].path === activeTabPath) {
      const ok = await saveCurrentTabEdit();
      if (!ok) return false;
    }
    openTabs[tempIndex] = { path, editMode: false, sticky: false };
  } else {
    openTabs.push({ path, editMode: false, sticky: false });
  }
  activeTabPath = path;
  saveOpenTabs();
  renderDocTabs();
  const ok = await loadActiveTabContent();
  if (!ok) {
    if (tempIndex !== -1 && replacedPath) {
      // 打开失败：恢复被替换的临时标签
      openTabs[tempIndex] = { path: replacedPath, editMode: false, sticky: false };
      activeTabPath = replacedPath;
      saveOpenTabs();
      renderDocTabs();
      await loadActiveTabContent();
      return false;
    }
    // 打开失败：回滚刚创建的标签
    await closeTab(path, { saveEdit: false });
    return false;
  }
  return true;
}

async function activateTab(path) {
  if (path === activeTabPath) return;
  const ok = await saveCurrentTabEdit();
  if (!ok) return;
  // 切走前记录当前标签的滚动位置，切回时恢复
  saveActiveTabScrollPosition();
  activeTabPath = path;
  saveOpenTabs();
  renderDocTabs();
  await loadActiveTabContent();
}

async function closeTab(path, { saveEdit = true } = {}) {
  const index = openTabs.findIndex((tab) => tab.path === path);
  if (index === -1) return;
  if (path === activeTabPath && saveEdit) {
    const ok = await saveCurrentTabEdit();
    if (!ok) return;
  }
  openTabs.splice(index, 1);
  if (path === activeTabPath) {
    if (openTabs.length) {
      const next = openTabs[Math.min(index, openTabs.length - 1)];
      activeTabPath = next.path;
      saveOpenTabs();
      await loadActiveTabContent();
    } else {
      activeTabPath = null;
      docPreviewContent = "";
      docPreviewSupported = true;
      docPreviewKind = "text";
      clearPreviewSelection();
      saveOpenTabs();
      updateDocPreviewPanel();
      updateDocSelectionStatus();
    }
  } else {
    saveOpenTabs();
  }
  renderDocTabs();
  renderFileTree();
}

function renderDocTabs() {
  const container = document.getElementById("doc-tabs");
  if (!container) return;
  if (!openTabs.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = openTabs.map((tab) => `
    <button class="doc-tab ${tab.path === activeTabPath ? "active" : ""} ${tab.editMode ? "editing" : ""} ${tab.sticky ? "" : "temporary"}" data-tab-path="${escHtml(tab.path)}" type="button" title="${escHtml(tab.path)}${tab.sticky ? "" : "（临时标签，双击固定）"}" aria-label="标签 ${escHtml(tab.path)}">
      <i data-lucide="${tab.editMode ? "pencil" : "file-text"}" class="doc-tab-icon"></i>
      <span class="doc-tab-label">${escHtml(tab.label || tab.path.split("/").pop() || tab.path)}</span>
      <span class="doc-tab-close" data-close-tab-path="${escHtml(tab.path)}" role="button" tabindex="-1" title="关闭标签" aria-label="关闭标签 ${escHtml(tab.path)}"><i data-lucide="x" class="doc-tab-close-icon"></i></span>
    </button>
  `).join("");
  window.lucide?.createIcons();

  container.querySelectorAll(".doc-tab").forEach((button) => {
    button.addEventListener("click", () => {
      void activateTab(button.dataset.tabPath);
    });
    // 双击临时标签 → 固定为常驻标签
    button.addEventListener("dblclick", () => {
      const tab = openTabs.find((item) => item.path === button.dataset.tabPath);
      if (tab && !tab.sticky) {
        tab.sticky = true;
        saveOpenTabs();
        renderDocTabs();
      }
    });
  });
  container.querySelectorAll(".doc-tab-close").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTab(button.dataset.closeTabPath);
    });
  });

  // Scroll the active tab into view (horizontal).
  const active = container.querySelector(".doc-tab.active");
  if (active) {
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < containerRect.left) {
      container.scrollLeft -= containerRect.left - activeRect.left;
    } else if (activeRect.right > containerRect.right) {
      container.scrollLeft += activeRect.right - containerRect.right;
    }
  }
}

/**
 * 刷新文档浏览（模型写/删文件后、或用户点击刷新按钮时调用）：
 * 重新拉取当前根目录与已展开目录的条目，并重新加载活动标签内容。
 */
export async function refreshDocBrowser() {
  try {
    clearPreviewSelection();
    saveActiveTabScrollPosition();
    if (docRootPath) {
      try {
        childrenCache.set(docRootPath, await fetchDocTree(docRootPath));
      } catch {
        childrenCache.set(docRootPath, []);
      }
      // 只刷新当前根目录下已展开的目录
      const prefix = `${docRootPath}/`;
      const stale = [];
      const expandedUnderRoot = [...expandedDirs].filter((dir) => dir.startsWith(prefix));
      await Promise.all(expandedUnderRoot.map(async (dir) => {
        try {
          childrenCache.set(dir, await fetchDocTree(dir));
        } catch {
          stale.push(dir);
        }
      }));
      for (const dir of stale) {
        expandedDirs.delete(dir);
        childrenCache.delete(dir);
      }
      saveExpandedDirs();
      renderFileTree();
    }

    if (activeTabPath) {
      const ok = await loadActiveTabContent();
      if (!ok) {
        // 文件已失效：关闭对应标签
        await closeTab(activeTabPath, { saveEdit: false });
      }
    } else {
      updateDocPreviewPanel();
      updateDocSelectionStatus();
    }
    renderDocTabs();
    renderFileTree();
  } catch (error) {
    reportError((error && error.message) ? error.message : "刷新文档结构失败");
  }
}

/**
 * Bind the middle document reader. Called after every #main rebuild.
 */
export async function initDocView() {
  const content = document.getElementById("doc-preview-content");
  if (!content) return;

  document.getElementById("doc-refresh-btn")?.addEventListener("click", () => void refreshDocBrowser());
  document.getElementById("doc-edit-btn")?.addEventListener("click", () => void toggleDocEdit());
  document.getElementById("doc-save-btn")?.addEventListener("click", async () => {
    if (await saveActiveDoc({ stayInEdit: true })) flashDocStatus("已保存");
  });
  content.addEventListener("click", () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().trim()) return;
    if (!selectedPreviewText) return;
    clearPreviewSelection();
  });

  // Ctrl/Cmd+S 在编辑态保存并停留在编辑态
  content.addEventListener("keydown", async (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return;
    if (!getActiveTabEditMode() || !isEditableText()) return;
    event.preventDefault();
    if (await saveActiveDoc({ stayInEdit: true })) flashDocStatus("已保存");
  });

  renderDocTabs();
  if (activeTabPath) {
    // 页面刷新/面板重建后恢复活动标签的内容
    await loadActiveTabContent();
  } else {
    updateDocPreviewPanel();
    updateDocSelectionStatus();
  }
  updateDocSelectionStatus();
  renderFileTree();
}
