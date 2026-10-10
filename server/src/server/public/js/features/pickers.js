import { requestJson } from "../api.js";
import { escHtml } from "../format.js";
import { getOpenTabPaths, getRecentOpenedPaths } from "./documents.js";

export function createPickerFeature({ state, autoResizeInput, updateSendAvailability }) {
  let filePickerFiles = [];
  let fileFocusIndex = -1;
  let fileAtStart = -1;
  let fileDebounceTimer = null;
  let commands = [];
  let commandFocusIndex = -1;
  let commandSlashStart = -1;
  let commandDebounceTimer = null;

  function bindComposer() {
    bindFileList();
    bindCommandList();
    state.inputEl.addEventListener("paste", handlePaste);
    state.inputEl.addEventListener("input", handleAutocompleteInput);
    renderPendingImages();
  }

  function bindGlobalEvents() {
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeydown);
  }

  function renderPendingImages() {
    if (!state.pendingImagesEl) return;
    if (!state.pendingImages.length) {
      state.pendingImagesEl.innerHTML = "";
      state.pendingImagesEl.style.display = "none";
      updateSendAvailability?.();
      return;
    }
    state.pendingImagesEl.style.display = "flex";
    state.pendingImagesEl.innerHTML = state.pendingImages.map((image, index) => `
      <div class="pending-image-item">
        <div class="pending-image-path">${escHtml(image.path || "clipboard:image.png")}</div>
        <button class="pending-image-remove" type="button" data-index="${index}" title="删除">×</button>
      </div>
    `).join("");
    state.pendingImagesEl.querySelectorAll(".pending-image-remove").forEach((button) => {
      button.addEventListener("click", () => {
        state.pendingImages.splice(Number(button.dataset.index), 1);
        renderPendingImages();
      });
    });
    updateSendAvailability?.();
  }

  function bindFileList() {
    const list = document.getElementById("file-picker-list");
    list.addEventListener("click", (event) => {
      const item = event.target.closest(".file-picker-item");
      if (item) confirmFileSelection(item.dataset.path);
    });
    list.addEventListener("mousemove", (event) => {
      const item = event.target.closest(".file-picker-item");
      if (!item) return;
      const index = Number(item.dataset.index);
      if (index !== fileFocusIndex) {
        fileFocusIndex = index;
        updateFileState();
      }
    });
  }

  function isTriliumMentionPath(path) {
    return typeof path === "string" && (path === "trilium" || path.startsWith("trilium/") || path.startsWith("trilium:"));
  }

  function toMentionPath(path) {
    if (!path) return path;
    if (path.startsWith("trilium:")) return path;
    if (path === "trilium" || path.startsWith("trilium/")) {
      const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
      const noteId = parts[parts.length - 1];
      if (noteId && noteId !== "trilium") return `trilium:${noteId}`;
    }
    return path;
  }

  function filePickerLabel(file) {
    const path = toMentionPath(file.path || "");
    const source = file.source || (isTriliumMentionPath(file.path || "") ? "trilium" : "");
    const base = file.name ? `${file.name}  ${path}` : path;
    return source === "trilium" ? `[trilium] ${base}` : base;
  }

  function buildFileList() {
    const empty = document.getElementById("file-picker-empty");
    const list = document.getElementById("file-picker-list");
    list.innerHTML = "";
    empty.style.display = filePickerFiles.length ? "none" : "block";
    filePickerFiles.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "file-picker-item";
      item.dataset.path = toMentionPath(file.path);
      item.dataset.index = String(index);
      item.innerHTML = `<span>${escHtml(filePickerLabel(file))}</span>`;
      list.appendChild(item);
    });
  }

  function updateFileState() {
    const list = document.getElementById("file-picker-list");
    list?.querySelectorAll(".file-picker-item").forEach((item, index) => {
      item.classList.toggle("focused", index === fileFocusIndex);
    });
    list?.querySelector(".file-picker-item.focused")?.scrollIntoView({ block: "nearest" });
  }

  function closeFilePicker() {
    document.getElementById("file-picker-popover")?.classList.remove("open");
    clearTimeout(fileDebounceTimer);
    fileFocusIndex = -1;
    fileAtStart = -1;
    filePickerFiles = [];
  }

  function confirmFileSelection(path) {
    if (!path) return closeFilePicker();
    const value = state.inputEl.value;
    const cursor = state.inputEl.selectionStart;
    const before = value.slice(0, fileAtStart);
    const inserted = `[${path}] `;
    state.inputEl.value = before + inserted + value.slice(cursor);
    const nextCursor = before.length + inserted.length;
    state.inputEl.setSelectionRange(nextCursor, nextCursor);
    state.inputEl.dispatchEvent(new Event("input"));
    closeFilePicker();
    state.inputEl.focus();
  }

  function handleFileInput() {
    const before = state.inputEl.value.slice(0, state.inputEl.selectionStart);
    const match = before.match(/@(\S*)$/);
    if (!match) return closeFilePicker();
    fileAtStart = before.length - match[0].length;
    closeCommandPicker();
    clearTimeout(fileDebounceTimer);
    fileDebounceTimer = setTimeout(async () => {
      const query = match[1];
      const { data } = await requestJson(`/api/files?q=${encodeURIComponent(query)}`);
      const normalizedQuery = query.toLocaleLowerCase();
      // 置顶：最近打开过的文件（最多 3 个，MRU 顺序）+ 当前打开的标签页，去重
      const recentFiles = [...new Set([...getRecentOpenedPaths(), ...getOpenTabPaths()])]
        .filter((filePath) => filePath.toLocaleLowerCase().includes(normalizedQuery))
        .map((filePath) => ({
          path: toMentionPath(filePath),
          source: isTriliumMentionPath(filePath) ? "trilium" : undefined,
        }));
      const recentPaths = new Set(recentFiles.map((file) => file.path));
      const matchedFiles = Array.isArray(data?.files) ? data.files : [];
      filePickerFiles = [...recentFiles, ...matchedFiles.filter((file) => !recentPaths.has(file.path))];
      fileFocusIndex = filePickerFiles.length ? 0 : -1;
      buildFileList();
      updateFileState();
      document.getElementById("file-picker-popover").classList.add("open");
    }, 150);
  }

  function bindCommandList() {
    const list = document.getElementById("command-picker-list");
    list.addEventListener("click", (event) => {
      const item = event.target.closest(".command-picker-item");
      if (item) confirmCommandSelection(commands[Number(item.dataset.index)]?.prompt);
    });
    list.addEventListener("mousemove", (event) => {
      const item = event.target.closest(".command-picker-item");
      if (!item) return;
      const index = Number(item.dataset.index);
      if (index !== commandFocusIndex) {
        commandFocusIndex = index;
        updateCommandState();
      }
    });
  }

  function buildCommandList() {
    const empty = document.getElementById("command-picker-empty");
    const list = document.getElementById("command-picker-list");
    list.innerHTML = "";
    empty.style.display = commands.length ? "none" : "block";
    commands.forEach((command, index) => {
      const item = document.createElement("div");
      const preview = String(command.prompt || "").split(/\r?\n/)[0]?.trim() || "";
      item.className = "command-picker-item";
      item.dataset.index = String(index);
      item.innerHTML = `<div class="command-picker-name">/${escHtml(command.name)}</div><div class="command-picker-preview">${escHtml(preview)}</div>`;
      list.appendChild(item);
    });
  }

  function updateCommandState() {
    const list = document.getElementById("command-picker-list");
    list?.querySelectorAll(".command-picker-item").forEach((item, index) => {
      item.classList.toggle("focused", index === commandFocusIndex);
    });
    list?.querySelector(".command-picker-item.focused")?.scrollIntoView({ block: "nearest" });
  }

  function closeCommandPicker() {
    document.getElementById("command-picker-popover")?.classList.remove("open");
    clearTimeout(commandDebounceTimer);
    commandFocusIndex = -1;
    commandSlashStart = -1;
    commands = [];
  }

  function confirmCommandSelection(prompt) {
    if (!prompt) return closeCommandPicker();
    const cursor = state.inputEl.selectionStart;
    const before = state.inputEl.value.slice(0, commandSlashStart);
    state.inputEl.value = before + prompt + state.inputEl.value.slice(cursor);
    const nextCursor = before.length + prompt.length;
    state.inputEl.setSelectionRange(nextCursor, nextCursor);
    autoResizeInput();
    closeCommandPicker();
    state.inputEl.focus();
  }

  function handleCommandInput() {
    const before = state.inputEl.value.slice(0, state.inputEl.selectionStart);
    const match = before.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!match) return closeCommandPicker();
    commandSlashStart = before.length - match[1].length - 1;
    closeFilePicker();
    clearTimeout(commandDebounceTimer);
    commandDebounceTimer = setTimeout(async () => {
      const { data } = await requestJson(`/api/commands?q=${encodeURIComponent(match[1])}`);
      commands = Array.isArray(data?.commands) ? data.commands : [];
      commandFocusIndex = commands.length ? 0 : -1;
      buildCommandList();
      updateCommandState();
      document.getElementById("command-picker-popover").classList.add("open");
    }, 150);
  }

  function handleAutocompleteInput() {
    handleFileInput();
    handleCommandInput();
  }

  async function handlePaste(event) {
    const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    const url = await readBlobAsDataUrl(file);
    state.pendingImages.push({ url, path: `clipboard:${file.name || "image.png"}` });
    renderPendingImages();
  }

  function handleDocumentClick(event) {
    const path = event.composedPath();
    const file = document.getElementById("file-picker-popover");
    if (file?.classList.contains("open") && !path.includes(file)) closeFilePicker();
    const command = document.getElementById("command-picker-popover");
    if (command?.classList.contains("open") && !path.includes(command)) closeCommandPicker();
  }

  function handleDocumentKeydown(event) {
    if (document.getElementById("file-picker-popover")?.classList.contains("open")) {
      if (event.key === "ArrowDown") fileFocusIndex = Math.min(fileFocusIndex + 1, filePickerFiles.length - 1);
      else if (event.key === "ArrowUp") fileFocusIndex = Math.max(fileFocusIndex - 1, 0);
      else if (event.key === "Enter" && filePickerFiles[fileFocusIndex]) return prevent(event, () => confirmFileSelection(filePickerFiles[fileFocusIndex].path));
      else if (event.key === "Escape") return prevent(event, closeFilePicker);
      else return;
      return prevent(event, updateFileState);
    }
    if (document.getElementById("command-picker-popover")?.classList.contains("open")) {
      if (event.key === "ArrowDown") commandFocusIndex = Math.min(commandFocusIndex + 1, commands.length - 1);
      else if (event.key === "ArrowUp") commandFocusIndex = Math.max(commandFocusIndex - 1, 0);
      else if (event.key === "Enter" && commands[commandFocusIndex]) return prevent(event, () => confirmCommandSelection(commands[commandFocusIndex].prompt));
      else if (event.key === "Escape") return prevent(event, closeCommandPicker);
      else return;
      return prevent(event, updateCommandState);
    }
  }

  return { bindComposer, bindGlobalEvents, renderPendingImages };
}

function prevent(event, action) {
  event.preventDefault();
  action();
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", reject, { once: true });
    reader.readAsDataURL(blob);
  });
}
