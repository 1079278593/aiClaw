import { authHeaders } from "../access-token.js";
import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

const ROOT = "inputs/reflections";
const AUDIO_BLOCK_RE = /^:::aiclaw-audio\[([^\]]*)\]\r?\n([\s\S]*?)^:::\s*$/gm;
const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const MAX_RECORD_MS = 5 * 60 * 1000;

export function createReflectionsFeature({ state, actions }) {
  let tree = [];
  let currentPath = "";
  let draft = null;
  let dirty = false;
  let selectedFolder = "";
  const expanded = new Set();
  /** 自动保存：停键后 debounce，离开前 flush（主流笔记做法） */
  const AUTOSAVE_MS = 1000;
  let saveTimer = null;
  let saveInFlight = null;
  let saveStatus = ""; // "" | saving | saved | error
  let saveGeneration = 0;
  let mediaRecorder = null;
  let recordChunks = [];
  let recordTimer = null;
  let recording = false;
  let recordStream = null;

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
        <button type="button" id="reflections-import-file">拆分文件</button>
        <button type="button" id="reflections-orphans">检查孤儿附件</button>`;
      toolbar.querySelector("#reflections-mkdir")?.addEventListener("click", () => void makeDir());
      toolbar.querySelector("#reflections-import")?.addEventListener("click", () => void importPaste());
      toolbar.querySelector("#reflections-import-file")?.addEventListener("click", () => void importFile());
      toolbar.querySelector("#reflections-orphans")?.addEventListener("click", () => void checkOrphans());
    }
    if (!list) return;
    list.innerHTML = renderFolderNodes(tree, 0) || `<p class="empty-state-copy">还没有文件夹</p>`;
    list.querySelectorAll("[data-folder]").forEach((button) => {
      button.addEventListener("click", () => {
        void (async () => {
          if (!(await ensureSaved())) return;
          selectedFolder = button.dataset.folder || "";
          currentPath = "";
          draft = null;
          dirty = false;
          saveStatus = "";
          renderFolders();
          renderStage();
          syncPreview();
        })();
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
          <div class="reflections-media-toolbar">
            <button type="button" id="reflection-insert-image">插入图片</button>
            <button type="button" id="reflection-record" class="${recording ? "recording" : ""}">${recording ? "结束录音" : "录音"}</button>
            <input id="reflection-image-file" type="file" accept="image/*" hidden>
          </div>
          <textarea id="reflection-body" placeholder="正文">${escHtml(draft?.body || "")}</textarea>
          <div id="reflection-media-preview" class="reflections-media-preview"></div>
          <div id="reflection-assets-overview" class="reflections-assets-overview"></div>
          <div class="reflections-actions">
            <span id="reflection-save-status" class="reflections-save-status">${escHtml(statusLabel())}</span>
            <button type="button" id="reflection-new">新建</button>
            <button type="button" id="reflection-move">移动到…</button>
            <button type="button" id="reflection-organize">按日期归夹</button>
            <button type="button" id="reflection-delete">删除</button>
          </div>
        </div>
      </div>`;
    stage.querySelectorAll("[data-open-folder]").forEach((button) => {
      button.addEventListener("click", () => {
        void (async () => {
          if (!(await ensureSaved())) return;
          selectedFolder = button.dataset.openFolder || "";
          expanded.add(folder.path);
          renderFolders();
          renderStage();
        })();
      });
    });
    stage.querySelectorAll("[data-path]").forEach((button) => {
      button.addEventListener("click", () => void openPath(button.dataset.path || ""));
    });
    const onEdit = () => {
      dirty = true;
      saveStatus = "";
      updateSaveStatus();
      scheduleAutosave();
    };
    stage.querySelector("#reflection-title")?.addEventListener("input", onEdit);
    stage.querySelector("#reflection-body")?.addEventListener("input", () => {
      onEdit();
      scheduleMediaPreview();
    });
    stage.querySelector("#reflection-title")?.addEventListener("blur", () => void flushAutosave());
    stage.querySelector("#reflection-body")?.addEventListener("blur", () => void flushAutosave());
    stage.querySelector("#reflection-title")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        stage.querySelector("#reflection-body")?.focus();
      }
    });
    stage.querySelector("#reflection-new")?.addEventListener("click", () => void beginNew());
    stage.querySelector("#reflection-move")?.addEventListener("click", () => void moveCurrent());
    stage.querySelector("#reflection-organize")?.addEventListener("click", () => void organizeCurrent());
    stage.querySelector("#reflection-delete")?.addEventListener("click", () => void deleteCurrent());
    stage.querySelector("#reflection-publish")?.addEventListener("click", () => void publishQuick());
    stage.querySelector("#reflection-insert-image")?.addEventListener("click", () => {
      stage.querySelector("#reflection-image-file")?.click();
    });
    stage.querySelector("#reflection-image-file")?.addEventListener("change", (event) => {
      const file = event.target?.files?.[0];
      event.target.value = "";
      if (file) void insertImageFile(file);
    });
    stage.querySelector("#reflection-record")?.addEventListener("click", () => void toggleWebRecord());
    scheduleMediaPreview();
    void renderAssetsOverview();
  }

  function updateRecordButton() {
    const button = document.getElementById("reflection-record");
    if (!button) return;
    button.textContent = recording ? "结束录音" : "录音";
    button.classList.toggle("recording", recording);
  }

  function statusLabel() {
    if (recording) return "录音中…";
    if (saveStatus === "saving") return "保存中…";
    if (saveStatus === "saved") return "已保存";
    if (saveStatus === "error") return "保存失败";
    if (dirty) return "未保存";
    return draft?.path ? "已保存" : "";
  }

  function updateSaveStatus() {
    const el = document.getElementById("reflection-save-status");
    if (el) el.textContent = statusLabel();
  }

  function scheduleAutosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveCurrent({ quiet: true });
    }, AUTOSAVE_MS);
  }

  async function flushAutosave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (dirty) await saveCurrent({ quiet: true });
    if (saveInFlight) await saveInFlight;
  }

  async function ensureSaved() {
    await flushAutosave();
    if (!dirty) return true;
    return window.confirm("自动保存尚未完成或失败，切换将可能丢失修改。继续？");
  }

  function readForm() {
    return {
      title: document.getElementById("reflection-title")?.value ?? "",
      body: document.getElementById("reflection-body")?.value ?? "",
    };
  }

  let mediaPreviewTimer = null;
  let mediaPreviewGeneration = 0;
  const blobUrls = new Set();

  function revokeBlobUrls() {
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls.clear();
  }

  function scheduleMediaPreview() {
    clearTimeout(mediaPreviewTimer);
    mediaPreviewTimer = setTimeout(() => {
      mediaPreviewTimer = null;
      void renderMediaPreview();
    }, 200);
  }

  function noteDir(notePath) {
    const idx = notePath.lastIndexOf("/");
    return idx === -1 ? "" : notePath.slice(0, idx + 1);
  }

  function resolveMediaPath(notePath, src) {
    const normalized = String(src || "").replaceAll("\\", "/").trim();
    if (!normalized) return "";
    if (normalized.startsWith("inputs/reflections/")) return normalized;
    const base = noteDir(notePath);
    if (normalized.startsWith("./")) return `${base}${normalized.slice(2)}`;
    return `${base}${normalized}`;
  }

  function parseAudioAttrs(raw) {
    const attrs = {};
    for (const part of String(raw || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      let value = part.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      attrs[key] = value;
    }
    return attrs;
  }

  async function mediaBlobUrl(mediaPath) {
    const response = await fetch(`/api/reflections/media?path=${encodeURIComponent(mediaPath)}`, {
      headers: authHeaders(),
    });
    if (!response.ok) throw new Error("媒体加载失败");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    return url;
  }

  async function renderMediaPreview() {
    const host = document.getElementById("reflection-media-preview");
    if (!host) return;
    const notePath = draft?.path || currentPath;
    const body = document.getElementById("reflection-body")?.value ?? draft?.body ?? "";
    if (!notePath || !body.trim()) {
      revokeBlobUrls();
      host.innerHTML = "";
      return;
    }
    const generation = ++mediaPreviewGeneration;
    const blocks = [];
    AUDIO_BLOCK_RE.lastIndex = 0;
    let match;
    while ((match = AUDIO_BLOCK_RE.exec(body))) {
      const attrs = parseAudioAttrs(match[1]);
      blocks.push({
        kind: "audio",
        id: attrs.id || "",
        src: attrs.src || "",
        transcript: String(match[2] || "").trim(),
      });
    }
    IMAGE_MD_RE.lastIndex = 0;
    while ((match = IMAGE_MD_RE.exec(body))) {
      const src = match[2] || "";
      if (!src.includes(".assets/")) continue;
      blocks.push({ kind: "image", alt: match[1] || "", src });
    }
    if (!blocks.length) {
      revokeBlobUrls();
      host.innerHTML = "";
      return;
    }
    revokeBlobUrls();
    const parts = await Promise.all(blocks.map(async (block, index) => {
      const mediaPath = resolveMediaPath(notePath, block.src);
      try {
        const url = await mediaBlobUrl(mediaPath);
        if (block.kind === "audio") {
          return `<figure class="reflection-media-block reflection-audio-block" data-audio-index="${index}">
            <audio controls preload="metadata" src="${url}"></audio>
            ${block.transcript ? `<figcaption>${escHtml(block.transcript)}</figcaption>` : `<figcaption class="muted">语音</figcaption>`}
            <button type="button" class="reflection-retranscribe" data-audio-id="${escHtml(block.id || "")}">改转写草稿</button>
          </figure>`;
        }
        return `<figure class="reflection-media-block reflection-image-block">
          <img src="${url}" alt="${escHtml(block.alt || "")}" loading="lazy">
        </figure>`;
      } catch {
        return `<p class="empty-state-copy">无法加载 ${escHtml(block.src || "")}</p>`;
      }
    }));
    if (generation !== mediaPreviewGeneration) return;
    host.innerHTML = `<div class="reflections-media-preview-title">文内预览</div>${parts.join("")}`;
    host.querySelectorAll(".reflection-retranscribe").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.audioId || "";
        void editAudioTranscript(id);
      });
    });
    void renderAssetsOverview();
  }

  async function renderAssetsOverview() {
    const host = document.getElementById("reflection-assets-overview");
    if (!host) return;
    const notePath = draft?.path || currentPath;
    if (!notePath) {
      host.innerHTML = "";
      return;
    }
    const { response, data } = await requestJson(`/api/reflections/assets?path=${encodeURIComponent(notePath)}`);
    if (!response.ok) {
      host.innerHTML = "";
      return;
    }
    const assets = data.assets || [];
    if (!assets.length) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = `
      <div class="reflections-media-preview-title">本篇附件（sidecar）</div>
      <ul class="reflections-assets-list">
        ${assets.map((item) => `<li><code>${escHtml(item.name)}</code> · ${escHtml(item.kind)}</li>`).join("")}
      </ul>`;
  }

  function editAudioTranscript(audioId) {
    const textarea = document.getElementById("reflection-body");
    if (!textarea) return;
    const body = textarea.value;
    AUDIO_BLOCK_RE.lastIndex = 0;
    let match;
    let target = null;
    while ((match = AUDIO_BLOCK_RE.exec(body))) {
      const attrs = parseAudioAttrs(match[1]);
      if (!audioId || attrs.id === audioId) {
        target = match;
        break;
      }
    }
    if (!target) {
      window.alert("找不到对应语音块。浏览器无法对已存录音自动重新识别，请直接改标记内草稿；云端精转见后续。");
      return;
    }
    const current = String(target[2] || "").trim();
    const next = window.prompt(
      "编辑转写草稿（系统无法对已存原声自动重转；改字即可。要新识别请再录一条。）",
      current,
    );
    if (next == null) return;
    const attrs = parseAudioAttrs(target[1]);
    const replacement = `:::aiclaw-audio[id=${attrs.id || audioId} src="${attrs.src || ""}"]\n${next.trim()}\n:::`;
    textarea.value = `${body.slice(0, target.index)}${replacement}${body.slice(target.index + target[0].length)}`;
    dirty = true;
    saveStatus = "";
    updateSaveStatus();
    scheduleAutosave();
    scheduleMediaPreview();
  }

  function insertTextAtCaret(textarea, text) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    let prefix = "";
    if (before && !before.endsWith("\n\n")) prefix = before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = after.startsWith("\n") ? "" : "\n\n";
    const next = `${before}${prefix}${text}${suffix}${after}`;
    const cursor = (before + prefix + text + suffix).length;
    textarea.value = next;
    textarea.focus();
    try { textarea.setSelectionRange(cursor, cursor); } catch { /* ignore */ }
    dirty = true;
    saveStatus = "";
    updateSaveStatus();
    scheduleAutosave();
    scheduleMediaPreview();
  }

  async function ensureNotePath() {
    await flushAutosave();
    if (draft?.path) return draft.path;
    const titleEl = document.getElementById("reflection-title");
    if (titleEl && !titleEl.value.trim()) titleEl.value = "未命名心得";
    draft = draft || { title: "", body: "", folder: folderKey(selectedFolder) || "inbox" };
    const ok = await saveCurrent({ quiet: false });
    if (!ok || !draft?.path) {
      actions.showError?.("请先保存这篇心得");
      return "";
    }
    return draft.path;
  }

  async function insertImageFile(file) {
    const notePath = await ensureNotePath();
    if (!notePath) return;
    const body = new FormData();
    body.set("path", notePath);
    body.set("kind", "image");
    body.set("file", file, file.name || "image.jpg");
    const { response, data } = await requestJson("/api/reflections/media", { method: "POST", body });
    if (!response.ok) {
      actions.showError?.(data.error || "上传失败");
      return;
    }
    const textarea = document.getElementById("reflection-body");
    insertTextAtCaret(textarea, data.marker || `![](${data.relativeSrc || ""})`);
  }

  async function toggleWebRecord() {
    if (recording && mediaRecorder) {
      mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      actions.showError?.("当前浏览器不支持录音");
      return;
    }
    const notePath = await ensureNotePath();
    if (!notePath) return;
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      actions.showError?.("无法使用麦克风");
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    recordChunks = [];
    mediaRecorder = mime
      ? new MediaRecorder(recordStream, { mimeType: mime })
      : new MediaRecorder(recordStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data?.size) recordChunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      void (async () => {
        clearTimeout(recordTimer);
        recordTimer = null;
        recording = false;
        updateRecordButton();
        recordStream?.getTracks().forEach((track) => track.stop());
        recordStream = null;
        const type = mediaRecorder?.mimeType || mime || "audio/webm";
        mediaRecorder = null;
        if (!recordChunks.length) return;
        const blob = new Blob(recordChunks, { type });
        recordChunks = [];
        const form = new FormData();
        form.set("path", notePath);
        form.set("kind", "audio");
        form.set("file", blob, type.includes("webm") ? "voice.webm" : "voice.m4a");
        const { response, data } = await requestJson("/api/reflections/media", { method: "POST", body: form });
        if (!response.ok) {
          actions.showError?.(data.error || "上传失败");
          return;
        }
        insertTextAtCaret(
          document.getElementById("reflection-body"),
          data.marker || `:::aiclaw-audio[id=${data.id || ""} src="${data.relativeSrc || ""}"]\n\n:::`,
        );
      })();
    };
    mediaRecorder.start();
    recording = true;
    updateRecordButton();
    recordTimer = setTimeout(() => {
      if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
        actions.showError?.("已达约 5 分钟上限，已自动结束录音");
      }
    }, MAX_RECORD_MS);
  }

  async function checkOrphans() {
    const { response, data } = await requestJson("/api/reflections/orphans");
    if (!response.ok) {
      actions.showError?.(data.error || "检查失败");
      return;
    }
    const orphans = data.orphans || [];
    if (!orphans.length) {
      window.alert("没有发现孤儿 .assets 目录。");
      return;
    }
    const lines = orphans.map((item) => item.path).join("\n");
    window.alert(`发现 ${orphans.length} 个无对应笔记的附件目录（请与 md 一并拖移或手动清理）：\n${lines}`);
  }

  async function openPath(filePath) {
    if (!(await ensureSaved())) return;
    const { response, data } = await requestJson(`/api/reflections/content?path=${encodeURIComponent(filePath)}`);
    if (!response.ok) {
      actions.showError?.(data.error || "打开失败");
      return;
    }
    currentPath = data.reflection.path;
    draft = { ...data.reflection };
    dirty = false;
    saveStatus = "saved";
    renderStage();
    syncPreview();
  }

  async function beginNew() {
    if (!(await ensureSaved())) return;
    currentPath = "";
    draft = { title: "", body: "", folder: folderKey(selectedFolder) || "inbox" };
    dirty = false;
    saveStatus = "";
    renderStage();
    syncPreview();
    document.getElementById("reflection-title")?.focus();
  }

  async function saveCurrent({ quiet = false } = {}) {
    if (!draft) return false;
    const form = readForm();
    const title = form.title.trim() || (form.body.trim() ? "未命名心得" : "");
    if (!title && !form.body.trim()) {
      dirty = false;
      saveStatus = "";
      updateSaveStatus();
      return true;
    }
    const generation = ++saveGeneration;
    const creating = !draft.path;
    const run = (async () => {
      saveStatus = "saving";
      updateSaveStatus();
      const { response, data } = await requestJson(
        creating ? "/api/reflections" : "/api/reflections/content",
        jsonRequest(creating ? "POST" : "PUT", {
          title,
          body: form.body,
          ...(creating
            ? { folder: folderKey(selectedFolder) || draft.folder || "inbox" }
            : { path: draft.path }),
        }),
      );
      if (generation !== saveGeneration) return false;
      if (!response.ok) {
        saveStatus = "error";
        updateSaveStatus();
        if (!quiet) actions.showError?.(data.error || "保存失败");
        return false;
      }
      const wasCreate = creating;
      const prevPath = draft.path || "";
      draft = data.reflection;
      currentPath = draft.path;
      dirty = false;
      saveStatus = "saved";
      updateSaveStatus();
      // 首次创建、标题致改名后刷新列表；普通更新只改标题行，避免打断输入焦点
      if (wasCreate || (prevPath && prevPath !== draft.path)) await refreshNotesOnly();
      else patchActiveNoteTitle(draft.title);
      syncPreview();
      void renderAssetsOverview();
      return true;
    })();
    saveInFlight = run.finally(() => {
      if (saveInFlight === run) saveInFlight = null;
    });
    return saveInFlight;
  }

  async function refreshNotesOnly() {
    const { data } = await requestJson("/api/reflections?view=tree");
    tree = (data.tree || []).filter((node) => node.kind === "directory");
    renderFolders();
    // 保留编辑区内容，只重绘列表区域：整体 renderStage 会丢焦点，故在创建后可接受一次
    const titleEl = document.getElementById("reflection-title");
    const bodyEl = document.getElementById("reflection-body");
    const titleVal = titleEl?.value;
    const bodyVal = bodyEl?.value;
    const titleFocus = document.activeElement === titleEl;
    const bodyFocus = document.activeElement === bodyEl;
    const selStart = (titleFocus ? titleEl : bodyEl)?.selectionStart;
    const selEnd = (titleFocus ? titleEl : bodyEl)?.selectionEnd;
    renderStage();
    const nextTitle = document.getElementById("reflection-title");
    const nextBody = document.getElementById("reflection-body");
    if (nextTitle && titleVal != null) nextTitle.value = titleVal;
    if (nextBody && bodyVal != null) nextBody.value = bodyVal;
    const focusEl = titleFocus ? nextTitle : bodyFocus ? nextBody : null;
    if (focusEl) {
      focusEl.focus();
      if (typeof selStart === "number" && typeof selEnd === "number") {
        try { focusEl.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
      }
    }
  }

  function patchActiveNoteTitle(title) {
    const row = document.querySelector(`.reflections-row.active strong`);
    if (row) row.textContent = title || "未命名";
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
    await flushAutosave();
    if (!draft?.path || !window.confirm("删除这篇心得？")) return;
    const { response, data } = await requestJson(`/api/reflections?path=${encodeURIComponent(draft.path)}`, jsonRequest("DELETE"));
    if (!response.ok) {
      actions.showError?.(data.error || "删除失败");
      return;
    }
    dirty = false;
    saveStatus = "";
    currentPath = "";
    draft = null;
    await loadTree();
  }

  async function moveCurrent() {
    if (!(await ensureSaved()) || !draft?.path) return;
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
    saveStatus = "saved";
    currentPath = data.reflection?.path || "";
    draft = data.reflection || null;
    await loadTree();
  }

  async function organizeCurrent() {
    if (!(await ensureSaved()) || !draft?.path) return;
    const { response, data } = await requestJson("/api/reflections/organize-by-date", jsonRequest("POST", { path: draft.path }));
    if (!response.ok) {
      actions.showError?.(data.error || "归夹失败");
      return;
    }
    dirty = false;
    saveStatus = "saved";
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
    void (async () => {
      if (next !== "reflections" && !(await ensureSaved())) return;
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
    })();
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
    return window.confirm("自动保存尚未完成或失败，切换将可能丢失修改。继续？");
  }

  async function prepareLeave() {
    await flushAutosave();
    return canLeave();
  }

  function bind() {
    document.getElementById("workspace-reflections")?.addEventListener("click", () => setWorkspace("reflections"));
    window.addEventListener("beforeunload", (event) => {
      if (!dirty || state.workspace !== "reflections") return;
      event.preventDefault();
      event.returnValue = "";
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && state.workspace === "reflections") void flushAutosave();
    });
  }

  return { bind, remount, setWorkspace, applyWorkspaceChrome, canLeave, prepareLeave };
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
