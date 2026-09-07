/**
 * Config module tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { readFile, writeFile, access, mkdir, rm, copyFile } from "node:fs/promises";
import {
  loadConfig,
  initConfig,
  getConfig,
  getPaths,
  getUserDataDir,
  getAvailableProviders,
  getDefaultProviderCredential,
  resolveModelThinking,
} from "./index.js";
import { setupTestDir, cleanupTestDir } from "../test-utils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

let testDir: string;

describe("config", () => {
  beforeEach(async () => {
    testDir = await setupTestDir("config-test");
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("getUserDataDir reads HYXCLAW_DATA_DIR", () => {
    expect(getUserDataDir()).toBe(testDir);
  });

  it("getPaths returns expected derived paths", () => {
    const paths = getPaths(testDir);
    expect(paths.base).toBe(testDir);
    expect(paths.config).toBe(path.join(testDir, "config.json"));
    expect(paths.conversations).toBe(path.join(testDir, "conversations"));
    expect(paths.commandsFile).toBe(path.join(testDir, "files", "commands.md"));
    expect(paths.appStateFile).toBe(path.join(testDir, "files", "app_state.json"));
  });

  it("initConfig creates minimal saved config and full runtime defaults", async () => {
    const config = await initConfig(testDir);
    const saved = JSON.parse(await readFile(path.join(testDir, "config.json"), "utf-8")) as Record<string, unknown>;

    expect(config.defaultProvider).toBe("deepseek");
    expect(config.defaultModel).toBe("deepseek-v4-flash");
    expect(config.defaultThinkingEffort).toBe("high");
    expect(config.providers.deepseek.models[0].thinking?.map((option) => option.id)).toEqual(["low", "high", "max"]);
    expect(resolveModelThinking(config, "deepseek", "deepseek-v4-flash", "max")).toEqual({
      level: "max",
      params: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    });
    expect(resolveModelThinking(config, "deepseek", "deepseek-v4-flash", "off")).toEqual({
      level: "off",
      params: { thinking: { type: "disabled" } },
    });
    expect(config.providers.zai.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(config.compaction).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEffort: "off",
      keepRecentRounds: 0,
    });
    expect(config.server.port).toBe(3000);
    expect(config.fs.allowedDirs).toEqual(["inputs", "knowledge_base", "files"]);
    expect(config.tools.tavily).toMatchObject({
      baseUrl: "https://api.tavily.com",
      searchDepth: "basic",
      maxResults: 10,
      includeAnswer: false,
      includeRawContent: false,
      includeUsage: false,
      timeoutMs: 30_000,
      maxSearchContentChars: 2000,
      fetchDepth: "basic",
      fetchFormat: "markdown",
      maxFetchedChars: 50_000,
    });
    expect(typeof config.tools.tavily.enabled).toBe("boolean");
    expect(typeof config.tools.tavily.apiKey).toBe("string");
    expect(config.tools.trilium).toMatchObject({
      enabled: false,
      baseUrl: "http://127.0.0.1:8080",
      token: "",
      ancestorNoteId: "",
      timeoutMs: 15_000,
    });

    expect(saved).not.toHaveProperty("server");
    expect(saved).not.toHaveProperty("fs");
    expect(saved).not.toHaveProperty("session");
    expect(saved).toHaveProperty("providers");
    expect(saved).toHaveProperty("defaultThinkingEffort", "high");
    await expect(access(path.join(testDir, "files", "commands.md"))).resolves.toBeUndefined();
    await expect(access(path.join(testDir, "files", "project_operation_manual.md"))).resolves.toBeUndefined();
    await expect(access(path.join(testDir, "files", "prompts", "agent_system_prompt.txt"))).resolves.toBeUndefined();
    await expect(access(path.join(testDir, "files", "prompts", "compaction_prompt.txt"))).resolves.toBeUndefined();
    await expect(access(path.join(testDir, "prompts", "agent_system_prompt.txt"))).rejects.toThrow();
  });

  it("initConfig migrates the legacy system prompt filename", async () => {
    const promptsDir = path.join(testDir, "files", "prompts");
    const legacyPromptPath = path.join(promptsDir, "agentSystemPrompt.txt");
    const promptPath = path.join(promptsDir, "agent_system_prompt.txt");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(legacyPromptPath, "custom prompt\n", "utf-8");

    await initConfig(testDir);

    await expect(readFile(promptPath, "utf-8")).resolves.toBe("custom prompt\n");
    await expect(access(legacyPromptPath)).rejects.toThrow();
  });

  it("initConfig synchronizes missing template files without overwriting existing ones", async () => {
    await initConfig(testDir);
    const gitignorePath = path.join(testDir, ".gitignore");
    const gitattributesPath = path.join(testDir, ".gitattributes");
    const commandsPath = path.join(testDir, "files", "commands.md");
    const templateGitignore = await readFile(path.join(process.cwd(), "templates", ".gitignore"), "utf-8");
    const templateGitattributes = await readFile(path.join(process.cwd(), "templates", ".gitattributes"), "utf-8");
    const templateCommands = await readFile(path.join(process.cwd(), "templates", "files", "commands.md"), "utf-8");

    await rm(gitignorePath);
    await rm(gitattributesPath);
    await rm(commandsPath);
    await initConfig(testDir);
    await expect(readFile(gitignorePath, "utf-8")).resolves.toBe(templateGitignore);
    await expect(readFile(gitattributesPath, "utf-8")).resolves.toBe(templateGitattributes);
    await expect(readFile(commandsPath, "utf-8")).resolves.toBe(templateCommands);

    await writeFile(commandsPath, "custom-command\n", "utf-8");
    await writeFile(gitattributesPath, "* text=auto\n", "utf-8");
    await initConfig(testDir);
    await expect(readFile(commandsPath, "utf-8")).resolves.toBe("custom-command\n");
    await expect(readFile(gitattributesPath, "utf-8")).resolves.toBe("* text=auto\n");
  });

  it("initConfig skips 'always' files when content is identical", async () => {
    await initConfig(testDir);

    const copyMock = vi.mocked(copyFile);
    copyMock.mockClear();

    await initConfig(testDir);
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("initConfig overwrites 'always' files when template content changed", async () => {
    await initConfig(testDir);
    const manualPath = path.join(testDir, "files", "project_operation_manual.md");
    await writeFile(manualPath, "custom manual\n", "utf-8");

    await initConfig(testDir);

    const templateManual = await readFile(
      path.join(process.cwd(), "templates", "files", "project_operation_manual.md"),
      "utf-8",
    );
    await expect(readFile(manualPath, "utf-8")).resolves.toBe(templateManual);
  });

  it("loadConfig merges user config with code defaults", async () => {
    await writeFile(path.join(testDir, "config.json"), JSON.stringify({
      providers: {
        zai: {
          apiKey: "zai-key",
          models: [{ id: "GLM-4.5-Air", label: "GLM-4.5-Air" }, { id: "GLM-4.7", label: "GLM-4.7" }],
        },
      },
      defaultProvider: "zai",
      defaultModel: "GLM-4.7",
      defaultThinkingEffort: "medium",
      server: {
        port: 4000,
      },
      fs: {
        allowedDirs: ["inputs", "files"],
        allowedFiles: ["memory.md", "notes.md"],
      },
      tools: {
        tavily: {
          enabled: true,
          apiKey: "tvly-key",
          maxResults: 7,
          maxSearchContentChars: 3000,
        },
      },
    }, null, 2), "utf-8");

    const config = await loadConfig(testDir);
    expect(config.providers.zai.apiKey).toBe("zai-key");
    expect(config.providers.dashscope.models.length).toBeGreaterThan(0);
    expect(config.providers.deepseek.models.length).toBeGreaterThan(0);
    expect(config.defaultThinkingEffort).toBe("medium");
    expect(config.server.port).toBe(4000);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.fs.allowedDirs).toEqual(["inputs", "files"]);
    expect(config.fs.allowedFiles).toEqual(["memory.md", "notes.md"]);
    expect(config.tools.tavily.enabled).toBe(true);
    expect(config.tools.tavily.apiKey).toBe("tvly-key");
    expect(config.tools.tavily.maxResults).toBe(7);
    expect(config.tools.tavily.maxSearchContentChars).toBe(3000);
    expect(config.tools.tavily.fetchFormat).toBe("markdown");
    expect(config.providers.dashscope.models.some((model) => model.modal === "vl")).toBe(true);
  });

  it("loadConfig rejects legacy format", async () => {
    await writeFile(path.join(testDir, "config.json"), JSON.stringify({
      agent: { provider: "zai", model: "glm-5", apiKey: "legacy" },
    }, null, 2), "utf-8");

    await expect(loadConfig(testDir)).rejects.toThrow("Legacy config format detected");
  });

  it("loadConfig rejects when defaultModel does not belong to defaultProvider", async () => {
    await writeFile(path.join(testDir, "config.json"), JSON.stringify({
      providers: {
        zai: {
          apiKey: "zai-key",
          models: [{ id: "GLM-4.5-Air", label: "GLM-4.5-Air" }],
        },
      },
      defaultProvider: "zai",
      defaultModel: "qwen3.6-plus",
    }, null, 2), "utf-8");

    await expect(loadConfig(testDir)).rejects.toThrow("Config validation failed");
  });

  it("rejects configuring the system-provided none thinking option", async () => {
    await writeFile(path.join(testDir, "config.json"), JSON.stringify({
      providers: {
        zai: {
          apiKey: "zai-key",
          models: [{ id: "GLM-4.7", label: "GLM-4.7", thinking: [{ id: "off", params: {} }] }],
        },
      },
      defaultProvider: "zai",
      defaultModel: "GLM-4.7",
    }, null, 2), "utf-8");

    await expect(loadConfig(testDir)).rejects.toThrow("'none' is added by the system");
  });

  it("getAvailableProviders only returns configured apiKey providers", async () => {
    await writeFile(path.join(testDir, "config.json"), JSON.stringify({
      providers: {
        zai: {
          apiKey: "zai-key",
          models: [{ id: "GLM-4.7", label: "GLM-4.7" }],
        },
        dashscope: {
          apiKey: "",
          models: [{ id: "qwen3.6-plus", label: "qwen3.6-plus" }],
        },
        deepseek: {
          apiKey: "",
          models: [{ id: "deepseek-v4-flash", label: "v4-flash" }],
        },
      },
      defaultProvider: "zai",
      defaultModel: "GLM-4.7",
    }, null, 2), "utf-8");

    const config = await loadConfig(testDir);
    expect(getAvailableProviders(config)).toEqual(["zai"]);
    expect(getDefaultProviderCredential(config).apiKey).toBe("zai-key");
  });

  it("getConfig initializes config on first load", async () => {
    const config = await getConfig(testDir);
    expect(config.defaultProvider).toBe("deepseek");
    expect(config.defaultThinkingEffort).toBe("high");
  });
});
