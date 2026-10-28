import { afterEach, describe, expect, it } from "vitest";
import { initConfig } from "./index.js";
import { cleanupTestDir, setupTestDir } from "../test-utils.js";
import { readAccountSettings, updateAccountSettings } from "./account-settings.js";
import { TRILIUM_TOKEN_PLACEHOLDER } from "../trilium/paths.js";

describe("account settings", () => {
  let testDir = "";

  afterEach(async () => {
    if (testDir) await cleanupTestDir(testDir);
  });

  it("stores secrets in config and returns only whether they are set", async () => {
    testDir = await setupTestDir("account-settings");
    await initConfig(testDir);
    const fresh = await readAccountSettings(testDir);
    expect(fresh.trilium.configured).toBe(false);
    expect(fresh.trilium.baseUrl).not.toContain(TRILIUM_TOKEN_PLACEHOLDER);

    const secret = "sk-test-secret";
    const saved = await updateAccountSettings({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      providers: { deepseek: { apiKey: secret }, dashscope: { apiKey: "qwen-secret" } },
      trilium: { baseUrl: "https://trilium.example.com", token: "etapi-secret" },
      tavily: { apiKey: "tvly-secret" },
    }, testDir);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(saved.providers.find((item) => item.id === "deepseek")?.configured).toBe(true);
    expect(saved.providers.find((item) => item.id === "dashscope")?.configured).toBe(true);
    expect(saved.providers.find((item) => item.id === "zai")?.configured).toBe(false);
    expect(saved.trilium).toEqual({ configured: true, baseUrl: "https://trilium.example.com" });
    expect(saved.tavily.configured).toBe(true);

    const kept = await updateAccountSettings({
      defaultProvider: "dashscope",
      defaultModel: saved.providers.find((item) => item.id === "dashscope")?.models[0]?.id,
    }, testDir);
    expect(kept.defaultProvider).toBe("dashscope");
    expect(kept.providers.find((item) => item.id === "deepseek")?.configured).toBe(true);

    const cleared = await updateAccountSettings({
      trilium: { token: "" },
      tavily: { apiKey: "" },
    }, testDir);
    expect(cleared.trilium.configured).toBe(false);
    expect(cleared.tavily.configured).toBe(false);
  });

  it("rejects a default provider that has no key", async () => {
    testDir = await setupTestDir("account-settings-reject");
    await initConfig(testDir);
    await expect(updateAccountSettings({
      defaultProvider: "zai",
      defaultModel: "glm-5.3",
    }, testDir)).rejects.toThrow(/智谱/);
  });
});