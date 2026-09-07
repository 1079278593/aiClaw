import { escHtml } from "./format.js";
import { initGitSync } from "./features/git-sync.js";
import { initChatRailResizeHandle, applyExplorerWidth, getChatPanelWidth } from "./features/document-layout.js";
import { openKnowledgeModal } from "./features/knowledge.js";
import { openUsageModal, switchUsageTab, setUsageDays, toggleUsageMetric } from "./features/usage.js";
import { requestJson } from "./api.js";

export function createChatView({ state, documents, pickers, permissions, actions }) {
  let toolbarMenuOutsideClickBound = false;
  let staticModalBindingsBound = false;

  /* ------------------------------------------------------------------ *
   *  Main shell: [document reader] [chat]
   *  The left file explorer (#sidebar) is static in index.html.
   * ------------------------------------------------------------------ */

  function buildChatPanelMarkup() {
    const title = state.sessions.find((session) => session.id === state.currentSessionId)?.title || "";
    const hasSession = Boolean(state.currentSessionId);
    return `
    <section id="document-panel" aria-label="文档阅读区">
      <div id="doc-view-tabs"><div id="doc-tabs"></div></div>
      <div id="doc-preview-toolbar">
        <div id="doc-selection-status">
          <div class="doc-selection-lines"></div>
          <div class="doc-selection-summary"></div>
        </div>
        <div class="doc-toolbar-actions">
          <button id="doc-save-btn" class="doc-tool-btn" type="button" title="保存修改（Ctrl/Cmd+S）" aria-label="保存修改" hidden><i data-lucide="check"></i><span>保存</span></button>
          <button id="doc-edit-btn" class="doc-tool-btn" type="button" title="编辑此文档" aria-label="编辑此文档"><i data-lucide="pencil"></i><span>编辑</span></button>
          <button id="doc-refresh-btn" class="doc-tool-btn" type="button" title="刷新" aria-label="刷新"><i data-lucide="refresh-cw"></i><span>刷新</span></button>
        </div>
      </div>
      <div id="doc-preview-content"></div>
    </section>
    <div id="chat-rail-resize" title="拖拽调整聊天宽度"></div>
    <aside id="chat-panel" aria-label="AI 聊天" style="width:${getChatPanelWidth()}px">
      <div id="chat-header">
        <div id="chat-meta">
          <button id="new-session-btn" type="button" title="新建对话" aria-label="新建对话">
            <i data-lucide="plus"></i><span>新对话</span>
          </button>
          <div id="chat-title" class="${hasSession ? "" : "is-placeholder"}" title="${escHtml(title || "尚未开始对话")}">${escHtml(title || "聊天")}</div>
        </div>
        <div id="chat-toolbar">
          <div id="chat-actions">
            <button class="header-icon-btn" id="chat-home-btn" title="会话列表" aria-label="会话列表" aria-expanded="false"><i data-lucide="history"></i></button>
            <button class="header-icon-btn" id="usage-btn" title="Token 统计" aria-label="Token 统计"><i data-lucide="bar-chart-3"></i></button>
            <button class="header-icon-btn" id="knowledge-btn" title="知识库" aria-label="知识库"><i data-lucide="book-open"></i></button>
            ${state.gitSyncEnabled ? '<button class="header-icon-btn" id="git-sync-btn" title="同步" aria-label="同步"><i data-lucide="git-compare-arrows"></i></button>' : ""}
          </div>
        </div>
      </div>
      <div id="chat-body" class="${hasSession ? "" : "show-home"}">
        <div id="chat-home">
          <div class="chat-home-scroll">
            <div class="chat-home-hero">
              <div class="chat-home-brand"><i data-lucide="message-circle"></i></div>
              <div class="chat-home-title">与 AI 对话</div>
              <div class="chat-home-copy">把左侧文档当作上下文，向 AI 提问、总结或写作</div>
              <div class="chat-home-actions">
                <button id="chat-home-new-btn" type="button" title="新建对话"><i data-lucide="plus"></i><span>新建对话</span></button>
                <button id="chat-home-resume-btn" type="button" title="返回当前对话" hidden><span>返回当前对话</span></button>
              </div>
            </div>
            <div class="chat-home-history">
              <div class="chat-home-history-title">历史会话</div>
              <div id="session-list"><div class="session-list-empty">暂无对话</div></div>
            </div>
          </div>
        </div>
        <div id="chat-content">
          <div id="messages"><div id="empty-state" class="empty-state"><div class="empty-state-icon"><i data-lucide="message-circle"></i></div><p class="empty-state-title">发送消息开始对话</p></div></div>
          <div id="input-area">
            <div id="composer">
              <div id="tool-permission-dialog" role="dialog" aria-modal="true" aria-label="工具权限确认">
                <div id="tool-permission-title"></div><div id="tool-permission-body"></div>
                <div id="tool-permission-actions"><button id="tool-permission-deny">拒绝</button><button id="tool-permission-allow">允许</button></div>
              </div>
              <div id="file-picker-popover" role="listbox" aria-label="选择文件">
                <div id="file-picker-popover-header"><strong>选择文件</strong></div>
                <div id="file-picker-popover-body"><div id="file-picker-empty">无匹配文件</div><div id="file-picker-list"></div></div>
              </div>
              <div id="command-picker-popover" role="listbox" aria-label="选择命令">
                <div id="command-picker-popover-header"><strong>选择命令</strong></div>
                <div id="command-picker-popover-body"><div id="command-picker-empty">无匹配命令</div><div id="command-picker-list"></div></div>
              </div>
              <div id="pending-images"></div>
              <textarea id="message-input" placeholder="输入消息...(Enter 发送，Shift+Enter 换行)" rows="1"></textarea>
              <div id="composer-toolbar">
                <div class="composer-left">
                  <label class="toggle-wrap" id="write-perm-toggle" title="开启后模型可直接写/删文件、搜索网络，无需确认" aria-label="写入权限">
                    <input type="checkbox" id="write-perm-checkbox">
                    <span class="toggle-track"></span>
                  </label>
                  <button id="compact-btn" class="composer-action-btn" title="压缩会话" aria-label="压缩会话" disabled>
                    <i data-lucide="archive"></i>
                  </button>
                  <button id="doc-context-toggle" class="composer-action-btn" type="button" title="${documents.getAttachDocContext() ? "发送时附带当前浏览文件路径与选中文本（点击关闭）" : "已关闭：发送时不附带浏览文件路径与选中文本（点击开启）"}" aria-label="附带浏览文件上下文" aria-pressed="${documents.getAttachDocContext()}">
                    <i data-lucide="${documents.getAttachDocContext() ? "file" : "eye-off"}"></i>
                  </button>
                  <span id="token-display" title="当前上下文长度"></span>
                </div>
                <div class="composer-right">
                  <div class="toolbar-menu-control"><select id="model-select" hidden></select><button id="model-select-trigger" class="toolbar-select" type="button" title="Model" aria-label="Model" aria-haspopup="listbox" aria-expanded="false" aria-controls="model-select-menu"><span class="toolbar-select-value"></span><i data-lucide="chevron-down"></i></button><div id="model-select-menu" class="toolbar-select-menu" role="listbox" aria-label="Model"></div></div>
                  <div class="toolbar-menu-control"><select id="thinking-effort-select" hidden></select><button id="thinking-effort-select-trigger" class="toolbar-select" type="button" title="Thinking" aria-label="Thinking" aria-haspopup="listbox" aria-expanded="false" aria-controls="thinking-effort-select-menu"><span class="toolbar-select-value"></span><i data-lucide="chevron-down"></i></button><div id="thinking-effort-select-menu" class="toolbar-select-menu" role="listbox" aria-label="Thinking"></div></div>
                  <button id="send-btn" title="发送" aria-label="发送" disabled><i data-lucide="arrow-up"></i></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>`;
  }

  function renderChatArea() {
    const main = document.getElementById("main");
    // Save document preview scroll position before DOM rebuild so it can be
    // restored after the new preview panel is rendered.
    documents.saveDocPreviewScrollPosition();
    applyExplorerWidth();
    main.innerHTML = `<div id="main-shell">${buildChatPanelMarkup()}</div>`;

    captureElements();
    bindChatHeaderEvents();
    bindChatHomeEvents();
    actions.bindScrollListener();
    bindComposerEvents();
    documents.initDocView();
    initGitSync();
    syncModelControls();
    pickers.bindComposer();
    permissions.init();
    actions.renderSessionList?.();
    actions.syncCompactButton();
    actions.updateTokenDisplay(state.latestUsage);

    // Trigger lucide icon rendering for dynamically added elements
    window.lucide?.createIcons();
    initChatRailResizeHandle();
  }

  function captureElements() {
    state.messagesEl = document.getElementById("messages");
    state.inputEl = document.getElementById("message-input");
    state.sendBtn = document.getElementById("send-btn");
    state.tokenDisplayEl = document.getElementById("token-display");
    state.compactBtnEl = document.getElementById("compact-btn");
    state.modelSelectEl = document.getElementById("model-select");
    state.thinkingEffortSelectEl = document.getElementById("thinking-effort-select");
    state.pendingImagesEl = document.getElementById("pending-images");
  }

  /* ---- Chat header + chat home (session history overlay) ---- */

  function setChatHomeVisible(visible) {
    const body = document.getElementById("chat-body");
    if (!body) return;
    body.classList.toggle("show-home", visible);
    const btn = document.getElementById("chat-home-btn");
    if (btn) {
      btn.title = visible ? "返回当前对话" : "会话列表";
      btn.setAttribute("aria-label", btn.title);
      btn.setAttribute("aria-expanded", String(visible));
    }
    const resume = document.getElementById("chat-home-resume-btn");
    if (resume) resume.hidden = !state.currentSessionId || !visible;
    const input = state.inputEl;
    if (input) input.disabled = Boolean(visible) && !state.currentSessionId;
    actions.updateSendAvailability?.();
  }

  function toggleChatHome() {
    const body = document.getElementById("chat-body");
    if (!body) return;
    setChatHomeVisible(!body.classList.contains("show-home"));
  }

  function bindChatHomeEvents() {
    const newBtn = document.getElementById("chat-home-new-btn");
    if (newBtn) newBtn.addEventListener("click", () => void actions.createSession());
    const resumeBtn = document.getElementById("chat-home-resume-btn");
    if (resumeBtn) resumeBtn.addEventListener("click", () => setChatHomeVisible(false));
    setChatHomeVisible(!state.currentSessionId);
  }

  function bindChatHeaderEvents() {
    document.getElementById("new-session-btn")?.addEventListener("click", () => void actions.createSession());
    document.getElementById("chat-home-btn")?.addEventListener("click", toggleChatHome);
    document.getElementById("usage-btn")?.addEventListener("click", openUsageModal);
    document.getElementById("knowledge-btn")?.addEventListener("click", openKnowledgeModal);
    bindStaticModalControls();
    // chat-title 双击重命名当前会话
    const title = document.getElementById("chat-title");
    if (title) {
      title.addEventListener("dblclick", () => {
        if (state.currentSessionId) actions.renameSessionById?.(state.currentSessionId);
      });
    }
  }

  function bindStaticModalControls() {
    if (staticModalBindingsBound) return;
    staticModalBindingsBound = true;
    document.querySelectorAll(".usage-tab").forEach((el) => {
      el.addEventListener("click", () => switchUsageTab(el.dataset.tab));
    });
    document.querySelectorAll(".usage-range-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const days = parseInt(el.dataset.days, 10);
        document.querySelectorAll(".usage-range-btn").forEach((b) => b.classList.toggle("active", b === el));
        setUsageDays(days);
      });
    });
    document.querySelectorAll(".usage-metric-toggle").forEach((el) => {
      el.addEventListener("click", () => toggleUsageMetric(el.dataset.metric));
    });
  }

  function bindComposerEvents() {
    if (state.sendBtn) state.sendBtn.addEventListener("click", actions.sendMessage);
    if (state.compactBtnEl) state.compactBtnEl.addEventListener("click", actions.compactCurrentSession);
    const docContextBtn = document.getElementById("doc-context-toggle");
    if (docContextBtn) {
      docContextBtn.addEventListener("click", () => {
        const enabled = documents.toggleAttachDocContext();
        docContextBtn.setAttribute("aria-pressed", String(enabled));
        docContextBtn.innerHTML = `<i data-lucide="${enabled ? "file" : "eye-off"}"></i>`;
        docContextBtn.title = enabled
          ? "发送时附带当前浏览文件路径与选中文本（点击关闭）"
          : "已关闭：发送时不附带浏览文件路径与选中文本（点击开启）";
        window.lucide?.createIcons();
      });
    }
    bindToolbarMenu(state.modelSelectEl, () => {
      const [provider, model] = state.modelSelectEl.value.split("::");
      if (provider) state.currentProvider = provider;
      state.currentModel = model || state.defaultModel;
      syncThinkingEffortSelect();
    });
    bindToolbarMenu(state.thinkingEffortSelectEl, () => {
      state.currentThinkingEffort = state.thinkingEffortSelectEl.value || state.defaultThinkingEffort;
    });
    if (state.inputEl) state.inputEl.addEventListener("keydown", (event) => {
      if (document.getElementById("file-picker-popover")?.classList.contains("open")) return;
      if (document.getElementById("command-picker-popover")?.classList.contains("open")) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        actions.sendMessage();
      }
    });
    if (state.inputEl) {
      state.inputEl.addEventListener("input", () => {
        autoResizeInput();
        actions.updateSendAvailability?.();
      });
    }
    autoResizeInput();
    actions.updateSendAvailability?.();
  }

  function syncModelControls() {
    if (!state.modelSelectEl) return;
    syncModelSelect();
    state.modelSelectEl.value = `${state.currentProvider}::${state.currentModel}`;
    renderToolbarMenu(state.modelSelectEl);
    syncThinkingEffortSelect();
  }

  function syncModelSelect() {
    if (!state.modelSelectEl) return;
    state.modelSelectEl.innerHTML = "";
    const provider = state.currentProvider;
    const fallback = state.currentModel || state.defaultModel;
    let models = getModelsForProvider(provider);
    // 保证当前模型始终在列表中，避免 select 匹配失败导致按钮空白
    if (!models.some((model) => model.id === fallback)) {
      models = [...models, { id: fallback, label: fallback }];
    }
    for (const model of models) {
      const option = document.createElement("option");
      option.value = `${provider}::${model.id}`;
      option.dataset.provider = provider;
      option.textContent = model.label || model.name || model.id;
      state.modelSelectEl.appendChild(option);
    }
  }

  function getModelsForProvider(provider) {
    const models = state.providerConfigs?.[provider]?.models;
    return Array.isArray(models) ? models : [];
  }

  function syncThinkingEffortSelect() {
    if (!state.thinkingEffortSelectEl) return;
    const model = getModelsForProvider(state.currentProvider).find((item) => item.id === state.currentModel);
    const modelThinking = Array.isArray(model?.thinking) ? model.thinking : [];
    const firstNonNone = modelThinking.find((level) => level.id !== "off");
    state.currentThinkingEffort = firstNonNone?.id || "off";
    // 只有配置了 thinkingOff 的模型才提供 off 选项（未配置时选 off 与 API 默认行为无异，不显示避免误导）
    const hasOff = model?.thinkingOff !== undefined;
    const levels = hasOff ? [{ id: "off", label: "off" }, ...modelThinking] : modelThinking;
    state.thinkingEffortSelectEl.innerHTML = "";
    for (const level of levels) {
      const option = document.createElement("option");
      option.value = level.id;
      option.textContent = level.label || level.id;
      state.thinkingEffortSelectEl.appendChild(option);
    }
    state.thinkingEffortSelectEl.value = state.currentThinkingEffort;
    renderToolbarMenu(state.thinkingEffortSelectEl);
  }

  function bindToolbarMenu(selectEl, onChange) {
    if (!selectEl) return;
    const control = selectEl.closest(".toolbar-menu-control");
    const trigger = control?.querySelector(".toolbar-select");
    const menu = control?.querySelector(".toolbar-select-menu");
    if (!control || !trigger || !menu) return;

    trigger.addEventListener("click", () => setToolbarMenuOpen(control, !control.classList.contains("open")));
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setToolbarMenuOpen(control, true, event.key === "ArrowUp");
    });
    menu.addEventListener("click", (event) => {
      const option = event.target.closest(".toolbar-select-option");
      if (!option) return;
      if (selectEl.id === "model-select") {
        // Recent models 可能来自其他 provider，不能依赖 select.value 匹配，
        // 直接更新状态并重建控件
        const [provider, model] = option.dataset.value.split("::");
        if (provider) state.currentProvider = provider;
        state.currentModel = model || state.defaultModel;
        syncModelControls();
        setToolbarMenuOpen(control, false);
        trigger.focus();
        return;
      }
      selectEl.value = option.dataset.value;
      selectEl.dispatchEvent(new Event("change"));
      setToolbarMenuOpen(control, false);
      trigger.focus();
    });
    menu.addEventListener("keydown", (event) => handleToolbarMenuKeydown(event, control));
    selectEl.addEventListener("change", () => {
      renderToolbarMenu(selectEl);
      onChange();
    });

    if (!toolbarMenuOutsideClickBound) {
      document.addEventListener("pointerdown", (event) => {
        if (!event.target.closest(".toolbar-menu-control")) closeToolbarMenus();
      });
      toolbarMenuOutsideClickBound = true;
    }
  }

  function renderToolbarMenu(selectEl) {
    if (selectEl?.id === "model-select") return renderModelToolbarMenu(selectEl);
    const control = selectEl?.closest(".toolbar-menu-control");
    const trigger = control?.querySelector(".toolbar-select");
    const valueEl = trigger?.querySelector(".toolbar-select-value");
    const menu = control?.querySelector(".toolbar-select-menu");
    if (!control || !trigger || !valueEl || !menu) return;

    const selected = selectEl.selectedOptions[0];
    valueEl.textContent = selected?.textContent || "";
    menu.replaceChildren(...Array.from(selectEl.options, (option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "toolbar-select-option";
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.classList.toggle("selected", option.selected);
      item.textContent = option.textContent;
      return item;
    }));
  }

  function renderModelToolbarMenu(selectEl) {
    const control = selectEl?.closest(".toolbar-menu-control");
    const trigger = control?.querySelector(".toolbar-select");
    const valueEl = trigger?.querySelector(".toolbar-select-value");
    const menu = control?.querySelector(".toolbar-select-menu");
    if (!control || !trigger || !valueEl || !menu) return;

    const selected = selectEl.selectedOptions[0];
    valueEl.textContent = selected?.textContent || "";
    trigger.title = selected ? `${selected.dataset.provider || ""} · ${selected.textContent}` : "Model";

    const fragments = [];
    fragments.push(createMenuGroupTitle("提供商"));
    const providers = state.availableProviders.length ? state.availableProviders : [state.defaultProvider];
    const normalized = providers.includes(state.currentProvider) ? providers : [...providers, state.currentProvider];
    for (const provider of normalized) {
      const models = getModelsForProvider(provider);
      const row = document.createElement("div");
      row.className = "toolbar-provider-row";
      const label = document.createElement("span");
      label.textContent = provider;
      const arrow = document.createElement("i");
      arrow.dataset.lucide = "chevron-right";
      arrow.className = "toolbar-provider-arrow";
      row.append(label, arrow);
      row.addEventListener("mouseenter", () => openProviderFlyout(control, row, provider, models));
      row.addEventListener("mouseleave", () => scheduleCloseProviderFlyout(control));
      fragments.push(row);
    }

    const recent = (state.recentModels || [])
      .filter((entry) => !(entry.provider === state.currentProvider && entry.model === state.currentModel))
      .slice(0, 2)
      .reverse();
    if (recent.length) {
      fragments.push(createMenuGroupTitle("最近使用"));
      for (const entry of recent) {
        const modelInfo = getModelsForProvider(entry.provider).find((model) => model.id === entry.model);
        const label = modelInfo?.label || modelInfo?.name || entry.model;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "toolbar-select-option";
        item.dataset.value = `${entry.provider}::${entry.model}`;
        item.dataset.provider = entry.provider;
        item.setAttribute("role", "option");
        item.textContent = label;
        item.title = `${entry.provider} · ${label}`;
        fragments.push(item);
      }
    }

    menu.replaceChildren(...fragments);
    closeProviderFlyout(control);
    window.lucide?.createIcons({ root: control });
  }

  function createMenuGroupTitle(text) {
    const title = document.createElement("div");
    title.className = "toolbar-menu-group-title";
    title.textContent = text;
    return title;
  }

  function getProviderFlyout(control) {
    let flyout = control.querySelector(".toolbar-provider-flyout");
    if (flyout) return flyout;
    flyout = document.createElement("div");
    flyout.className = "toolbar-provider-flyout";
    flyout.setAttribute("role", "listbox");
    flyout.addEventListener("click", (event) => {
      const option = event.target.closest(".toolbar-select-option");
      if (!option) return;
      // 子菜单模型可能属于非当前 provider，select 的 options 里没有对应值，
      // 直接更新状态并重建控件
      const [provider, model] = option.dataset.value.split("::");
      if (provider) state.currentProvider = provider;
      state.currentModel = model || state.defaultModel;
      syncModelControls();
      setToolbarMenuOpen(control, false);
      control.querySelector(".toolbar-select")?.focus();
    });
    flyout.addEventListener("mouseenter", () => cancelCloseProviderFlyout(control));
    flyout.addEventListener("mouseleave", () => scheduleCloseProviderFlyout(control));
    control.appendChild(flyout);
    return flyout;
  }

  function openProviderFlyout(control, row, provider, models) {
    cancelCloseProviderFlyout(control);
    const flyout = getProviderFlyout(control);
    flyout.replaceChildren(...models.map((model) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "toolbar-select-option";
      item.dataset.value = `${provider}::${model.id}`;
      item.dataset.provider = provider;
      item.setAttribute("role", "option");
      item.textContent = model.label || model.name || model.id;
      if (provider === state.currentProvider && model.id === state.currentModel) {
        item.classList.add("selected");
        item.setAttribute("aria-selected", "true");
      }
      return item;
    }));

    const menu = control.querySelector(".toolbar-select-menu");
    const menuRect = menu.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();
    const flyoutWidth = Math.min(190, window.innerWidth - 24);
    // 贴住菜单右边缘（-1 覆盖菜单边框，视觉无缝，同设置按钮 left:100% 效果）
    let left = menuRect.right - controlRect.left - 1;
    if (left + flyoutWidth > window.innerWidth - 8) {
      left = menuRect.left - controlRect.left - flyoutWidth + 1;
    }
    flyout.style.left = `${Math.max(4, left)}px`;
    // 与 hover 行顶部齐平
    flyout.style.top = `${rowRect.top - controlRect.top}px`;
    flyout.style.width = `${flyoutWidth}px`;
    flyout.classList.add("open");
    // 底部越界时上移（flyout 需先显示才能测量高度）。
    // 触发修正时新 top 必然为负（在 control 上方），不能再用 Math.max(4, ...) 钳制，
    // 否则会把 flyout 从上方钳到 control 下方 4px，掉到菜单下面。
    const flyoutRect = flyout.getBoundingClientRect();
    if (flyoutRect.bottom > window.innerHeight - 8) {
      const shift = flyoutRect.bottom - window.innerHeight + 8;
      const newTop = flyoutRect.top - controlRect.top - shift;
      if (newTop < 0) flyout.style.top = `${newTop}px`;
    }
  }

  function scheduleCloseProviderFlyout(control) {
    cancelCloseProviderFlyout(control);
    const timer = window.setTimeout(() => closeProviderFlyout(control), 200);
    control.dataset.flyoutTimer = String(timer);
  }

  function cancelCloseProviderFlyout(control) {
    if (control.dataset.flyoutTimer) {
      window.clearTimeout(Number(control.dataset.flyoutTimer));
      delete control.dataset.flyoutTimer;
    }
  }

  function closeProviderFlyout(control) {
    cancelCloseProviderFlyout(control);
    control.querySelector(".toolbar-provider-flyout")?.classList.remove("open");
  }

  async function refreshRecentModels() {
    try {
      const { data } = await requestJson("/api/app-state");
      if (Array.isArray(data?.recentModels)) {
        state.recentModels = data.recentModels;
        if (state.modelSelectEl) renderToolbarMenu(state.modelSelectEl);
      }
    } catch {
      // 静默失败，不影响主流程
    }
  }

  function setToolbarMenuOpen(control, open, focusLast = false) {
    if (open) {
      document.querySelectorAll(".toolbar-menu-control.open").forEach((openControl) => {
        if (openControl !== control) setToolbarMenuOpen(openControl, false);
      });
    } else {
      closeProviderFlyout(control);
    }
    control.classList.toggle("open", open);
    control.querySelector(".toolbar-select")?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const options = control.querySelectorAll(".toolbar-select-option");
    const selected = control.querySelector(".toolbar-select-option.selected");
    (focusLast ? options[options.length - 1] : selected || options[0])?.focus();
  }

  function closeToolbarMenus() {
    document.querySelectorAll(".toolbar-menu-control.open").forEach((control) => setToolbarMenuOpen(control, false));
  }

  function handleToolbarMenuKeydown(event, control) {
    const options = Array.from(control.querySelectorAll(".toolbar-select-option"));
    const index = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setToolbarMenuOpen(control, false);
      control.querySelector(".toolbar-select")?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    options[(index + direction + options.length) % options.length]?.focus();
  }

  function autoResizeInput() {
    if (!state.inputEl) return;
    state.inputEl.style.height = "auto";
    state.inputEl.style.height = Math.min(state.inputEl.scrollHeight, 160) + "px";
  }

  /* ---- Sidebar / Explorer Collapse Toggle ---- */

  function initSidebarCollapse() {
    const sidebar = document.getElementById("sidebar");
    const btn = document.getElementById("sidebar-collapse-btn");
    if (!sidebar || !btn) return;

    const collapsed = localStorage.getItem("sidebarCollapsed") === "true";
    if (collapsed) {
      sidebar.classList.add("collapsed");
      sidebar.style.removeProperty("width");
    } else {
      applyExplorerWidth();
    }
    updateSidebarCollapseIcon();

    btn.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
      const isCollapsed = sidebar.classList.contains("collapsed");
      localStorage.setItem("sidebarCollapsed", String(isCollapsed));
      if (isCollapsed) sidebar.style.removeProperty("width");
      else applyExplorerWidth();
      updateSidebarCollapseIcon();
      // Re-render lucide icons since we swapped the icon
      window.lucide?.createIcons();
    });
  }

  function updateSidebarCollapseIcon() {
    const sidebar = document.getElementById("sidebar");
    const button = document.getElementById("sidebar-collapse-btn");
    if (!sidebar || !button) return;

    const isCollapsed = sidebar.classList.contains("collapsed");
    const label = isCollapsed ? "展开文件栏" : "收起文件栏";
    button.innerHTML = `<i data-lucide="${isCollapsed ? "panel-left-open" : "panel-left-close"}"></i>`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(!isCollapsed));
  }

  /* ---- Modal Esc handling ---- */

  function initModalEscHandlers() {
    const modals = [
      { id: "usage-modal", close: () => document.getElementById("usage-modal")?.classList.remove("open") },
      { id: "knowledge-modal", close: () => document.getElementById("knowledge-modal")?.classList.remove("open") },
      { id: "help-modal", close: () => document.getElementById("help-modal")?.classList.remove("open") },
      { id: "compact-modal", close: () => document.getElementById("compact-modal")?.classList.remove("open") },
    ];

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      for (const modal of modals) {
        const el = document.getElementById(modal.id);
        if (el?.classList.contains("open")) {
          event.preventDefault();
          modal.close();
          // Focus management: return focus to the element that opened the modal
          return;
        }
      }
    });
  }

  /* ---- Init ---- */

  initSidebarCollapse();
  initModalEscHandlers();

  return {
    autoResizeInput,
    renderChatArea,
    setChatHomeVisible,
    syncModelControls,
    refreshRecentModels,
  };
}
