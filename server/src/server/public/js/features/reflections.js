import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

const ROOT = "inputs/reflections";

export function createReflectionsFeature({ state, actions }) {
  let tree = [];
  let currentPath = "";
  let draft = null;
  let dirty = false;
  let selectedFolder = "";
  const expanded = new Set();

  function syncPreview() {
    if (state.workspace !== "reflections" || !currentPath) {
      state.reflectionPreview = null;
      return;
    }
    state.reflectionPreview = { previewPath: currentPath };
  }

  function folderKey(path) {
    if (!path || path === ROOT) return "";
    return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
  }

  function findNode(nodes, path) {
    for (const node of nodes || []) {
      if (node.path === path) return node;
      const nested = findNode(node.children || [], path);
      if (nested) return nested;
    }
    return null;
  }

  async function loadTree() {
    const { data } = await requestJson("/api/reflections?view=tree");
    tree = (data.tree || []).filter((node) => node.kind === "directory");
    renderFolders();
    renderStage();
    syncPreview();
  }

  function renderFolderNodes(nodes, depth) {
    return (nodes || []).filter((node) => node.kind === "directory").map((node) => {
      const children = (node.children || []).filter((child) => child.kind === "directory");
      const open = expanded.has(node.path);
      const active = selectedFolder === node.path ? "active" : "";
      return `
        <div class="reflections-folder-row" style="padding-left:${8 + depth * 14}px">
          <button type="button" class="reflections-folder ${active}" data-folder="${escHtml(node.path)}">${escHtml(node.name || "/")}</button>
          ${children.length ? `<button type="button" class="reflections-expand" data-expand="${escHtml(node.path)}">${open ? "▾" : "▸"}</button>` : ""}
        </div>
        ${open ? renderFolderNodes(children, depth + 1) : ""}`;
    }).join("");
  }

  function renderFolders() {
    const list = document.getElementById("reflections-list");
    const toolbar = document.getElementById("reflections-toolbar");
    if (toolbar) {
      toolbar.innerHTML = `
        <button type="button" id="reflections-mkdir">新建文件夹</button>
        <button type="button" id="reflections-import">粘贴导入</button>
        <button type="button" id="reflections-import-file">拆分文件</button>`;
      toolbar.querySelector("#reflections-mkdir")?.addEventListener("click", () => void makeDir());
      toolbar.querySelector("#reflections-import")?.addEventListener("click", () => void importPaste());
      toolbar.querySelector("#reflections-import-file")?.addEventListener("click", () => void importFile());
    }
    if (!list) return;
    list.innerHTML = renderFolderNodes(tree, 0) || `<p class="empty-state-copy">还没有文件夹</p>`;
    list.querySelectorAll("[data-folder]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedFolder = button.dataset.folder || "";
        renderFolders();
        renderStage();
      });
    });
    list.querySelectorAll("[data-expand]").forEach((button) => {
      button.addEventListener("click", () => {
        const path = button.dataset.expand || "";
        if (expanded.has(path)) expanded.delete(path);
        else expanded.add(path);
        renderFolders();
      });
    });
  }

  function renderStage() {
    const panel = document.getElementById("document-panel");
    if (!panel || state.workspace !== "reflections") return;
    let stage = document.getElementById("reflections-stage");
    if (!stage) {
      stage = document.createElement("div");
      stage.id = "reflections-stage";
      panel.appendChild(stage);
    }
    const folder = findNode(tree, selectedFolder);
    if (!folder) {
      stage.innerHTML = `<p class="empty-state-copy">选择一个文件夹</p>`;
      return;
    }
    const subfolders = (folder.children || []).filter((node) => node.kind === "directory");
    const notes = (folder.children || []).filter((node) => node.kind === "file");
    const groups = groupNotes(notes);
    stage.innerHTML = `
      <div class="reflections-notes">
        ${subfolders.length ? `<div class="reflections-subfolders">${subfolders.map((node) =>
          `<button type="button" class="reflections-folder" data-open-folder="${escHtml(node.path)}">${escHtml(node.name)}</button>`
        ).join("")}</div>` : ""}
        ${groups.map((group) => `
          <h3 class="reflections-group">${escHtml(group.label)}</h3>
          ${group.notes.map((note) => `
            <button type="button" class="reflections-row ${note.path === currentPath ? "active" : ""}" data-path="${escHtml(note.path)}">
              <strong>${escHtml(note.title || note.name || "未命名")}</strong>
            </button>`).join("")}
        `).join("")}
        <div class="reflections-composer">
          <textarea id="reflection-quick" rows="2" placeholder="写下来"></textarea>
          <button type="button" id="reflection-publish">创建</button>
        </div>
        <div class="reflections-editor">
          <input id="reflection-title" type="text" placeholder="标题" value="${escHtml(draft?.title || "")}">
          <textarea id="reflection-body" placeholder="正文">${escHtml(draft?.body || "")}</textarea>
          <div class="reflections-actions">
            <button type="button" id="reflection-save">保存</button>
            <button type="button" id="reflection-new">创建</button>
            <button type="button" id="reflection-move">移动到…</button>
            <button type="button" id="reflection-organize">按日期归夹</button>
            <button type="button" id="reflection-delete">删除</button>
          </div>
        </div>
      </div>`;
    stage.querySelectorAll("[data-open-folder]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedFolder = button.dataset.openFolder || "";
        expanded.add(folder.path);
        renderFolders();
        renderStage();
      });
    });
    stage.querySelectorAll("[data-path]").forEach((button) => {
      button.addEventListener("click", () => void openPath(button.dataset.path || ""));
    });
    const markDirty = () => { dirty = true; };
    stage.querySelector("#reflection-title")?.addEventListener("input", markDirty);
    stage.querySelector("#reflection-body")?.addEventListener("input", markDirty);
    stage.querySelector("#reflection-title")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        stage.querySelector("#reflection-body")?.focus();
      }
    });
    stage.querySelector("#reflection-save")?.addEventListener("click", () => void saveCurrent());
    stage.querySelector("#reflection-new")?.addEventListener("click", () => beginNew());
    stage.querySelector("#reflection-move")?.addEventListener("click", () => void moveCurrent());
    stage.querySelector("#reflection-organize")?.addEventListener("click", () => void organizeCurrent());
    stage.querySelector("#reflection-delete")?.addEventListener("click", () => void deleteCurrent());
    stage.querySelector("#reflection-publish")?.addEventListener("click", () => void publishQuick());
  }

  function readForm() {
    return {
      title: document.getElementById("reflection-title")?.value ?? "",
      body: document.getElementById("reflection-body")?.value ?? "",
    };
  }

  async function openPath(filePath) {
    if (dirty && !window.confirm("当前心得未保存，切换将丢弃修改。继续？")) return;
    const { response, data } = await requestJson(`/api/reflections/content?path=${encodeURIComponent(filePath)}`);
    if (!response.ok) {
      actions.showError?.(data.error || "打开失败");
      return;
    }
    currentPath = data.reflection.path;
    draft = { ...data.reflection };
    dirty = false;
    renderStage();
    syncPreview();
  }

  function beginNew() {
    if (dirty && !window.confirm("当前心得未保存，新建将丢弃修改。继续？")) return;
    currentPath = "";
    draft = { title: "", body: "", folder: folderKey(selectedFolder) || "inbox" };
    dirty = false;
    renderStage();
    syncPreview();
    document.getElementById("reflection-title")?.focus();
  }

  async function saveCurrent() {
    const form = readForm();
    if (!form.title.trim()) {
      actions.showError?.("标题不能为空");
      return;
    }
    const creating = !draft?.path;
    const { response, data } = await requestJson(
      creating ? "/api/reflections" : "/api/reflections/content",
      jsonRequest(creating ? "POST" : "PUT", {
        ...form,
        ...(creating
          ? { folder: folderKey(selectedFolder) || "inbox" }
          : { path: draft.path }),
      }),
    );
    if (!response.ok) {
      actions.showError?.(data.error || "保存失败");
      return;
    }
    draft = data.reflection;
    currentPath = draft.path;
    dirty = false;
    await loadTree();
  }

  async function publishQuick() {
    const text = document.getElementById("reflection-quick")?.value || "";
    if (!text.trim()) return;
    const title = window.prompt("标题");
    if (!title || !title.trim()) return;
    const { response, data } = await requestJson("/api/reflections", jsonRequest("POST", {
      title: title.trim(),
      body: text,
      folder: folderKey(selectedFolder) || "inbox",
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "创建失败");
      return;
    }
    await loadTree();
  }

  async function deleteCurrent() {
    if (!draft?.path || !window.confirm("删除这篇心得？")) return;
    const { response, data } = await requestJson(`/api/reflections?path=${encodeURIComponent(draft.path)}`, jsonRequest("DELETE"));
    if (!response.ok) {
      actions.showError?.(data.error || "删除失败");
      return;
    }
    dirty = false;
    currentPath = "";
    draft = null;
    await loadTree();
  }

  async function moveCurrent() {
    if (!draft?.path) return;
    const folder = window.prompt("移动到文件夹（相对 reflections，如 散步随想/大沙河）", draft.folder || "inbox");
    if (folder == null) return;
    const { response, data } = await requestJson("/api/reflections/move", jsonRequest("POST", {
      from: draft.path,
      toFolder: folder.trim() || "inbox",
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "移动失败");
      return;
    }
    dirty = false;
    currentPath = data.reflection?.path || "";
    draft = data.reflection || null;
    await loadTree();
  }

  async function organizeCurrent() {
    if (!draft?.path) return;
    const { response, data } = await requestJson("/api/reflections/organize-by-date", jsonRequest("POST", { path: draft.path }));
    if (!response.ok) {
      actions.showError?.(data.error || "归夹失败");
      return;
    }
    dirty = false;
    currentPath = data.reflection?.path || "";
    draft = data.reflection || null;
    selectedFolder = data.reflection?.path ? data.reflection.path.slice(0, data.reflection.path.lastIndexOf("/")) : selectedFolder;
    await loadTree();
  }

  async function importPaste() {
    const text = window.prompt("粘贴记事本内容（标题\\n时间情境行\\n正文；多篇在下一篇标题前空一行）");
    if (text == null || !text.trim()) return;
    await commitImport({ text, folder: folderKey(selectedFolder) || "inbox" });
  }

  async function importFile() {
    const sourcePath = window.prompt("要拆分的文件路径（相对数据目录，如 inputs/reflections/inbox/合集.txt）");
    if (!sourcePath || !sourcePath.trim()) return;
    const dry = await requestJson("/api/reflections/import", jsonRequest("POST", {
      sourcePath: sourcePath.trim(),
      dryRun: true,
    }));
    if (!dry.response.ok) {
      actions.showError?.(dry.data.error || "预览失败");
      return;
    }
    const previewItems = dry.data.items || [];
    if (!previewItems.length) {
      actions.showError?.("未能解析出心得");
      return;
    }
    const preview = previewItems.map((item, index) =>
      `${index + 1}. ${item.title}${item.occurredAt ? ` @ ${item.occurredAt}` : ""}`
    ).join("\n");
    if (!window.confirm(`将从该文件拆出 ${previewItems.length} 篇：\n${preview}\n\n确认后写入。`)) return;
    const deleteSource = window.confirm("写入成功后删除源文件？");
    await commitImport({
      sourcePath: sourcePath.trim(),
      folder: folderKey(selectedFolder) || "inbox",
      deleteSource,
    });
  }

  async function commitImport(payload) {
    const { response, data } = await requestJson("/api/reflections/import", jsonRequest("POST", payload));
    if (!response.ok) {
      actions.showError?.(data.error || "导入失败");
      return;
    }
    dirty = false;
    await loadTree();
  }

  async function makeDir() {
    const parent = folderKey(selectedFolder);
    const name = window.prompt("新建文件夹");
    if (!name || !name.trim()) return;
    const folder = parent ? `${parent}/${name.trim()}` : name.trim();
    const { response, data } = await requestJson("/api/reflections/mkdir", jsonRequest("POST", { folder }));
    if (!response.ok) {
      actions.showError?.(data.error || "创建失败");
      return;
    }
    if (data.path) selectedFolder = data.path;
    await loadTree();
  }

  function applyWorkspaceChrome(next) {
    document.body.classList.toggle("people-workspace", next === "people");
    document.body.classList.toggle("reflections-workspace", next === "reflections");
    document.getElementById("workspace-docs")?.classList.toggle("active", next === "docs");
    document.getElementById("workspace-people")?.classList.toggle("active", next === "people");
    document.getElementById("workspace-reflections")?.classList.toggle("active", next === "reflections");
    const peopleBrowser = document.getElementById("people-browser");
    if (peopleBrowser) peopleBrowser.hidden = next !== "people";
    const reflectionsBrowser = document.getElementById("reflections-browser");
    if (reflectionsBrowser) reflectionsBrowser.hidden = next !== "reflections";
    if (next !== "people") document.getElementById("people-stage")?.remove();
    if (next !== "reflections") document.getElementById("reflections-stage")?.remove();
  }

  function setWorkspace(next) {
    if (next !== "reflections" && dirty && !window.confirm("当前心得未保存，切换工作区将丢弃修改。继续？")) return;
    state.workspace = next;
    applyWorkspaceChrome(next);
    if (next === "reflections") {
      state.personThread = null;
      void loadTree();
    } else {
      syncPreview();
    }
    remount();
    actions.peopleRemount?.();
  }

  function remount() {
    if (state.workspace !== "reflections") {
      syncPreview();
      return;
    }
    renderFolders();
    renderStage();
    syncPreview();
  }

  function canLeave() {
    if (!dirty) return true;
    return window.confirm("当前心得未保存，切换将丢弃修改。继续？");
  }

  function bind() {
    document.getElementById("workspace-reflections")?.addEventListener("click", () => setWorkspace("reflections"));
  }

  return { bind, remount, setWorkspace, applyWorkspaceChrome, canLeave };
}

function groupNotes(notes) {
  const now = new Date();
  const buckets = new Map();
  for (const note of notes) {
    const label = groupLabel(note.updatedAt || note.occurredAt, now);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(note);
  }
  return [...buckets.entries()]
    .sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
    .map(([label, items]) => ({
      label,
      notes: items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    }));
}

function groupLabel(iso, now) {
  const instant = new Date(iso || "");
  if (Number.isNaN(instant.getTime())) return "更早";
  const day = shanghaiDate(instant);
  const today = shanghaiDate(now);
  const delta = Math.round((today - day) / 86400000);
  if (delta <= 0) return "今天";
  if (delta === 1) return "昨天";
  if (delta <= 7) return "前 7 天";
  if (delta <= 30) return "前 30 天";
  return String(shanghaiParts(instant).year);
}

function groupRank(label) {
  if (label === "今天") return 0;
  if (label === "昨天") return 1;
  if (label === "前 7 天") return 2;
  if (label === "前 30 天") return 3;
  const year = Number(label);
  return Number.isFinite(year) ? 10000 - year : 100000;
}

function shanghaiParts(instant) {
  const shifted = new Date(instant.getTime() + 8 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

function shanghaiDate(instant) {
  const parts = shanghaiParts(instant);
  return Date.UTC(parts.year, parts.month, parts.day);
}
