/**
 * 上下文来源面板：看清楚「每轮必带」的内容各占多少 token，并能手动改。
 *
 * 交互刻意是「编辑 → 确认 → 落盘」三段式，不发即时保存：
 * 这几块内容**下一轮就会生效**，一次失手会直接改变 Agent 的行为，
 * 所以必须有一个明确的确认动作，且能放弃。
 */

import { jsonRequest, requestJson } from "../api.js";
import { escHtml } from "../format.js";

/** 打开时的原始快照：用来判断哪些块被改过、以及「放弃改动」时还原。 */
let snapshot = null;
/** 当前编辑中的内容，key 为 source id。 */
const drafts = new Map();

function formatTokens(value) {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "0";
}

/** 进度条宽度：相对该块上限；无上限时相对合计。 */
function barPercent(tokens, max) {
  if (!max || max <= 0) return 0;
  return Math.min(100, Math.round((tokens / max) * 100));
}

function renderSummary(overview) {
  const el = document.getElementById("context-summary");
  if (!el) return;
  const total = overview.totalTokens || 0;
  const cap = overview.totalMax || 0;
  const pct = cap > 0 ? Math.min(100, Math.round((total / cap) * 100)) : 0;
  const enabled = [];
  if (overview.switches?.injectRootIndex) enabled.push("根索引");
  if (overview.switches?.injectDistillMap) enabled.push("蒸馏地图");
  el.innerHTML = [
    `<div class="context-total">`,
    `<strong>${formatTokens(total)}</strong>`,
    `<span>token / 每轮固定成本</span>`,
    `</div>`,
    `<div class="context-meter" title="已用 ${formatTokens(total)}，上限合计 ${formatTokens(cap)}">`,
    `<span style="width:${pct}%"></span>`,
    `</div>`,
    `<p class="context-hint">`,
    `上限合计 ${formatTokens(cap)} token（各块独立上限之和；不等于模型窗口）。`,
    enabled.length ? `已开启：${escHtml(enabled.join("、"))}。` : "根索引与蒸馏地图当前关闭，未计入成本。",
    `</p>`,
  ].join("");
}

function renderOne(source) {
  // 编辑框用 `editText`（磁盘原文），不要用 `content`（可能是注入形态）。
  const originalText = source.editText ?? source.content;
  const changed = drafts.has(source.id) && drafts.get(source.id) !== originalText;
  const value = drafts.has(source.id) ? drafts.get(source.id) : originalText;
  const percent = barPercent(source.tokens, source.max);

  const badges = [
    source.always
      ? `<span class="context-badge context-badge-always">每轮必带</span>`
      : `<span class="context-badge">按需 / 已关闭</span>`,
    source.overLimit ? `<span class="context-badge context-badge-over">超限会被整块丢弃</span>` : "",
    changed ? `<span class="context-badge context-badge-changed">未保存</span>` : "",
  ].join("");

  const stats = [
    `<span>${formatTokens(source.tokens)} token</span>`,
    source.max ? `<span>/ 上限 ${formatTokens(source.max)}</span>` : "",
    `<span>${formatTokens(source.bytes)} 字节</span>`,
    source.entries !== undefined ? `<span>${source.entries} 条</span>` : "",
  ].filter(Boolean).join("");

  const editor = source.editable
    ? `<textarea data-context-id="${escHtml(source.id)}" spellcheck="false" rows="10">${escHtml(value)}</textarea>`
      + (source.entries !== undefined && source.entries > 0
        // 手改记忆层会重建条目元数据：必须提前说，否则「用过几次」的统计会莫名归零。
        ? `<p class="context-role">注意：手动改这一层会重置它的条目统计（使用次数、置顶、最近使用）。</p>`
        : "")
    : `<p class="context-readonly">${escHtml(source.readonlyReason || "此处不可编辑")}</p>`
      + `<pre class="context-preview">${escHtml(value.slice(0, 1200))}</pre>`;

  return [
    `<section class="context-item${source.overLimit ? " over" : ""}" data-item-id="${escHtml(source.id)}">`,
    `<header class="context-item-head">`,
    `<div>`,
    `<strong>${escHtml(source.label)}</strong>`,
    `<code>${escHtml(source.file)}</code>`,
    `</div>`,
    `<div class="context-item-badges">${badges}</div>`,
    `</header>`,
    `<div class="context-meter small"><span style="width:${percent}%"></span></div>`,
    `<div class="context-item-stats">${stats}</div>`,
    `<p class="context-role">${escHtml(source.role)}</p>`,
    editor,
    `</section>`,
  ].join("");
}

