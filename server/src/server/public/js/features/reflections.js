import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

export function createReflectionsFeature({ state, actions }) {
  let items = [];
  let tree = [];
  let currentPath = "";
  let draft = null;
  let dirty = false;
  let viewMode = "list"; // list | tree
  let query = "";
  let filterFolder = ""; // tree 模式下选中的目录（相对 reflections 根）

  function syncPreview() {
    if (state.workspace !== "reflections" || !currentPath) {
      state.reflectionPreview = null;
      return;
    }
    state.reflectionPreview = { previewPath: currentPath };
  }

  async function loadList(selectPath) {
    const q = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    const { data } = await requestJson(`/api/reflections${q}`);
    items = data.reflections || [];
    if (viewMode === "tree") {
      const treeRes = await requestJson("/api/reflections?view=tree");
      tree = treeRes.data.tree || [];
    }
    renderList();
    const target = selectPath || currentPath;
    const visible = visibleItems();
    if (target && (items.some((item) => item.path === target) || visible.some((item) => item.path === target))) {
      await openPath(target);
    } else if (visible[0]) {
      await openPath(visible[0].path);
    } else {
      currentPath = "";
      draft = null;
      renderStage();
      syncPreview();
    }
  }

  function visibleItems() {
    if (viewMode !== "tree" || !filterFolder) return items;
    const prefix = filterFolder === "" ? "inputs/reflections/" : `inputs/reflections/${filterFolder}/`;
    return items.filter((item) => item.path.startsWith(prefix) && !item.path.slice(prefix.length).includes("/"));
  }

  function renderList() {
    const toolbar = document.getElementById("reflections-toolbar");
    const list = document.getElementById("reflections-list");
    if (!toolbar || !list) return;
    toolbar.innerHTML = `
      <button type="button" data-view="list" class="${viewMode === "list" ? "active" : ""}">时间序</button>
      <button type="button" data-view="tree" class="${viewMode === "tree" ? "active" : ""}">目录</button>
      <button type="button" id="reflections-create">新建</button>
      <button type="button" id="reflections-import">粘贴导入</button>
      <button type="button" id="reflections-import-file">拆分文件</button>
      <button type="button" id="reflections-mkdir">新建文件夹</button>
      <input id="reflections-search" type="search" placeholder="搜索" value="${escHtml(query)}">`;
    toolbar.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        viewMode = button.dataset.view;
        void loadList(currentPath);
      });
    });
    toolbar.querySelector("#reflections-create")?.addEventListener("click", () => void createBlank());
    toolbar.querySelector("#reflections-import")?.addEventListener("click", () => void importPaste());
    toolbar.querySelector("#reflections-import-file")?.addEventListener("click", () => void importFile());
    toolbar.querySelector("#reflections-mkdir")?.addEventListener("click", () => void makeDir());
    const search = toolbar.querySelector("#reflections-search");
    search?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        query = search.value || "";
        void loadList(currentPath);
      }
    });

    if (viewMode === "tree") {
      list.innerHTML = `
        <div class="reflections-tree">
          <button type="button" class="reflections-folder ${filterFolder === "" ? "active" : ""}" data-folder="">全部</button>
          ${renderTreeNodes(tree, 0)}
        </div>
        <div class="reflections-tree-files">${renderFileRows(visibleItems())}</div>`;
      list.querySelectorAll("[data-folder]").forEach((button) => {
        button.addEventListener("click", () => {
          filterFolder = button.dataset.folder || "";
          renderList();
        });
      });
    } else {
      filterFolder = "";
      list.innerHTML = renderFileRows(items);
    }
    list.querySelectorAll(".reflections-row[data-path]").forEach((button) => {
      button.addEventListener("click", () => void openPath(button.dataset.path));
    });
  }

  function renderTreeNodes(nodes, depth) {
    return (nodes || []).filter((node) => node.kind === "directory").map((node) => {
      const folder = node.path.replace(/^inputs\/reflections\/?/, "");
      const active = filterFolder === folder ? "active" : "";
      return `
        <button type="button" class="reflections-folder ${active}" data-folder="${escHtml(folder)}" style="padding-left:${8 + depth * 12}px">
          ${escHtml(node.name || "/")}
        </button>
        ${renderTreeNodes(node.children || [], depth + 1)}`;
    }).join("");
  }

  function renderFileRows(rows) {
    return rows.map((item) => `
      <button type="button" class="reflections-row ${item.path === currentPath ? "active" : ""}" data-path="${escHtml(item.path)}">
        <strong>${escHtml(item.title || "未命名")}</strong>
        <span>${escHtml(formatOccurred(item.occurredAt))}${item.context ? ` · ${escHtml(item.context)}` : ""}${item.folder ? ` · ${escHtml(item.folder)}` : ""}</span>
      </button>`).join("") || `<p class="empty-state-copy">还没有心得。可新建，或把文件拖进数据目录 inputs/reflections/</p>`;
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
    renderList();
    renderStage();
    syncPreview();
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
    if (!draft) {
      stage.innerHTML = `<p class="empty-state-copy">选择或新建一篇心得</p>`;
      return;
    }
    stage.innerHTML = `
      <div class="reflections-editor">
        <input id="reflection-title" type="text" placeholder="标题" value="${escHtml(draft.title || "")}">
        <input id="reflection-occurred" type="text" placeholder="发生时刻（如 2026-10-28T11:28:28+08:00）" value="${escHtml(draft.occurredAt || "")}">
        <input id="reflection-context" type="text" placeholder="情境（地点 / 事件）" value="${escHtml(draft.context || "")}">
        <textarea id="reflection-body" placeholder="正文">${escHtml(draft.body || "")}</textarea>
        <div class="reflections-actions">
          <button type="button" id="reflection-save">保存</button>
          <button type="button" id="reflection-move">移动到…</button>
          <button type="button" id="reflection-organize">按日期归夹</button>
          <button type="button" id="reflection-delete">删除</button>
          <span class="reflections-path">${escHtml(draft.path || "")}</span>
        </div>
      </div>`;
    const markDirty = () => { dirty = true; };
    stage.querySelector("#reflection-title")?.addEventListener("input", markDirty);
    stage.querySelector("#reflection-occurred")?.addEventListener("input", markDirty);
    stage.querySelector("#reflection-context")?.addEventListener("input", markDirty);
    stage.querySelector("#reflection-body")?.addEventListener("input", markDirty);
    stage.querySelector("#reflection-save")?.addEventListener("click", () => void saveCurrent());
    stage.querySelector("#reflection-move")?.addEventListener("click", () => void moveCurrent());
    stage.querySelector("#reflection-organize")?.addEventListener("click", () => void organizeCurrent());
    stage.querySelector("#reflection-delete")?.addEventListener("click", () => void deleteCurrent());
  }

  function readForm() {
    return {
      title: document.getElementById("reflection-title")?.value ?? "",
      occurredAt: document.getElementById("reflection-occurred")?.value ?? "",
      context: document.getElementById("reflection-context")?.value ?? "",
      body: document.getElementById("reflection-body")?.value ?? "",
    };
  }

  async function saveCurrent() {
    if (!draft?.path) return;
    const form = readForm();
    const { response, data } = await requestJson("/api/reflections/content", jsonRequest("PUT", {
      path: draft.path,
      ...form,
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "保存失败");
      return;
    }
    draft = data.reflection;
    currentPath = draft.path;
    dirty = false;
    await loadList(currentPath);
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
    await loadList();
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
    await loadList(data.reflection?.path);
  }

  async function organizeCurrent() {
    if (!draft?.path) return;
    const { response, data } = await requestJson("/api/reflections/organize-by-date", jsonRequest("POST", { path: draft.path }));
    if (!response.ok) {
      actions.showError?.(data.error || "归夹失败");
      return;
    }
    dirty = false;
    await loadList(data.reflection?.path);
  }

  async function createBlank() {
    if (dirty && !window.confirm("当前心得未保存，新建将丢弃修改。继续？")) return;
    const title = window.prompt("标题", "未命名心得");
    if (!title || !title.trim()) return;
    const folder = filterFolder || "inbox";
    const { response, data } = await requestJson("/api/reflections", jsonRequest("POST", {
      title: title.trim(),
      body: "",
      folder,
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "创建失败");
      return;
    }
    dirty = false;
    await loadList(data.reflection?.path);
  }

  async function importPaste() {
    const text = window.prompt("粘贴记事本内容（标题\\n时间情境行\\n正文；多篇在下一篇标题前空一行）");
    if (text == null || !text.trim()) return;
    await commitImport({ text, folder: filterFolder || "inbox" });
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
    if (!window.confirm(`将从该文件拆出 ${previewItems.length} 篇到 inbox：\n${preview}\n\n确认后写入，并可选择删除源文件。`)) return;
    const deleteSource = window.confirm("写入成功后删除源文件？");
    await commitImport({
      sourcePath: sourcePath.trim(),
      folder: filterFolder || "inbox",
      deleteSource,
    });
  }

  async function commitImport(payload) {
    const { response, data } = await requestJson("/api/reflections/import", jsonRequest("POST", payload));
    if (!response.ok) {
      actions.showError?.(data.error || "导入失败");
      return;
    }
    const created = data.reflections || [];
    dirty = false;
    await loadList(created[created.length - 1]?.path);
  }

  async function makeDir() {
    const folder = window.prompt("新建文件夹（相对 reflections，如 散步随想）");
    if (!folder || !folder.trim()) return;
    const { response, data } = await requestJson("/api/reflections/mkdir", jsonRequest("POST", { folder: folder.trim() }));
    if (!response.ok) {
      actions.showError?.(data.error || "创建失败");
      return;
    }
    viewMode = "tree";
    filterFolder = folder.trim().replace(/^inputs\/reflections\/?/, "");
    await loadList(currentPath);
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
      void loadList(currentPath);
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

function formatOccurred(value) {
  if (!value) return "";
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (matched) return `${matched[1]} ${matched[2]}`;
  const cn = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return cn ? `${cn[1]}-${cn[2]}-${cn[3]}` : value;
}
