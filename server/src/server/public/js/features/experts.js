/**
 * 领域（专家）勾选。
 *
 * 三条交互规则来自 plan_experts §4，都不能靠「看起来对」实现：
 * 1. **切换后立刻保存**。保存失败就把界面退回上一次成功的名单并提示，不能
 *    只改内存——刷新或换端之后服务端就不知道该带哪一套。
 * 2. **发送用已保存的名单**。保存与发送几乎同时发生时，先等保存完成再发，
 *    否则会出现「界面已是理财、发出去的仍是情感」。
 * 3. **生成中的那一轮不改**。它的系统提示已经装好，取消或改勾从下一条消息起
 *    生效；已生成的回复也不改写。
 *
 * 名单以服务端会话上的 `experts` 为准，不写死在界面里。
 */

import { requestJson, jsonRequest } from "../api.js";
import { escHtml } from "../format.js";

const MAX_EXPERTS = 2;

export function createExpertsFeature({ state, actions }) {
  /** 正在进行中的保存。发送前要 await 它，避免「先发后存」。 */
  let saving = null;
  /** 上一次成功的名单，保存失败时退回。 */
  let lastSaved = [];

  function currentIds() {
    const session = state.sessions.find((item) => item.id === state.currentSessionId);
    return Array.isArray(session?.experts) ? session.experts.slice(0, MAX_EXPERTS) : [];
  }

  /** 面板上的勾选按钮与角标要跟着会话走。 */
  function syncTrigger() {
    const ids = currentIds();
    const btn = document.getElementById("experts-btn");
    if (btn) {
      btn.disabled = !state.currentSessionId;
      btn.classList.toggle("has-experts", ids.length > 0);
      btn.title = ids.length ? `领域：${ids.join("、")}` : "领域";
      btn.setAttribute("aria-label", ids.length ? `领域：${ids.join("、")}` : "领域");
    }
    const badge = document.getElementById("experts-badge");
    if (badge) {
      badge.textContent = ids.join("、");
      badge.hidden = ids.length === 0;
    }
    lastSaved = ids;
  }

  function setStatus(text, isError = false) {
    const el = document.getElementById("experts-status");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    el.classList.toggle("is-error", isError);
  }

  function renderList(domains) {
    const list = document.getElementById("experts-list");
    const empty = document.getElementById("experts-empty");
    if (!list) return;
    if (!domains.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    const picked = new Set(currentIds());
    list.innerHTML = domains.map((domain) => {
      const checked = picked.has(domain.id);
      return `
        <label class="experts-item${checked ? " is-picked" : ""}">
          <input type="checkbox" data-expert-id="${escHtml(domain.id)}"${checked ? " checked" : ""}>
          <span class="experts-item-name">${escHtml(domain.id)}</span>
          ${domain.hasIndex ? "" : '<span class="experts-item-note">没有目录</span>'}
        </label>`;
    }).join("");
    list.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => toggle(input.dataset.expertId, input));
    });
  }

  async function loadDomains() {
    const { response, data } = await requestJson("/api/experts");
    if (!response.ok) throw new Error(data?.error || "加载领域失败");
    return Array.isArray(data.experts) ? data.experts : [];
  }

  async function open() {
    const modal = document.getElementById("experts-modal");
    if (!modal) return;
    setStatus("");
    modal.classList.add("open");
    try {
      renderList(await loadDomains());
    } catch (error) {
      setStatus(error?.message || "加载领域失败", true);
    }
  }

  function close() {
    document.getElementById("experts-modal")?.classList.remove("open");
  }

  /**
   * 改一个领域的勾选状态。
   *
   * 已勾 2 个再点第三个：直接拒绝，不自动换掉其中一个。要换先取消再勾。
   */
  async function toggle(id, input) {
    if (!id || !state.currentSessionId) return;
    if (state.isStreaming) {
      // 生成中的那一轮系统提示已装好，改勾只从下一条消息起生效。
      setStatus("正在生成，这一轮的领域不变；下一条消息起生效。");
      if (input) input.checked = !input.checked;
      return;
    }
    const previous = currentIds();
    let next;
    if (previous.includes(id)) next = previous.filter((item) => item !== id);
    else {
      if (previous.length >= MAX_EXPERTS) {
        setStatus(`最多勾 ${MAX_EXPERTS} 个。要换请先取消一个。`, true);
        if (input) input.checked = false;
        return;
      }
      next = [...previous, id];
    }
    await save(next, previous, input);
  }

  /** 保存成功才改界面；失败退回上一次成功的名单。 */
  async function save(next, previous, input) {
    const sessionId = state.currentSessionId;
    setStatus("");
    saving = (async () => {
      const { response, data } = await requestJson(
        `/api/sessions/${sessionId}`,
        jsonRequest("PATCH", { experts: next }),
      );
      if (!response.ok) throw new Error(data?.error || "保存失败");
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session) session.experts = next.length ? next : undefined;
      return true;
    })();
    try {
      await saving;
      syncTrigger();
      // 重画：勾满时其它项还能点（点了会被拒），这里只更新选中样式。
      document.querySelectorAll("#experts-list .experts-item").forEach((item) => {
        const box = item.querySelector('input[type="checkbox"]');
        item.classList.toggle("is-picked", Boolean(box?.checked));
      });
    } catch (error) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session) session.experts = previous.length ? previous : undefined;
      if (input) input.checked = previous.includes(input.dataset.expertId);
      setStatus(`${error?.message || "保存失败"}（已退回上一次的勾选）`, true);
      syncTrigger();
    } finally {
      saving = null;
    }
  }

  /**
   * 发送前等保存完成。
   *
   * 勾选与发送几乎同时发生时，必须先落盘再装配消息，否则界面和请求会对不上。
   * 没有在保存时同步返回 `undefined`，调用方据此走原来的同步路径。
   */
  function flushBeforeSend() {
    if (!saving) return undefined;
    return saving.catch(() => undefined);
  }

  async function create() {
    const input = document.getElementById("experts-create-input");
    const button = document.getElementById("experts-create-btn");
    const id = input?.value.trim() ?? "";
    if (!id) {
      setStatus("先填领域名", true);
      return;
    }
    if (button) button.disabled = true;
    setStatus("");
    try {
      const { response, data } = await requestJson("/api/experts", jsonRequest("POST", { id }));
      if (!response.ok) throw new Error(data?.error || "新建失败");
      if (input) input.value = "";
      setStatus(`已建好「${id}」。规则和目录在文档浏览器里改。`);
      renderList(await loadDomains());
    } catch (error) {
      setStatus(error?.message || "新建失败", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bind() {
    document.getElementById("experts-btn")?.addEventListener("click", open);
    document.getElementById("experts-close-btn")?.addEventListener("click", close);
    document.getElementById("experts-create-btn")?.addEventListener("click", create);
    document.getElementById("experts-create-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        create();
      }
    });
    // 点遮罩关闭：与其它弹层一致。
    document.getElementById("experts-modal")?.addEventListener("click", (event) => {
      if (event.target.id === "experts-modal") close();
    });
    syncTrigger();
  }

  return { bind, openExperts: open, closeExperts: close, syncTrigger, flushExpertsBeforeSend: flushBeforeSend };
}
