import { authHeaders } from "../access-token.js";
import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

const ROOT = "inputs/reflections";
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
          <button type="button" class="reflections-folder ${active}" data-folder="${escHtml(node.path)}" title="右键或长按：重命名、删除文件夹">${escHtml(node.name || "/")}</button>
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
        if (Date.now() - menuShownAt < 400) return;
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
      bindLongPressMenu(button, (x, y) => showFolderMenu(button.dataset.folder || "", x, y));
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
            <button type="button" class="reflections-row ${note.path === currentPath ? "active" : ""}" data-path="${escHtml(note.path)}" title="右键或长按：重命名、移动、删除">
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
          <textarea id="reflection-body" hidden>${escHtml(draft?.body || "")}</textarea>
          <div id="reflection-composed" class="reflection-composed"></div>
          <div id="reflection-media-preview" class="reflections-media-preview" hidden></div>
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
        if (Date.now() - menuShownAt < 400) return;
        void (async () => {
          if (!(await ensureSaved())) return;
          selectedFolder = button.dataset.openFolder || "";
          expanded.add(folder.path);
          renderFolders();
          renderStage();
        })();
      });
      bindLongPressMenu(button, (x, y) => showFolderMenu(button.dataset.openFolder || "", x, y));
    });
    stage.querySelectorAll("[data-path]").forEach((button) => {
      button.addEventListener("click", () => {
        if (Date.now() - menuShownAt < 400) return;
        void openPath(button.dataset.path || "");
      });
      bindLongPressMenu(button, (x, y) => showNoteMenu(button.dataset.path || "", x, y));
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
        stage.querySelector("#reflection-composed")?.focus();
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

  function syncBodyFromPieces() {
    const hidden = document.getElementById("reflection-body");
    const host = document.getElementById("reflection-composed");
    if (!hidden || !host) return;
    hidden.value = serializeEditor(host).after;
  }

  function serializeEditor(root, pivot = null) {
    let before = "";
    let after = "";
    let passed = !pivot;
    const append = (text) => {
      if (passed) after += text;
      else before += text;
    };
    const written = () => (passed ? after : before);
    const walk = (node) => {
      if (pivot && node === pivot) {
        passed = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.textContent.replace(/\u00a0/g, " "));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node._raw) {
        append(node._raw);
        if (pivot && node.contains(pivot)) passed = true;
        return;
      }
      if (node.tagName === "BR") {
        if (!node.classList.contains("note-caret")) append("\n");
        return;
      }
      const block = node.tagName === "DIV" || node.tagName === "P";
      if (block && written() && !written().endsWith("\n")) append("\n");
      for (const child of node.childNodes) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return { before, after };
  }

  function appendEditorText(host, text) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) host.append(document.createElement("br"));
      if (line) host.append(document.createTextNode(line));
    });
  }

  function bindEditor(host) {
    if (host.dataset.bound === "1") return;
    host.dataset.bound = "1";
    host.contentEditable = "true";
    host.spellcheck = false;
    host.addEventListener("input", () => {
      if (host.dataset.rendering === "1") return;
      syncBodyFromPieces();
      dirty = true;
      saveStatus = "";
      updateSaveStatus();
      scheduleAutosave();
    });
    host.addEventListener("blur", () => void flushAutosave());
    host.addEventListener("keydown", (event) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const block = attachmentBesideCaret(event.key === "Backspace" ? "back" : "forward");
      if (!block) return;
      event.preventDefault();
      void removeAttachment(block, { confirm: false });
    });
  }

  const ATTACHMENT_SELECTOR = ".note-audio, .reflection-image-piece";

  function audioMarkerText({ id, src, name, transcript }) {
    const parts = [`id=${id || ""}`, `src="${src || ""}"`];
    const title = String(name || "").replace(/"/g, "").trim();
    if (title) parts.push(`name="${title}"`);
    return `:::aiclaw-audio[${parts.join(" ")}]\n${String(transcript || "").trim()}\n:::`;
  }

  function replaceAttachmentRaw(block, nextRaw) {
    const hidden = document.getElementById("reflection-body");
    const raw = block?._raw || "";
    if (!hidden || !raw) return false;
    const index = hidden.value.indexOf(raw);
    if (index === -1) return false;
    hidden.value = `${hidden.value.slice(0, index)}${nextRaw}${hidden.value.slice(index + raw.length)}`;
    block._raw = nextRaw;
    dirty = true;
    saveStatus = "";
    updateSaveStatus();
    scheduleAutosave();
    return true;
  }

  let openMenuEl = null;
  let menuDismiss = null;
  let menuShownAt = 0;

  function closeMenu() {
    openMenuEl?.remove();
    openMenuEl = null;
    if (menuDismiss) {
      document.removeEventListener("pointerdown", menuDismiss, true);
      menuDismiss = null;
    }
  }

  function openAnchoredMenu(items, x, y, onPick) {
    closeMenu();
    menuShownAt = Date.now();
    const menu = document.createElement("div");
    menu.className = "note-attachment-menu";
    menu.innerHTML = items
      .map(([action, label]) => `<button type="button" data-action="${action}">${escHtml(label)}</button>`)
      .join("");
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    openMenuEl = menu;
    menu.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      closeMenu();
      onPick(button.dataset.action);
    });
    menuDismiss = (event) => {
      if (event.target.closest?.(".note-attachment-menu")) return;
      closeMenu();
    };
    setTimeout(() => {
      if (menuDismiss) document.addEventListener("pointerdown", menuDismiss, true);
    }, 0);
  }

  function bindLongPressMenu(element, handler) {
    let timer = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    element.addEventListener("pointerdown", (event) => {
      const innerButton = event.target.closest?.("button");
      if (event.button !== 0 || (innerButton && innerButton !== element)) return;
      const { clientX, clientY } = event;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        // 长按后松手通常还会冒出一个 click，别让它顺带打开笔记/切换文件夹
        const swallow = (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        element.addEventListener("click", swallow, true);
        setTimeout(() => element.removeEventListener("click", swallow, true), 800);
        handler(clientX, clientY);
      }, 500);
    });
    element.addEventListener("pointerup", cancel);
    element.addEventListener("pointerleave", cancel);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      cancel();
      handler(event.clientX, event.clientY);
    });
  }

  function previousNode(node) {
    if (node.previousSibling) {
      let prev = node.previousSibling;
      while (prev.lastChild) prev = prev.lastChild;
      return prev;
    }
    return node.parentNode;
  }

  function nextNode(node) {
    if (node.nextSibling) return node.nextSibling;
    let parent = node.parentNode;
    while (parent && !parent.nextSibling) parent = parent.parentNode;
    return parent ? parent.nextSibling : null;
  }

  /** 光标紧挨着录音/图片块时（或整块被选中时），找出这一块，供退格删除。 */
  function attachmentBesideCaret(direction) {
    const host = document.getElementById("reflection-composed");
    const selection = window.getSelection();
    if (!host || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer)) return null;
    const cardOf = (node) => {
      const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      return el?.closest?.(ATTACHMENT_SELECTOR) || null;
    };
    if (!range.collapsed) {
      return cardOf(range.startContainer)
        || cardOf(range.endContainer)
        || [...host.querySelectorAll(ATTACHMENT_SELECTOR)].find((el) => range.intersectsNode(el))
        || null;
    }
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const length = (range.startContainer.textContent || "").length;
      if (direction === "back" && range.startOffset > 0) return null;
      if (direction === "forward" && range.startOffset < length) return null;
    }
    let node = range.startContainer;
    for (let step = 0; step < 80; step += 1) {
      node = direction === "back" ? previousNode(node) : nextNode(node);
      if (!node || !host.contains(node)) return null;
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent || "").trim()) return null;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (cardOf(node)) return cardOf(node);
      if (node.tagName === "BR") continue;
      return null;
    }
    return null;
  }

  function splitReflectionPieces(body) {
    const re = /^:::aiclaw-audio\[([^\]]*)\]\r?\n([\s\S]*?)^:::[ \t]*$|!\[([^\]]*)\]\(([^)\s]*\.assets\/[^)\s]+)\)/gm;
    const pieces = [];
    let index = 0;
    let match;
    while ((match = re.exec(body))) {
      if (match.index > index) pieces.push({ kind: "text", text: body.slice(index, match.index) });
      if (match[0].startsWith(":::")) {
        const attrs = parseAudioAttrs(match[1]);
        pieces.push({
          kind: "audio",
          raw: match[0],
          id: attrs.id || "",
          src: attrs.src || "",
          name: attrs.name || "",
          transcript: String(match[2] || "").trim(),
        });
      } else {
        pieces.push({ kind: "image", raw: match[0], alt: match[3] || "", src: match[4] || "" });
      }
      index = match.index + match[0].length;
    }
    if (index < body.length || pieces.length === 0) pieces.push({ kind: "text", text: body.slice(index) });
    if (pieces[pieces.length - 1].kind !== "text") pieces.push({ kind: "text", text: "" });
    return pieces;
  }

  function audioRecordedLabel(id) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id || "");
    if (!match) return "";
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatAudioLength(seconds) {
    if (!Number.isFinite(seconds)) return "--:--";
    const total = Math.max(0, Math.floor(seconds));
    const rest = String(total % 60).padStart(2, "0");
    const hours = Math.floor(total / 3600);
    if (hours > 0) return `${hours}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${rest}`;
    return `${Math.floor(total / 60)}:${rest}`;
  }

  function bindAudioCard(card, audio, block) {
    const play = card.querySelector(".note-audio-play");
    const back = card.querySelector(".note-audio-back");
    const forward = card.querySelector(".note-audio-forward");
    const length = card.querySelector(".note-audio-duration");
    const setTransport = (open) => {
      if (back) back.hidden = !open;
      if (forward) forward.hidden = !open;
    };
    audio.addEventListener("loadedmetadata", () => {
      if (length) length.textContent = formatAudioLength(audio.duration);
    });
    audio.addEventListener("pause", () => {
      if (play) play.textContent = "▶";
    });
    audio.addEventListener("playing", () => {
      if (play) play.textContent = "❚❚";
      setTransport(true);
    });
    play?.addEventListener("click", () => {
      setTransport(true);
      if (!audio?.src) return;
      if (audio.paused) {
        audio.play().catch(() => {
          if (length) length.textContent = "无法播放";
        });
      } else {
        audio.pause();
      }
    });
    const seek = (delta) => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime;
      audio.currentTime = Math.min(duration, Math.max(0, audio.currentTime + delta));
      if (audio.paused) void audio.play();
    };
    back?.addEventListener("click", () => seek(-15));
    forward?.addEventListener("click", () => seek(15));
    card.querySelector(".note-audio-excerpt")?.addEventListener("dblclick", () => editAudioTranscript(block));
    bindLongPressMenu(card, (x, y) => showAttachmentMenu(block, x, y));
  }

  function showAttachmentMenu(block, x, y) {
    const isAudio = block.classList.contains("note-audio");
    const items = isAudio
      ? [["rename", "重命名"], ["transcript", "编辑听写文本"], ["delete", "删除"]]
      : [["delete", "删除"]];
    openAnchoredMenu(items, x, y, (action) => {
      if (action === "delete") void removeAttachment(block, { confirm: true });
      else if (action === "rename") renameAttachment(block);
      else if (action === "transcript") editAudioTranscript(block);
    });
  }

  function audioAttrsOf(block) {
    const match = /^:::aiclaw-audio\[([^\]]*)\]/.exec(block?._raw || "");
    return parseAudioAttrs(match ? match[1] : "");
  }

  async function removeAttachment(block, { confirm } = {}) {
    const isAudio = block.classList.contains("note-audio");
    if (confirm && !window.confirm(isAudio ? "删除这条录音？" : "删除这张图片？")) return;
    const hidden = document.getElementById("reflection-body");
    const raw = block._raw || "";
    if (!hidden || !raw) return;
    const index = hidden.value.indexOf(raw);
    if (index === -1) return;
    const src = isAudio
      ? audioAttrsOf(block).src || ""
      : (/!\[[^\]]*\]\(([^)]+)\)/.exec(raw)?.[1] || "");
    hidden.value = `${hidden.value.slice(0, index)}${hidden.value.slice(index + raw.length)}`;
    block.remove();
    dirty = true;
    saveStatus = "";
    updateSaveStatus();
    await flushAutosave();
    const notePath = draft?.path || currentPath;
    if (src && notePath) {
      const mediaPath = resolveMediaPath(notePath, src);
      const { response, data } = await requestJson(
        `/api/reflections/media?path=${encodeURIComponent(mediaPath)}`,
        jsonRequest("DELETE"),
      );
      if (!response.ok && response.status !== 404) actions.showError?.(data.error || "附件删除失败");
    }
    scheduleMediaPreview();
  }

  function renameAttachment(block) {
    const attrs = audioAttrsOf(block);
    const next = window.prompt("录音名称", attrs.name || "录音");
    if (next == null) return;
    const nextRaw = audioMarkerText({
      id: attrs.id,
      src: attrs.src,
      name: next,
      transcript: block._transcript || "",
    });
    if (replaceAttachmentRaw(block, nextRaw)) scheduleMediaPreview();
  }

  async function renderMediaPreview() {
    const host = document.getElementById("reflection-composed");
    const hidden = document.getElementById("reflection-body");
    if (!host || !hidden) return;
    const notePath = draft?.path || currentPath;
    const body = hidden.value ?? draft?.body ?? "";
    const generation = ++mediaPreviewGeneration;
    const pieces = splitReflectionPieces(body);
    revokeBlobUrls();
    bindEditor(host);
    host.dataset.rendering = "1";
    host.replaceChildren();
    const caret = () => {
      const br = document.createElement("br");
      br.className = "note-caret";
      return br;
    };
    if (pieces[0]?.kind && pieces[0].kind !== "text") host.append(caret());
    let previousMedia = false;
    for (const piece of pieces) {
      if (generation !== mediaPreviewGeneration) {
        delete host.dataset.rendering;
        return;
      }
      if (piece.kind === "text") {
        if (piece.text) appendEditorText(host, piece.text);
        else if (pieces.some((item) => item.kind !== "text")) host.append(caret());
        previousMedia = false;
        continue;
      }
      if (previousMedia) host.append(caret());
      previousMedia = true;
      const block = document.createElement("div");
      block.className = piece.kind === "audio" ? "note-audio" : "reflection-image-piece";
      block.contentEditable = "false";
      block._raw = piece.raw;
      block.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        event.preventDefault();
      });
      if (piece.kind === "image") {
        try {
          const url = notePath ? await mediaBlobUrl(resolveMediaPath(notePath, piece.src)) : "";
          block.innerHTML = url
            ? `<img src="${url}" alt="${escHtml(piece.alt || "")}">`
            : `<p class="empty-state-copy">无法加载图片</p>`;
        } catch {
          block.innerHTML = `<p class="empty-state-copy">无法加载图片</p>`;
        }
        host.append(block);
        continue;
      }
      const when = audioRecordedLabel(piece.id);
      const excerpt = piece.transcript || "无";
      const title = piece.name || "录音";
      block._transcript = piece.transcript;
      block.innerHTML = `
        <div class="note-audio-head">
          <div class="note-audio-heading">
            <div class="note-audio-title">${escHtml(title)}</div>
            ${when ? `<div class="note-audio-time">${escHtml(when)}</div>` : ""}
            <div class="note-audio-duration">--:--</div>
          </div>
          <div class="note-audio-controls">
            <button type="button" class="note-audio-back" hidden aria-label="倒退15秒">15</button>
            <button type="button" class="note-audio-play" aria-label="播放">▶</button>
            <button type="button" class="note-audio-forward" hidden aria-label="前进15秒">15</button>
          </div>
        </div>
        <hr>
        <div class="note-audio-label">听写文本</div>
        <div class="note-audio-excerpt">${escHtml(excerpt)}</div>
        <audio preload="metadata"></audio>`;
      const audio = block.querySelector("audio");
      try {
        if (notePath && audio) audio.src = await mediaBlobUrl(resolveMediaPath(notePath, piece.src));
      } catch {
        block.querySelector(".note-audio-duration").textContent = "无法播放";
      }
      bindAudioCard(block, audio, block);
      host.append(block);
    }
    delete host.dataset.rendering;
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

  function editAudioTranscript(block) {
    const attrs = audioAttrsOf(block);
    const next = window.prompt(
      "编辑转写草稿（系统无法对已存原声自动重转；改字即可。要新识别请再录一条。）",
      block._transcript || "",
    );
    if (next == null) return;
    const nextRaw = audioMarkerText({
      id: attrs.id,
      src: attrs.src,
      name: attrs.name,
      transcript: next,
    });
    if (replaceAttachmentRaw(block, nextRaw)) {
      block._transcript = next.trim();
      scheduleMediaPreview();
    }
  }

  function insertTextAtCaret(textarea, text) {
    const host = document.getElementById("reflection-composed");
    if (host) {
      const pivot = document.createElement("span");
      const selection = window.getSelection();
      if (selection?.rangeCount && host.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.collapse(false);
        range.insertNode(pivot);
      } else {
        host.append(pivot);
      }
      const { before, after } = serializeEditor(host, pivot);
      pivot.remove();
      const hidden = document.getElementById("reflection-body");
      const lead = before && !before.endsWith("\n") ? "\n" : "";
      const trail = after && !after.startsWith("\n") ? "\n" : "";
      if (hidden) hidden.value = `${before}${lead}${text}${trail}${after}`;
      dirty = true;
      saveStatus = "";
      updateSaveStatus();
      scheduleAutosave();
      scheduleMediaPreview();
      return;
    }
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

  function showNoteMenu(notePath, x, y) {
    openAnchoredMenu(
      [["rename", "重命名"], ["move", "移动到…"], ["delete", "删除"]],
      x,
      y,
      (action) => {
        if (action === "rename") void renameNoteAt(notePath);
        else if (action === "move") void moveNoteAt(notePath);
        else if (action === "delete") void deleteNoteAt(notePath);
      },
    );
  }

  function showFolderMenu(folderPath, x, y) {
    openAnchoredMenu(
      [["rename", "重命名文件夹"], ["mkdir", "新建子文件夹"], ["delete", "删除文件夹"]],
      x,
      y,
      (action) => {
        if (action === "rename") void renameFolderAt(folderPath);
        else if (action === "mkdir") void makeSubFolder(folderPath);
        else if (action === "delete") void deleteFolderAt(folderPath);
      },
    );
  }

  async function renameNoteAt(notePath) {
    await flushAutosave();
    const { response, data } = await requestJson(`/api/reflections/content?path=${encodeURIComponent(notePath)}`);
    if (!response.ok) {
      actions.showError?.(data.error || "读取失败");
      return;
    }
    const doc = data.reflection;
    const current = doc?.title || "";
    const next = window.prompt("重命名心得", current);
    if (next == null) return;
    const title = next.trim();
    if (!title || title === current) return;
    const put = await requestJson("/api/reflections/content", jsonRequest("PUT", {
      path: notePath,
      title,
      body: doc?.body ?? "",
    }));
    if (!put.response.ok) {
      actions.showError?.(put.data.error || "重命名失败");
      return;
    }
    if (currentPath === notePath) {
      currentPath = put.data.reflection?.path || currentPath;
      draft = put.data.reflection || draft;
      dirty = false;
      saveStatus = "saved";
    }
    await loadTree();
  }

  async function moveNoteAt(notePath) {
    const folder = window.prompt("移动到文件夹（相对 reflections，如 散步随想/大沙河）", folderKey(selectedFolder) || "inbox");
    if (folder == null) return;
    const { response, data } = await requestJson("/api/reflections/move", jsonRequest("POST", {
      from: notePath,
      toFolder: folder.trim() || "inbox",
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "移动失败");
      return;
    }
    if (currentPath === notePath) {
      currentPath = data.reflection?.path || "";
      draft = data.reflection || null;
      dirty = false;
      saveStatus = "saved";
    }
    await loadTree();
  }

  async function deleteNoteAt(notePath) {
    if (!window.confirm("删除这篇心得？")) return;
    await flushAutosave();
    const { response, data } = await requestJson(
      `/api/reflections?path=${encodeURIComponent(notePath)}`,
      jsonRequest("DELETE"),
    );
    if (!response.ok) {
      actions.showError?.(data.error || "删除失败");
      return;
    }
    if (currentPath === notePath) {
      currentPath = "";
      draft = null;
      dirty = false;
      saveStatus = "";
    }
    await loadTree();
  }

  async function renameFolderAt(folderPath) {
    const current = folderPath.slice(folderPath.lastIndexOf("/") + 1);
    const next = window.prompt("文件夹名称", current);
    if (next == null) return;
    const name = next.trim();
    if (!name || name === current) return;
    const { response, data } = await requestJson("/api/reflections/rename-folder", jsonRequest("POST", {
      path: folderPath,
      name,
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "重命名失败");
      return;
    }
    const nextPath = data.path || folderPath;
    const remap = (value) => (value === folderPath
      ? nextPath
      : value.startsWith(`${folderPath}/`) ? `${nextPath}${value.slice(folderPath.length)}` : value);
    selectedFolder = remap(selectedFolder);
    currentPath = remap(currentPath);
    if (expanded.delete(folderPath)) expanded.add(nextPath);
    await loadTree();
  }

  async function deleteFolderAt(folderPath) {
    if (!window.confirm("删除这个文件夹，以及里面的全部心得和附件？")) return;
    await flushAutosave();
    const { response, data } = await requestJson(
      `/api/reflections/folder?path=${encodeURIComponent(folderPath)}`,
      jsonRequest("DELETE"),
    );
    if (!response.ok) {
      actions.showError?.(data.error || "删除失败");
      return;
    }
    if (selectedFolder === folderPath || selectedFolder.startsWith(`${folderPath}/`)) selectedFolder = "";
    if (currentPath === folderPath || currentPath.startsWith(`${folderPath}/`)) {
      currentPath = "";
      draft = null;
      dirty = false;
      saveStatus = "";
    }
    await loadTree();
  }

  async function makeSubFolder(folderPath) {
    const name = window.prompt("新建子文件夹");
    if (!name?.trim()) return;
    const { response, data } = await requestJson("/api/reflections/mkdir", jsonRequest("POST", {
      folder: `${folderPath}/${name.trim()}`,
    }));
    if (!response.ok) {
      actions.showError?.(data.error || "创建失败");
      return;
    }
    expanded.add(folderPath);
    if (data.path) selectedFolder = data.path;
    await loadTree();
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
