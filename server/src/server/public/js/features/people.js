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
  let analysisSessions = [];
  let analysisId = "";
  /** 自动整理开关的实际取值（`app_state` 优先，否则跟配置默认值，服务端已合并）。 */
  let autoOrganize = true;

  function threadPath() {
    return personId ? `people/${personId}` : "";
  }

  function syncThread() {
    if (state.panel !== "people" || !personId) {
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

  function analysisBar() {
    if (!personId) return "";
    const options = analysisSessions.map((session) =>
      `<option value="${escHtml(session.id)}"${session.id === analysisId ? " selected" : ""}>${escHtml(session.title || "分析")}</option>`).join("");
    const last = detail?.person?.lastOrganize;
    const statusClass = last?.status === "failed" ? " people-organize-status-failed" : "";
    return `<div class="people-sessions">
      <select id="people-session"${options ? "" : " disabled"}>${options}</select>
      <button type="button" id="people-session-new">新分析</button>
      <button type="button" id="people-session-delete">删除这条分析</button>
      <span class="people-auto-organize">
        <label title="发消息后自动更新历史简报和当前判断；不会改档案">
          <input type="checkbox" id="people-auto-organize"${autoOrganize ? " checked" : ""}>
          自动整理
        </label>
        <span id="people-auto-organize-state" class="people-auto-organize-state">${autoOrganize ? "开" : "关"}</span>
        <span id="people-organize-status" class="people-organize-status${statusClass}">${escHtml(organizeStatusText())}</span>
      </span>
    </div>`;
  }

  function bindAnalysisBar(stage) {
    stage.querySelector("#people-session")?.addEventListener("change", (event) => {
      const next = analysisSessions.find((session) => session.id === event.target.value);
      if (!next) return;
      analysisId = next.id;
      actions.openDetachedSession?.(next);
    });
    stage.querySelector("#people-session-new")?.addEventListener("click", () => void createAnalysis());
    stage.querySelector("#people-session-delete")?.addEventListener("click", () => void deleteAnalysis());
    const auto = stage.querySelector("#people-auto-organize");
    auto?.addEventListener("change", () => void setAutoOrganize(auto.checked));
  }

  /** 读一次开关的实际取值（配置默认值已被服务端合并成 autoOrganizeEffective）。 */
  async function loadAutoOrganize() {
    try {
      const { data } = await requestJson("/api/app-state");
      autoOrganize = data?.autoOrganizeEffective ?? data?.autoOrganize ?? true;
    } catch {
      autoOrganize = true;
    }
  }

  /**
   * 上次整理的结局。自动整理在 `chatEnd` 之后才跑，界面不能只看简报有没有变，
   * 得有一行字说明「跑完了 / 跳过了 / 失败了」。
   */
  function organizeStatusText() {
    if (detail?.organizing) return "整理中…";
    const last = detail?.person?.lastOrganize;
    if (!last) return "还没整理过";
    const time = new Date(last.at);
    const clock = Number.isNaN(time.getTime())
      ? ""
      : ` ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    if (last.status === "ok") return `整理于${clock}`;
    if (last.status === "failed") return `上次整理失败${clock}：${last.message || "原因不详"}`;
    return `上次跳过${clock}${last.message ? `：${last.message}` : ""}`;
  }

  async function setAutoOrganize(enabled) {
    const { response, data } = await requestJson(
      "/api/app-state/auto-organize",
      jsonRequest("PUT", { enabled }),
    );
    if (!response.ok) {
      actions.showError?.(data.error || "自动整理开关没有保存");
      await loadAutoOrganize();
      renderStage();
      return;
    }
    autoOrganize = data?.autoOrganizeEffective ?? enabled;
    renderStage();
  }

  async function ensureAnalysis() {
    if (!personId) return;
    const listed = await requestJson(`/api/people/${personId}/sessions`);
    analysisSessions = listed.data.sessions || [];
    if (!analysisSessions.some((session) => session.id === analysisId)) {
      if (!analysisSessions.length) {
        const created = await requestJson(`/api/people/${personId}/sessions`, jsonRequest("POST", {}));
        if (!created.response.ok || !created.data.session) {
          actions.showError?.(created.data.error || "分析会话建立失败");
          return;
        }
        analysisSessions = [created.data.session];
      }
      analysisId = analysisSessions[0].id;
    }
    const current = analysisSessions.find((session) => session.id === analysisId);
    if (current && state.currentSessionId !== current.id) actions.openDetachedSession?.(current);
  }

  async function createAnalysis() {
    if (!personId) return;
    const { response, data } = await requestJson(`/api/people/${personId}/sessions`, jsonRequest("POST", {}));
    if (!response.ok || !data.session) {
      actions.showError?.(data.error || "新建分析失败");
      return;
    }
    analysisId = data.session.id;
    analysisSessions = [data.session, ...analysisSessions.filter((session) => session.id !== data.session.id)];
    actions.openDetachedSession?.(data.session);
    renderStage();
  }

  async function deleteAnalysis() {
    if (!personId || !analysisId) return;
    const { response, data } = await requestJson(`/api/sessions/${analysisId}`, { method: "DELETE" });
    if (!response.ok) {
      actions.showError?.(data.error || "删除失败");
      return;
    }
    analysisId = "";
    await ensureAnalysis();
    renderStage();
  }

  /**
   * 后台整理还在跑时，界面手里是旧数据；隔一会儿再拉一次，拉到了就停。
   *
   * 只更新状态那一行，不整页重绘：原文面板里有正在写的输入框，
   * 每 1.5 秒重建一次会把用户打的字清掉。历史简报面板没有输入，可以重绘。
   */
  let organizePollTimer = 0;

  function paintOrganizeStatus() {
    const span = document.getElementById("people-organize-status");
    if (!span) return;
    const last = detail?.person?.lastOrganize;
    span.textContent = organizeStatusText();
    span.classList.toggle("people-organize-status-failed", last?.status === "failed");
  }

  function pollOrganize(personIdAtStart) {
    clearTimeout(organizePollTimer);
    organizePollTimer = window.setTimeout(async () => {
      if (personId !== personIdAtStart || state.panel !== "people") return;
      try {
        const { data } = await requestJson(`/api/people/${personIdAtStart}`);
        if (personId !== personIdAtStart || state.panel !== "people") return;
        detail = data;
        if (pane === "digest") {
          renderStage();
          syncThread();
        } else {
          paintOrganizeStatus();
        }
        if (data.organizing) pollOrganize(personIdAtStart);
      } catch {
        // 人可能已经切走或被删了：下一轮打开会重新拉。
      }
    }, 1500);
  }

  async function reloadDetail() {
    if (!personId) return;
    const { data } = await requestJson(`/api/people/${personId}`);
    detail = data;
    const page = await requestJson(`/api/people/${personId}/entries`);
    entries = page.data.entries || [];
    await loadAutoOrganize();
    renderStage();
    syncThread();
    // `chatEnd` 一到就拉，此刻后台整理才刚开始，简报与当前判断都是旧的。
    // 显示「整理中」，并过一会儿再拉，直到服务端说跑完了。
    if (data.organizing) pollOrganize(personId);
  }

  /** 只刷新原文列表，不动输入框与正在写的自述。 */
  async function reloadEntries() {
    if (!personId) return;
    const page = await requestJson(`/api/people/${personId}/entries`);
    entries = page.data.entries || [];
    const list = document.getElementById("people-entries");
    if (list) {
      list.innerHTML = renderEntries();
      const stage = document.getElementById("people-stage");
      if (stage) bindEntryActions(stage);
    }
    syncThread();
  }

  async function openPerson(id) {
    if (id !== personId) analysisId = "";
    personId = id;
    pane = "raw";
    const { data } = await requestJson(`/api/people/${id}`);
    detail = data;
    const page = await requestJson(`/api/people/${id}/entries`);
    entries = page.data.entries || [];
    await loadAutoOrganize();
    await ensureAnalysis();
    renderList();
    renderStage();
    syncThread();
    // 切走又切回来时整理可能还在跑：和发完消息一样，先显示「整理中」再重拉。
    if (data.organizing) pollOrganize(id);
  }

  function renderStage() {
    const panel = document.getElementById("document-panel");
    if (!panel || state.panel !== "people") return;
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
        ${analysisBar()}
        ${pending ? `<p>还有原文没写入历史简报</p>` : ""}
        <article class="people-doc">${escHtml(detail?.digest || "还没有历史简报")}</article>`;
    } else if (pane === "profile") {
      stage.innerHTML = `
        <div class="people-panes">
          <button type="button" data-pane="raw">原文</button>
          <button type="button" data-pane="digest">历史简报</button>
          <button type="button" data-pane="profile" class="active">档案</button>
        </div>
        ${analysisBar()}
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
        ${analysisBar()}
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
    bindAnalysisBar(stage);
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

  /**
   * 纯 DOM 表现：左栏面板高亮 + 各面板容器显隐 + 中间区 stage 清理。
   * 只负责「显示哪个」，不加载数据、不动会话。
   */
  function applyPanelChrome(next) {
    state.panel = next;
    document.body.classList.toggle("people-panel", next === "people");
    document.body.classList.toggle("reflections-panel", next === "reflections");
    document.getElementById("panel-docs")?.classList.toggle("active", next === "docs");
    document.getElementById("panel-people")?.classList.toggle("active", next === "people");
    document.getElementById("panel-reflections")?.classList.toggle("active", next === "reflections");
    const peopleBrowser = document.getElementById("people-browser");
    if (peopleBrowser) peopleBrowser.hidden = next !== "people";
    const reflectionsBrowser = document.getElementById("reflections-browser");
    if (reflectionsBrowser) reflectionsBrowser.hidden = next !== "reflections";
    // 「待应用」是心得面板内的覆盖层，离开心得就收起，避免挡住文档树。
    if (next !== "reflections") {
      const pendingPanel = document.getElementById("pending-panel");
      if (pendingPanel) pendingPanel.hidden = true;
    }
    if (next !== "people") document.getElementById("people-stage")?.remove();
    if (next !== "reflections") document.getElementById("reflections-stage")?.remove();
    if (next !== "people" && next !== "reflections") state.reflectionPreview = null;
  }

  function setPanel(next) {
    void (async () => {
      // 从心得离开要先落盘，避免未保存正文丢失
      if (state.panel === "reflections" && next !== "reflections") {
        const ok = actions.prepareLeaveReflections
          ? await actions.prepareLeaveReflections()
          : !actions.canLeaveReflections || actions.canLeaveReflections();
        if (!ok) return;
      }
      if (state.panel === "people" && next !== "people") actions.restoreChatSession?.();
      applyPanelChrome(next);
      if (next === "people") {
        state.reflectionPreview = null;
        void loadPeople().then(() => {
          if (personId) void ensureAnalysis();
        });
      }
      remount();
      actions.reflectionsRemount?.();
    })();
  }

  function remount() {
    if (state.panel !== "people") {
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
    document.getElementById("panel-docs")?.addEventListener("click", () => setPanel("docs"));
    document.getElementById("panel-people")?.addEventListener("click", () => setPanel("people"));
    state.afterChat = () => {
      if (state.panel === "people" && personId) void reloadDetail();
    };
    // 原文在 chatStart 之前就已落盘，气泡一出来就能在原文列表看到。
    state.afterChatStart = () => {
      if (state.panel === "people" && personId) void reloadEntries();
    };
  }

  return { bind, remount, setPanel };
}

function dayLabel(at) {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "录入";
  const month = String(time.getMonth() + 1).padStart(2, "0");
  const day = String(time.getDate()).padStart(2, "0");
  return `录入 ${time.getFullYear()}-${month}-${day}`;
}
