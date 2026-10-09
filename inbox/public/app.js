const TOKEN_KEY = "aiclaw-inbox-token";

const els = {
  authCard: document.getElementById("auth-card"),
  mainCard: document.getElementById("main-card"),
  tokenInput: document.getElementById("token-input"),
  saveTokenBtn: document.getElementById("save-token-btn"),
  authStatus: document.getElementById("auth-status"),
  threadSelect: document.getElementById("thread-select"),
  speakerSelect: document.getElementById("speaker-select"),
  refreshBtn: document.getElementById("refresh-btn"),
  newTitle: document.getElementById("new-title"),
  newKind: document.getElementById("new-kind"),
  newMembers: document.getElementById("new-members"),
  createThreadBtn: document.getElementById("create-thread-btn"),
  textInput: document.getElementById("text-input"),
  sendTextBtn: document.getElementById("send-text-btn"),
  imageInput: document.getElementById("image-input"),
  sendImageBtn: document.getElementById("send-image-btn"),
  mainStatus: document.getElementById("main-status"),
};

/** @type {Array<{id:string,title:string,members:string[],kind:string}>} */
let threads = [];

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setStatus(el, message, kind = "") {
  el.textContent = message || "";
  el.classList.remove("error", "ok");
  if (kind) el.classList.add(kind);
}

async function api(pathname, options = {}) {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.json) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(pathname, {
    ...options,
    headers,
    body: options.json ? JSON.stringify(options.json) : options.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function currentThread() {
  return threads.find((t) => t.id === els.threadSelect.value) || null;
}

function fillSpeakers() {
  const thread = currentThread();
  const members = thread?.members?.length ? thread.members : ["我"];
  els.speakerSelect.innerHTML = members
    .map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`)
    .join("");
  if (members.includes("我")) els.speakerSelect.value = "我";
}

function fillThreads(selectId) {
  els.threadSelect.innerHTML = threads
    .map((t) => {
      const label = t.kind === "group" ? `[群] ${t.title}` : t.title;
      return `<option value="${escapeAttr(t.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  if (selectId && threads.some((t) => t.id === selectId)) {
    els.threadSelect.value = selectId;
  }
  fillSpeakers();
}

async function loadThreads(selectId) {
  const data = await api("/api/threads");
  threads = data.threads || [];
  fillThreads(selectId);
  if (!threads.length) {
    setStatus(els.mainStatus, "还没有会话，请先新建一个。");
  }
}

async function connect() {
  setStatus(els.authStatus, "连接中…");
  await api("/api/health");
  els.authCard.classList.add("hidden");
  els.mainCard.classList.remove("hidden");
  setStatus(els.authStatus, "");
  await loadThreads();
  setStatus(els.mainStatus, "已连接", "ok");
}

els.saveTokenBtn.addEventListener("click", async () => {
  const value = els.tokenInput.value.trim();
  if (!value) {
    setStatus(els.authStatus, "请填写 Token", "error");
    return;
  }
  localStorage.setItem(TOKEN_KEY, value);
  try {
    await connect();
  } catch (err) {
    setStatus(els.authStatus, err.message, "error");
  }
});

els.refreshBtn.addEventListener("click", async () => {
  try {
    await loadThreads(els.threadSelect.value);
    setStatus(els.mainStatus, "已刷新", "ok");
  } catch (err) {
    setStatus(els.mainStatus, err.message, "error");
  }
});

els.threadSelect.addEventListener("change", fillSpeakers);

els.createThreadBtn.addEventListener("click", async () => {
  const title = els.newTitle.value.trim();
  if (!title) {
    setStatus(els.mainStatus, "请填写会话名称", "error");
    return;
  }
  const kind = els.newKind.value;
  const members = els.newMembers.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const data = await api("/api/threads", {
      method: "POST",
      json: { title, kind, members },
    });
    els.newTitle.value = "";
    els.newMembers.value = "";
    await loadThreads(data.thread.id);
    setStatus(els.mainStatus, `已创建会话：${data.thread.id}`, "ok");
  } catch (err) {
    setStatus(els.mainStatus, err.message, "error");
  }
});

els.sendTextBtn.addEventListener("click", async () => {
  const thread = els.threadSelect.value;
  const speaker = els.speakerSelect.value;
  const text = els.textInput.value.trim();
  if (!thread) {
    setStatus(els.mainStatus, "请先选择或创建会话", "error");
    return;
  }
  if (!text) {
    setStatus(els.mainStatus, "正文不能为空", "error");
    return;
  }
  try {
    const data = await api("/api/entries", {
      method: "POST",
      json: { thread, speaker, text },
    });
    els.textInput.value = "";
    setStatus(els.mainStatus, `已保存 ${data.entry.fileName}`, "ok");
  } catch (err) {
    setStatus(els.mainStatus, err.message, "error");
  }
});

els.sendImageBtn.addEventListener("click", async () => {
  const thread = els.threadSelect.value;
  const speaker = els.speakerSelect.value;
  const file = els.imageInput.files?.[0];
  if (!thread) {
    setStatus(els.mainStatus, "请先选择或创建会话", "error");
    return;
  }
  if (!file) {
    setStatus(els.mainStatus, "请先选择图片", "error");
    return;
  }
  const body = new FormData();
  body.set("thread", thread);
  body.set("speaker", speaker);
  body.set("file", file);
  try {
    const data = await api("/api/entries/image", { method: "POST", body });
    els.imageInput.value = "";
    setStatus(els.mainStatus, `已上传 ${data.entry.fileName}`, "ok");
  } catch (err) {
    setStatus(els.mainStatus, err.message, "error");
  }
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

if (getToken()) {
  els.tokenInput.value = getToken();
  connect().catch((err) => {
    els.authCard.classList.remove("hidden");
    els.mainCard.classList.add("hidden");
    setStatus(els.authStatus, err.message, "error");
  });
}
