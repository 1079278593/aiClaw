import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

/**
 * 「待应用」提案列表 + 对比 + ✅（plan §4.6 / §10.1）。
 *
 * 它是一个覆盖层，挂在心得面板里：左栏入口显示角标，点开后是列表；
 * 选中一条显示 base/proposed 对比与「应用 / 丢弃」。
 */
export function createPendingFeature({ state, actions }) {
  let items = [];
  let badge = 0;
  let activeId = "";
  let detail = null;
  let busy = false;
  /** 批量应用的结果（plan §12.2）：非空时在详情下方逐条展示。 */
  let batchResult = null;

  function panelEl() {
    return document.getElementById("pending-panel");
  }

  function isOpen() {
    const panel = panelEl();
    return !!panel && !panel.hidden;
  }

  async function load(options = {}) {
    const { data, response } = await requestJson("/api/pending");
    if (!response.ok) {
      if (options.silent !== true) actions.showError?.(data.error || "待应用列表加载失败");
      return;
    }
    items = data.items || [];
    badge = Number(data.badge) || 0;
    renderBadge();
    if (isOpen()) renderList();
  }

  function renderBadge() {
    const target = document.getElementById("pending-badge");
    if (target) {
      target.textContent = badge > 0 ? String(badge) : "";
      target.hidden = badge === 0;
    }
    const entry = document.getElementById("pending-open");
    if (entry) {
      entry.title = badge > 0 ? `待应用 ${badge} 条` : "待应用";
      entry.classList.toggle("has-badge", badge > 0);
    }
  }

  function open() {
    const panel = panelEl();
    if (!panel) return;
    panel.hidden = false;
    void load();
  }

  function close() {
    const panel = panelEl();
    if (!panel) return;
    panel.hidden = true;
    activeId = "";
    detail = null;
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  function renderList() {
    const list = document.getElementById("pending-list");
    if (!list) return;
    if (items.length === 0) {
      list.innerHTML = `<p class="empty-state-copy">没有待应用的改动</p>`;
      renderDetail();
      return;
    }
    list.innerHTML = items.map((item) => `
      <button type="button" class="pending-row${item.id === activeId ? " active" : ""}" data-pending="${escHtml(item.id)}">
        <span class="pending-row-title">${escHtml(item.summary || item.target)}</span>
        <span class="pending-row-meta">${escHtml(item.changeType === "create" ? "新建" : "修改")} · ${escHtml(item.target)}</span>
      </button>`).join("");
    list.querySelectorAll("[data-pending]").forEach((button) => {
      button.addEventListener("click", () => void select(button.dataset.pending || ""));
    });
    if (!activeId && items[0]) void select(items[0].id);
    else renderDetail();
  }

  async function select(id) {
    if (!id) return;
    activeId = id;
    renderList();
    const { data, response } = await requestJson(`/api/pending/${encodeURIComponent(id)}`);
    if (!response.ok) {
      actions.showError?.(data.error || "提案读取失败");
      return;
    }
    if (activeId !== id) return;
    detail = data;
    renderDetail();
  }

  function renderDetail() {
    const host = document.getElementById("pending-detail");
    if (!host) return;
    if (!detail) {
      host.innerHTML = "";
      return;
    }
    const meta = detail.meta || {};
    host.innerHTML = `
      <div class="pending-detail-head">
        <strong>${escHtml(meta.summary || "")}</strong>
        <span class="pending-detail-target">${escHtml(meta.target || "")}</span>
      </div>
      <div class="pending-diff">
        <div class="pending-diff-col">
          <h4>现在</h4>
          <pre>${escHtml(detail.base || "（新建文件）")}</pre>
        </div>
        <div class="pending-diff-col">
          <h4>应用后</h4>
          <pre>${escHtml(detail.proposed || "")}</pre>
        </div>
      </div>
      <div class="pending-actions">
        <button type="button" id="pending-apply" ${busy ? "disabled" : ""}>应用</button>
        <button type="button" id="pending-apply-all" class="secondary" ${busy || items.length === 0 ? "disabled" : ""}>全部应用（${items.length}）</button>
        <button type="button" id="pending-dismiss" ${busy ? "disabled" : ""}>丢弃</button>
      </div>
      ${renderBatchResult()}`;
      host.querySelector("#pending-apply")?.addEventListener("click", () => void apply());
      host.querySelector("#pending-apply-all")?.addEventListener("click", () => void applyAll());
      host.querySelector("#pending-dismiss")?.addEventListener("click", () => void dismiss());
  }

  async function apply() {
    if (!activeId || busy) return;
    busy = true;
    renderDetail();
    try {
      const { data, response } = await requestJson(
        `/api/pending/${encodeURIComponent(activeId)}/apply`,
        jsonRequest("POST", {}),
      );
      if (response.status === 409) {
        actions.showError?.("原文在这期间被改动过，提案已失效。请重新生成。");
      } else if (!response.ok) {
        actions.showError?.(data.error || "应用失败");
      } else if (data.status === "stale") {
        actions.showError?.(data.reason === "ambiguous-basehash"
          ? "原文存在多份同内容副本，无法确定目标，请重新生成或丢弃。"
          : "原文已移动或删除，提案已失效。");
      } else {
        // 索引写失败是非致命的：文件已经写好了，只是索引要等下次校准。
        if (data.indexSynced === false) actions.showError?.("已应用，但索引暂未更新，下次打开心得时会自动修复。");
        actions.afterPendingApplied?.(data.path);
      }
    } finally {
      busy = false;
      activeId = "";
      detail = null;
      await load();
      if (isOpen()) renderList();
    }
  }

  /** 批量结果：每条都显示，冲突/失效必须让用户看见，不能汇总成一个「成功」。 */
  function renderBatchResult() {
    if (!batchResult) return "";
    const rows = batchResult.items.map((item) => {
      const result = item.result || {};
      let label = "未应用";
      let cls = "muted";
      if (result.ok && result.status === "applied") { label = "已应用"; cls = "ok"; }
      else if (result.ok && result.status === "dry-run") { label = "预演"; cls = "muted"; }
      else if (result.error === "conflict") { label = "内容已变，未应用"; cls = "warn"; }
      else if (result.status === "stale") { label = "已失效"; cls = "warn"; }
      else if (result.error) { label = escHtml(result.error); cls = "warn"; }
      return `<li class="pending-batch-row ${cls}">
        <span class="pending-batch-label">${label}</span>
        <span class="pending-batch-target">${escHtml(item.target || item.id)}</span>
      </li>`;
    }).join("");
    return `<div class="pending-batch">
      <p class="pending-batch-head">本次应用 ${batchResult.applied} 条${batchResult.ok ? "" : `，${batchResult.items.length - batchResult.applied} 条需要处理`}</p>
      <ul class="pending-batch-list">${rows}</ul>
    </div>`;
  }

  async function applyAll() {
    if (busy || items.length === 0) return;
    busy = true;
    batchResult = null;
    renderDetail();
    try {
      const { data, response } = await requestJson(
        "/api/pending/apply-all",
        jsonRequest("POST", {}),
      );
      if (!response.ok) {
        actions.showError?.(data.error || "批量应用失败");
        return;
      }
      batchResult = data;
      const appliedPaths = data.items
        .filter((item) => item.result?.ok && item.result.status === "applied")
        .map((item) => item.result.path);
      // 冲突条目留在列表里让用户逐条看，不要静默清空。
      const unresolved = data.items.length - data.applied;
      if (unresolved === 0) {
        activeId = "";
        detail = null;
        actions.afterPendingApplied?.(appliedPaths.at(-1));
      } else {
        actions.showError?.(`${unresolved} 条提案未能应用：原文已改动或已失效，请逐条查看后重新生成或丢弃。`);
      }
    } finally {
      busy = false;
      await load();
      if (isOpen()) renderList();
      if (batchResult) renderDetail();
    }
  }

  async function dismiss() {
    if (!activeId || busy) return;
    busy = true;
    renderDetail();
    try {
      await requestJson(`/api/pending/${encodeURIComponent(activeId)}/dismiss`, jsonRequest("POST", {}));
    } finally {
      busy = false;
      activeId = "";
      detail = null;
      await load();
      if (isOpen()) renderList();
    }
  }

  function bind() {
    document.getElementById("pending-open")?.addEventListener("click", () => toggle());
    document.getElementById("pending-close")?.addEventListener("click", () => close());
    // 一轮对话结束后刷角标：Agent 这一轮可能刚写了新提案。
    const previousAfterChat = state.afterChat;
    state.afterChat = () => {
      previousAfterChat?.();
      void load({ silent: true });
    };
    // 首次进入即拉一次角标；失败静默，不打扰启动。
    void load({ silent: true });
  }

  return { bind, load, open, close, toggle, isOpen, get badge() { return badge; } };
}