function renderList(overview) {
  const el = document.getElementById("context-list");
  if (!el) return;
  el.innerHTML = overview.sources.map(renderOne).join("");
  el.querySelectorAll("textarea[data-context-id]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      const id = textarea.dataset.contextId;
      const original = snapshot?.sources.find((item) => item.id === id);
      if (!original) return;
      // 与 editText 比较：拿 content 比会让「没改」也显示成未保存。
      const originalText = original.editText ?? original.content;
      if (textarea.value === originalText) drafts.delete(id);
      else drafts.set(id, textarea.value);
      updateDirtyState();
    });
  });
}

/** 有改动才允许点「确认修改」；否则按钮保持禁用，避免空提交。 */
function updateDirtyState() {
  const save = document.getElementById("context-save");
  const status = document.getElementById("context-status");
  const count = drafts.size;
  if (save) save.disabled = count === 0;
  if (status && count === 0) status.textContent = "";
  if (status && count > 0) status.textContent = `${count} 个内容块已修改，点击「确认修改」写入磁盘。`;
}

function render(overview) {
  snapshot = overview;
  const subtitle = document.getElementById("context-panel-subtitle");
  if (subtitle) {
    subtitle.textContent = `共 ${overview.sources.length} 块 · 固定 ${formatTokens(overview.totalTokens)} token/轮`;
  }
  renderSummary(overview);
  renderList(overview);
  updateDirtyState();
  window.lucide?.createIcons();
}

async function load() {
  const status = document.getElementById("context-status");
  const list = document.getElementById("context-list");
  if (status) status.textContent = "正在读取…";
  const { response, data } = await requestJson("/api/context/sources");
  if (!response.ok) {
    if (status) status.textContent = data?.error || "读取失败";
    if (list) list.innerHTML = "";
    return;
  }
  drafts.clear();
  if (status) status.textContent = "";
  render(data);
}

export function initContextSources() {
  const modal = document.getElementById("context-modal");
  if (!modal) return;

  const open = async () => {
    document.getElementById("settings-dropdown")?.classList.remove("open");
    modal.classList.add("open");
    await load();
  };
  const close = () => {
    // 关闭即丢弃草稿：未确认的修改本来就不该留在内存里。
    drafts.clear();
    modal.classList.remove("open");
  };

  document.getElementById("context-settings-btn")?.addEventListener("click", () => { void open(); });
  document.getElementById("context-close-btn")?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.getElementById("context-reload")?.addEventListener("click", async () => {
    drafts.clear();
    await load();
  });

  document.getElementById("context-save")?.addEventListener("click", async () => {
    const button = document.getElementById("context-save");
    const status = document.getElementById("context-status");
    if (!snapshot || drafts.size === 0) return;

    // 二次确认：这是会立刻影响下一次对话的写操作。
    const names = [...drafts.keys()].map((id) => snapshot.sources.find((item) => item.id === id)?.label || id);
    if (!window.confirm(`将写入：${names.join("、")}。\n下一条消息起生效。继续？`)) return;

    if (button) button.disabled = true;
    if (status) status.textContent = "正在保存…";
    try {
      const { response, data } = await requestJson(
        "/api/context/sources",
        jsonRequest("PUT", { updates: [...drafts.entries()].map(([id, content]) => ({ id, content })) }),
      );
      const failed = Array.isArray(data?.failed) ? data.failed : [];
      if (!response.ok) {
        if (status) status.textContent = data?.error || "保存失败";
        // 部分成功也要刷新：已写入的块内容变了，草稿继续留着会误导。
        if (data?.overview) {
          drafts.clear();
          render(data.overview);
        }
        if (failed.length > 0 && status) {
          status.textContent = failed.map((item) => `${item.id}: ${item.error}`).join("；");
        }
        return;
      }
      drafts.clear();
      if (data?.overview) render(data.overview);
      if (status) status.textContent = "已保存。下一条消息起生效。";
    } finally {
      if (button) button.disabled = drafts.size === 0;
    }
  });
}
