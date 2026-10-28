import { requestJson, jsonRequest } from "../api.js";
import { setAccessToken } from "../access-token.js";
import { escHtml } from "../format.js";

let current = null;

function filledLabel(name, configured) {
  return `${name}（${configured ? "已填写" : "未填写"}）`;
}

function field(label, control) {
  return `<label class="account-field"><span>${escHtml(label)}</span>${control}</label>`;
}

function secretInput(id, configured) {
  return `<span class="account-secret"><input id="${id}" type="password" autocomplete="off" placeholder="${configured ? "不修改请留空" : ""}"><button type="button" data-clear-for="${id}">清除</button></span>`;
}

function render(view) {
  const form = document.getElementById("account-form");
  if (!form) return;
  current = view;
  const providerOptions = view.providers.map((provider) => (
    `<option value="${escHtml(provider.id)}"${provider.id === view.defaultProvider ? " selected" : ""}>${escHtml(provider.label)}</option>`
  )).join("");
  const selected = view.providers.find((provider) => provider.id === view.defaultProvider) || view.providers[0];
  const modelOptions = (selected?.models || []).map((model) => (
    `<option value="${escHtml(model.id)}"${model.id === view.defaultModel ? " selected" : ""}>${escHtml(model.label)}</option>`
  )).join("");
  const providers = view.providers.map((provider) => field(
    filledLabel(provider.label, provider.configured),
    secretInput(`account-key-${provider.id}`, provider.configured),
  )).join("");
  form.innerHTML = [
    `<label class="account-field"><span>默认模型服务</span><select id="account-provider">${providerOptions}</select></label>`,
    `<label class="account-field"><span>默认模型</span><select id="account-model">${modelOptions}</select></label>`,
    `<h3>模型密钥</h3>`,
    providers,
    `<h3>Trilium</h3>`,
    field("地址", `<input id="account-trilium-url" type="url" value="${escHtml(view.trilium.baseUrl)}">`),
    field(filledLabel("ETAPI 令牌", view.trilium.configured), secretInput("account-trilium-token", view.trilium.configured)),
    `<h3>网页搜索</h3>`,
    field(filledLabel("Tavily", view.tavily.configured), secretInput("account-tavily-key", view.tavily.configured)),
  ].join("");
  const accountLabel = document.getElementById("account-panel-account");
  if (accountLabel) accountLabel.textContent = view.accountId ? `账号 ${view.accountId}` : "";

  document.getElementById("account-provider")?.addEventListener("change", (event) => {
    const provider = view.providers.find((item) => item.id === event.target.value);
    const model = document.getElementById("account-model");
    if (!provider || !model) return;
    model.innerHTML = provider.models.map((item) => `<option value="${escHtml(item.id)}">${escHtml(item.label)}</option>`).join("");
  });
  form.querySelectorAll("[data-clear-for]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.clearFor);
      if (!input) return;
      input.value = "";
      input.dataset.clear = "1";
      input.placeholder = "保存后清除";
      const label = input.closest(".account-field")?.querySelector("span");
      if (label) label.textContent = label.textContent.replace(/（已填写）$/, "（未填写）");
    });
  });
  form.querySelectorAll("input[type=password]").forEach((input) => {
    input.addEventListener("input", () => { delete input.dataset.clear; });
  });
  const save = document.getElementById("account-save");
  if (save) save.disabled = false;
}

function secretValue(id) {
  const input = document.getElementById(id);
  if (!input) return undefined;
  if (input.dataset.clear === "1") return "";
  const value = input.value.trim();
  return value ? value : undefined;
}

function payload() {
  const providers = {};
  for (const provider of current?.providers || []) {
    const apiKey = secretValue(`account-key-${provider.id}`);
    if (apiKey !== undefined) providers[provider.id] = { apiKey };
  }
  const trilium = { baseUrl: document.getElementById("account-trilium-url")?.value.trim() || "" };
  const token = secretValue("account-trilium-token");
  if (token !== undefined) trilium.token = token;
  const body = {
    defaultProvider: document.getElementById("account-provider")?.value,
    defaultModel: document.getElementById("account-model")?.value,
    providers,
    trilium,
  };
  const tavilyKey = secretValue("account-tavily-key");
  if (tavilyKey !== undefined) body.tavily = { apiKey: tavilyKey };
  return body;
}

export function initAccountSettings() {
  const modal = document.getElementById("account-modal");
  const status = document.getElementById("account-status");
  const open = async () => {
    document.getElementById("settings-dropdown")?.classList.remove("open");
    modal?.classList.add("open");
    if (status) status.textContent = "正在读取…";
    const { response, data } = await requestJson("/api/settings/account");
    if (!response.ok) {
      if (status) status.textContent = data?.error || "读取失败";
      return;
    }
    if (status) status.textContent = "";
    render(data);
    window.lucide?.createIcons();
  };
  const close = () => modal?.classList.remove("open");
  document.getElementById("account-settings-btn")?.addEventListener("click", () => { void open(); });
  document.getElementById("account-close-btn")?.addEventListener("click", close);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.getElementById("account-rotate")?.addEventListener("click", async () => {
    if (!window.confirm("旧访问令牌会立即失效。其他设备需要改用新令牌。继续？")) return;
    const button = document.getElementById("account-rotate");
    if (button) button.disabled = true;
    const { response, data } = await requestJson("/api/account/token/rotate", jsonRequest("POST", {}));
    if (button) button.disabled = false;
    if (!response.ok || typeof data?.token !== "string") {
      if (status) status.textContent = data?.error || "轮换失败";
      return;
    }
    setAccessToken(data.token);
    const result = document.getElementById("account-rotate-result");
    const output = document.getElementById("account-rotate-token");
    if (output) output.value = data.token;
    result?.removeAttribute("hidden");
    if (status) status.textContent = "新令牌已写入本浏览器。请复制保存，其他设备需要改用它。";
  });
  document.getElementById("account-rotate-copy")?.addEventListener("click", async () => {
    const output = document.getElementById("account-rotate-token");
    const value = output?.value || "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (status) status.textContent = "已复制";
    } catch {
      output?.select();
      if (status) status.textContent = "请手动复制上面的令牌";
    }
  });
  document.getElementById("account-save")?.addEventListener("click", async () => {
    const button = document.getElementById("account-save");
    if (button) button.disabled = true;
    if (status) status.textContent = "正在保存…";
    const { response, data } = await requestJson("/api/settings/account", jsonRequest("PUT", payload()));
    if (button) button.disabled = false;
    if (!response.ok) {
      if (status) status.textContent = data?.error || "保存失败";
      return;
    }
    location.reload();
  });
}
