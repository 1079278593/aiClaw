import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

export function createPeopleFeature({ state, actions }) {
  let sort = "recent";
  let people = [];
  let personId = "";
  let detail = null;
  let entries = [];
  let pane = "raw";
  let mine = false;
  let note = false;

  function threadPath() {
    return personId ? `inputs/people/${personId}` : "";
  }

  function syncThread() {
    if (state.workspace !== "people" || !personId) {
      state.personThread = null;
      const banner = document.getElementById("person-banner");
      if (banner) banner.hidden = true;
      const button = document.getElementById("organize-btn");
      if (button) button.hidden = true;
      return;
    }
    const organizedAt = detail?.person?.organizedAt || "";
    const canOrganize = entries.some((entry) => !organizedAt || entry.at > organizedAt);
    const samePerson = state.personThread?.id === personId;
    const selectedText = samePerson ? state.personThread.selectedText || "" : "";
    const previewPath = pane === "raw"
      ? `${threadPath()}/entries.jsonl`
      : pane === "digest"
        ? `${threadPath()}/digest.md`
        : selectedText ? state.personThread.previewPath || "" : "";
    state.personThread = {
      id: personId,
      name: detail?.person?.name || "",
      canOrganize,
      previewPath,
      selectedText,
      captureJob: state.personThread?.captureJob,
    };
    const banner = document.getElementById("person-banner");
    if (banner) {
      banner.hidden = false;
      banner.textContent = `带上${state.personThread.name}的档案`;
    }
    const button = document.getElementById("organize-btn");
    if (button) {
      button.hidden = false;
      button.disabled = !canOrganize || state.isStreaming;
    }
  }

  async function loadPeople() {
    const { data } = await requestJson(`/api/people?sort=${sort}`);
    people = data.people || [];
    renderList();
  }

  function renderList() {
    const toolbar = document.getElementById("people-toolbar");
    const list = document.getElementById("people-list");
    if (!toolbar || !list) return;
    toolbar.innerHTML = `
      <button type="button" data-sort="recent" class="${sort === "recent" ? "active" : ""}">最近</button>
      <button type="button" data-sort="name" class="${sort === "name" ? "active" : ""}">按称呼</button>
      <button type="button" id="people-create">新建</button>`;
    toolbar.querySelectorAll("[data-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        sort = button.dataset.sort;
        void loadPeople();
      });
    });
    toolbar.querySelector("#people-create")?.addEventListener("click", () => void createPerson());
    list.innerHTML = people.map((person) => `
      <button type="button" class="people-row ${person.id === personId ? "active" : ""}" data-id="${escHtml(person.id)}">
        <strong>${escHtml(person.name || "")}</strong>
        <span>${escHtml(person.preview || "空")}</span>
      </button>`).join("") || `<p class="empty-state-copy">还没有人</p>`;
    list.querySelectorAll(".people-row").forEach((button) => {
      button.addEventListener("click", () => void openPerson(button.dataset.id));
    });
  }

  async function createPerson() {
    const name = window.prompt("称呼");
    if (!name || !name.trim()) return;
    const { response, data } = await requestJson("/api/people", jsonRequest("POST", { name: name.trim() }));
    if (!response.ok) {
      actions.showError?.(data.error || "建立失败");
      return;
    }
    await loadPeople();
    if (data.person?.id) await openPerson(data.person.id);
  }

  async function openPerson(id) {
    personId = id;
    pane = "raw";
    const { data } = await requestJson(`/api/people/${id}`);
    detail = data;
    const page = await requestJson(`/api/people/${id}/entries`);
    entries = page.data.entries || [];
    renderList();
    renderStage();
    syncThread();
  }

  function renderStage() {
    const panel = document.getElementById("document-panel");
    if (!panel || state.workspace !== "people") return;
    let stage = document.getElementById("people-stage");
    if (!stage) {
      stage = document.createElement("div");
      stage.id = "people-stage";
      panel.appendChild(stage);
    }
    const name = detail?.person?.name || "";
    const organizedAt = detail?.person?.organizedAt || "";
    const pending = entries.some((entry) => !organizedAt || entry.at > organizedAt);
    if (pane === "digest") {
      stage.innerHTML = `
        <div class="people-panes">
          <button type="button" data-pane="raw">原文</button>
          <button type="button" data-pane="digest" class="active">历史简报</button>
          <button type="button" data-pane="profile">档案</button>
        </div>
        ${pending ? `<p>还有原文没写入历史简报</p>` : ""}
        <article class="people-doc">${escHtml(detail?.digest || "还没有历史简报")}</article>`;
    } else if (pane === "profile") {
      stage.innerHTML = `
        <div class="people-panes">
          <button type="button" data-pane="raw">原文</button>
          <button type="button" data-pane="digest">历史简报</button>
          <button type="button" data-pane="profile" class="active">档案</button>
        </div>
        <textarea id="people-profile">${escHtml(detail?.profile || "")}</textarea>
        <button type="button" id="people-profile-save">保存</button>`;
      stage.querySelector("#people-profile-save")?.addEventListener("click", () => void saveProfile());
    } else {
      stage.innerHTML = `
        <div class="people-panes">
          <strong>${escHtml(name)}</strong>
          <button type="button" data-pane="raw" class="active">原文</button>
          <button type="button" data-pane="digest">历史简报</button>
          <button type="button" data-pane="profile">档案</button>
        </div>
        <div id="people-entries">${renderEntries()}</div>
        <form id="people-composer">
          <label><input id="people-mine" type="checkbox" ${mine ? "checked" : ""} ${note ? "hidden" : ""}> 自己</label>
          <button type="button" id="people-note">${note ? "自述中" : "自述"}</button>
          <textarea id="people-text" rows="2"></textarea>
          <input id="people-images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>
          <button type="submit">发送</button>
        </form>`;
      stage.querySelector("#people-mine")?.addEventListener("change", (event) => { mine = event.target.checked; });
      stage.querySelector("#people-note")?.addEventListener("click", () => { note = !note; renderStage(); });
      stage.querySelector("#people-composer")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void sendEntry();
      });
      stage.querySelector("#people-images")?.addEventListener("change", (event) => {
        void recognizeFiles(event.target.files);
        event.target.value = "";
      });
      stage.querySelector("#people-text")?.addEventListener("paste", (event) => {
        const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        event.preventDefault();
        void recognizeFiles(files);
      });
      bindEntryActions(stage);
    }
    stage.querySelectorAll("[data-pane]").forEach((button) => {
      button.addEventListener("click", () => {
        pane = button.dataset.pane;
        renderStage();
        syncThread();
      });
    });
  }

  function renderEntries() {
    let day = "";
    return entries.map((entry) => {
      const label = dayLabel(entry.at);
      const heading = label === day ? "" : `<p class="people-day">${label}</p>`;
      day = label;
      const who = entry.kind === "note" ? "自述" : entry.speaker === "me" ? "自己" : (detail?.person?.name || "");
      return `${heading}<article class="people-entry ${entry.speaker === "me" ? "mine" : ""}" data-id="${escHtml(entry.id)}">
        <header>${escHtml(who)}</header>
        <p>${escHtml(entry.text || "")}</p>
        <button type="button" data-act="edit">改</button>
        <button type="button" data-act="delete">删除</button>
      </article>`;
    }).join("");
  }

  function bindEntryActions(stage) {
    stage.querySelectorAll(".people-entry").forEach((article) => {
      article.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        const entry = entries.find((item) => item.id === article.dataset.id);
        if (!entry || !state.personThread) return;
        state.personThread.selectedText = entry.text;
        state.personThread.previewPath = `${threadPath()}/entries.jsonl`;
        syncThread();
      });
      article.querySelector("[data-act=edit]")?.addEventListener("click", () => void editEntry(article.dataset.id));
      article.querySelector("[data-act=delete]")?.addEventListener("click", () => void deleteEntry(article.dataset.id));
    });
  }

  async function recognizeFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length || !personId) return;
    if (files.length > 20) {
      actions.showError?.("一次最多 20 张");
      return;
    }
    const text = document.getElementById("people-text")?.value?.trim();
    if (text) await sendEntry();
    const body = new FormData();
    body.set("provider", state.currentProvider);
    body.set("model", state.currentModel);
    for (const file of files) body.append("images", file, file.name);
    const { response, data } = await requestJson(`/api/people/${personId}/recognize`, { method: "POST", body });
    if (!response.ok) {
      actions.showError?.(data.error || "识别失败");
      return;
    }
    const errors = (data.results || []).filter((item) => !item.ok).map((item) => item.error).filter(Boolean);
    if (errors.length) actions.showError?.(errors.join("、"));
    await openPerson(personId);
  }

  async function sendEntry() {
    const text = document.getElementById("people-text")?.value || "";
    if (!text.trim() || !personId) return;
    const body = note ? { kind: "note", text } : { kind: "line", speaker: mine ? "me" : "them", text };
    const { response, data } = await requestJson(`/api/people/${personId}/entries`, jsonRequest("POST", body));
    if (!response.ok) {
      actions.showError?.(data.error || "发送失败");
      return;
    }
    await openPerson(personId);
  }

  async function editEntry(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const text = window.prompt("修改", entry.text);
    if (text == null || !text.trim()) return;
    const { response, data } = await requestJson(`/api/people/${personId}/entries/${id}`, jsonRequest("PATCH", { text }));
    if (!response.ok) actions.showError?.(data.error || "修改失败");
    else await openPerson(personId);
  }

  async function deleteEntry(id) {
    if (!window.confirm("删除这条")) return;
    await requestJson(`/api/people/${personId}/entries/${id}`, jsonRequest("DELETE"));
    await openPerson(personId);
  }

  async function saveProfile() {
    const content = document.getElementById("people-profile")?.value ?? "";
    const { response, data } = await requestJson("/api/documents/content", jsonRequest("PUT", {
      path: `${threadPath()}/profile.md`,
      content,
    }));
    if (!response.ok) actions.showError?.(data.error || "档案标题不完整");
    else await openPerson(personId);
  }

  function setWorkspace(next) {
    state.workspace = next;
    document.body.classList.toggle("people-workspace", next === "people");
    document.getElementById("workspace-docs")?.classList.toggle("active", next === "docs");
    document.getElementById("workspace-people")?.classList.toggle("active", next === "people");
    document.getElementById("people-browser").hidden = next !== "people";
    if (next === "people") void loadPeople();
    else document.getElementById("people-stage")?.remove();
    remount();
  }

  function remount() {
    if (state.workspace !== "people") {
      syncThread();
      return;
    }
    renderStage();
    syncThread();
    const button = document.getElementById("organize-btn");
    if (button && button.dataset.bound !== "1") {
      button.dataset.bound = "1";
      button.addEventListener("click", () => {
        if (!state.personThread?.canOrganize || !state.inputEl) return;
        state.personThread.captureJob = "organize";
        state.inputEl.value = "整理目前新增的内容。";
        actions.sendMessage?.();
      });
    }
  }

  function bind() {
    document.getElementById("workspace-docs")?.addEventListener("click", () => setWorkspace("docs"));
    document.getElementById("workspace-people")?.addEventListener("click", () => setWorkspace("people"));
    state.afterChat = () => {
      if (state.workspace === "people" && personId) void openPerson(personId);
    };
  }

  return { bind, remount };
}

function dayLabel(at) {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "录入";
  const month = String(time.getMonth() + 1).padStart(2, "0");
  const day = String(time.getDate()).padStart(2, "0");
  return `录入 ${time.getFullYear()}-${month}-${day}`;
}
