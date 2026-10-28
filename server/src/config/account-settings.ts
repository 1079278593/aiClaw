/**
 * Per-tenant service settings. Secrets are written to that tenant's config.json
 * and are never included in the response.
 */

import { readFile, writeFile } from "node:fs/promises";
import { loadConfigWithoutApiKey, type Config } from "./index.js";
import { getPaths, getUserDataDir } from "./paths.js";
import { SUPPORTED_PROVIDERS, type ProviderName } from "./schema.js";
import { isStoredSecret } from "../trilium/paths.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  deepseek: "DeepSeek",
  dashscope: "千问",
  zai: "智谱",
  commandcode: "Command Code",
};

export type AccountSettingsView = {
  providers: Array<{
    id: ProviderName;
    label: string;
    configured: boolean;
    models: Array<{ id: string; label: string }>;
  }>;
  defaultProvider: ProviderName;
  defaultModel: string;
  trilium: { configured: boolean; baseUrl: string };
  tavily: { configured: boolean };
};

type SecretPatch = { apiKey?: string };
type AccountSettingsPatch = {
  defaultProvider?: string;
  defaultModel?: string;
  providers?: Partial<Record<ProviderName, SecretPatch>>;
  trilium?: { baseUrl?: string; token?: string };
  tavily?: SecretPatch;
};

export function accountSettingsView(config: Config): AccountSettingsView {
  return {
    providers: SUPPORTED_PROVIDERS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
      configured: isStoredSecret(config.providers[id]?.apiKey),
      models: (config.providers[id]?.models ?? []).map((model) => ({ id: model.id, label: model.label })),
    })),
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    trilium: {
      configured: isStoredSecret(config.tools.trilium.token),
      baseUrl: config.tools.trilium.baseUrl,
    },
    tavily: { configured: isStoredSecret(config.tools.tavily.apiKey) },
  };
}

export async function readAccountSettings(userDataDir = getUserDataDir()): Promise<AccountSettingsView> {
  return accountSettingsView(await loadConfigWithoutApiKey(userDataDir));
}

export async function updateAccountSettings(patch: unknown, userDataDir = getUserDataDir()): Promise<AccountSettingsView> {
  const update = parsePatch(patch);
  const config = await loadConfigWithoutApiKey(userDataDir);
  applyPatch(config, update);
  const paths = getPaths(userDataDir);
  const previous = await readFile(paths.config, "utf-8");
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  try {
    return accountSettingsView(await loadConfigWithoutApiKey(userDataDir));
  } catch (error) {
    await writeFile(paths.config, previous, "utf-8");
    throw error;
  }
}

function parsePatch(patch: unknown): AccountSettingsPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("无效的请求");
  }
  return patch as AccountSettingsPatch;
}

function applyPatch(config: Config, patch: AccountSettingsPatch): void {
  if (patch.providers) {
    for (const id of Object.keys(patch.providers)) {
      if (!SUPPORTED_PROVIDERS.includes(id as ProviderName)) throw new Error(`不支持的模型服务：${id}`);
      const apiKey = patch.providers[id as ProviderName]?.apiKey;
      if (typeof apiKey !== "string") continue;
      config.providers[id as ProviderName].apiKey = apiKey.trim();
    }
  }
  if (typeof patch.trilium?.baseUrl === "string") {
    const baseUrl = patch.trilium.baseUrl.trim();
    if (!baseUrl) throw new Error("请填写 Trilium 地址");
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      throw new Error("Trilium 地址需要是 http 或 https");
    }
    config.tools.trilium.baseUrl = baseUrl;
  }
  if (typeof patch.trilium?.token === "string") {
    const token = patch.trilium.token.trim();
    config.tools.trilium.token = isStoredSecret(token) ? token : "";
  }
  config.tools.trilium.enabled = isStoredSecret(config.tools.trilium.token);

  if (typeof patch.tavily?.apiKey === "string") {
    config.tools.tavily.apiKey = patch.tavily.apiKey.trim();
  }
  config.tools.tavily.enabled = isStoredSecret(config.tools.tavily.apiKey);

  if (typeof patch.defaultProvider === "string") {
    if (!SUPPORTED_PROVIDERS.includes(patch.defaultProvider as ProviderName)) {
      throw new Error("请选择模型服务");
    }
    config.defaultProvider = patch.defaultProvider as ProviderName;
  }
  if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
    config.defaultModel = patch.defaultModel.trim();
  }
  const models = config.providers[config.defaultProvider]?.models ?? [];
  if (!models.some((model) => model.id === config.defaultModel)) {
    throw new Error("默认模型不属于所选的模型服务");
  }
  if (!isStoredSecret(config.providers[config.defaultProvider]?.apiKey)) {
    throw new Error(`请先填写${PROVIDER_LABELS[config.defaultProvider]}的密钥`);
  }
}
