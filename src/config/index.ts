/**
 * Config loading and management
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger/index.js";
import { ConfigError } from "../errors/index.js";
import {
  getPaths,
  ensureDirectories,
  pathExists,
} from "./paths.js";
import { resolveStrategy } from "./init-strategies.js";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_FS_CONFIG,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  SUPPORTED_PROVIDERS,
  type Config,
  type ProviderName,
  type ProviderCredential,
  type ThinkingEffort,
  type ThinkingParams,
} from "./schema.js";

// templates/ is at the project root, two levels up from dist/config/
const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates",
);

async function migrateLegacySystemPrompt(paths: ReturnType<typeof getPaths>): Promise<void> {
  const legacyPath = path.join(paths.files, "prompts", "agentSystemPrompt.txt");
  if (await pathExists(paths.agentSystemPromptFile) || !(await pathExists(legacyPath))) return;

  await fs.rename(legacyPath, paths.agentSystemPromptFile);
  logger.info("Migrated legacy system prompt filename.");
}

// ---- installed templates tracking ----

async function loadInstalledTemplates(installedPath: string): Promise<Set<string>> {
  try {
    const content = await fs.readFile(installedPath, "utf-8");
    const list = JSON.parse(content);
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

async function saveInstalledTemplates(installedPath: string, installed: Set<string>): Promise<void> {
  const sorted = [...installed].sort();
  await fs.writeFile(installedPath, JSON.stringify(sorted, null, 2), "utf-8");
}

// ---- deep merge for merge strategy ----

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceVal] of Object.entries(source)) {
    if (key in result && isPlainObject(result[key]) && isPlainObject(sourceVal)) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else if (!(key in result)) {
      result[key] = sourceVal;
    }
    // else: user value wins, keep existing
  }
  return result;
}

// ---- template sync ----

async function copyTemplates(paths: ReturnType<typeof getPaths>): Promise<void> {
  const installed = await loadInstalledTemplates(paths.installedTemplatesFile);
  let installedChanged = false;

  const stack = [TEMPLATES_DIR];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(current, entry.name);
      const relPath = path.relative(TEMPLATES_DIR, srcPath).replace(/\\/g, "/");
      const destPath = path.join(paths.base, relPath);
      if (entry.isDirectory()) {
        stack.push(srcPath);
        continue;
      }

      const strategy = resolveStrategy(relPath);
      const destExists = await pathExists(destPath);

      switch (strategy.strategy) {
        case "always": {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          if (destExists) {
            const [templateBuf, destBuf] = await Promise.all([
              fs.readFile(srcPath),
              fs.readFile(destPath),
            ]);
            if (templateBuf.equals(destBuf)) {
              logger.info(`[always] Up to date, skip: ${relPath}`);
              break;
            }
          }
          await fs.copyFile(srcPath, destPath);
          logger.info(`[always] Updated: ${relPath}`);
          break;
        }

        case "merge": {
          if (destExists) {
            const [templateRaw, userRaw] = await Promise.all([
              fs.readFile(srcPath, "utf-8"),
              fs.readFile(destPath, "utf-8"),
            ]);
            const templateJson = JSON.parse(templateRaw) as Record<string, unknown>;
            const userJson = JSON.parse(userRaw) as Record<string, unknown>;
            const merged = deepMerge(userJson, templateJson);
            await fs.writeFile(destPath, JSON.stringify(merged, null, 2), "utf-8");
            logger.info(`[merge] Merged new keys into: ${relPath}`);
          } else {
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(srcPath, destPath);
          }
          break;
        }

        case "once": {
          if (strategy.trackInstalled) {
            // Tracked once: skip if ever installed before
            if (installed.has(relPath)) break;
            if (destExists) {
              // Already on disk, just record and skip
              installed.add(relPath);
              installedChanged = true;
              break;
            }
            // First install
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(srcPath, destPath);
            installed.add(relPath);
            installedChanged = true;
            logger.info(`[once+track] Installed: ${relPath}`);
          } else {
            // Untracked once: copy only if missing
            if (destExists) break;
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(srcPath, destPath);
          }
          break;
        }
      }
    }
  }

  if (installedChanged) {
    await saveInstalledTemplates(paths.installedTemplatesFile, installed);
  }
}

function assertNoLegacyFields(userConfig: Record<string, unknown>) {
  if ("agent" in userConfig) {
    throw new ConfigError(
      "Legacy config format detected. Please update config.json to the current structure.",
      { code: "config_legacy_format" },
    );
  }
}

function mergeProviderConfig(provider: ProviderName, userConfig: Partial<Config>): Config["providers"][ProviderName] {
  return {
    apiKey: userConfig.providers?.[provider]?.apiKey ?? DEFAULT_CONFIG.providers[provider].apiKey,
    baseUrl: userConfig.providers?.[provider]?.baseUrl ?? DEFAULT_CONFIG.providers[provider].baseUrl,
    models: userConfig.providers?.[provider]?.models ?? DEFAULT_CONFIG.providers[provider].models,
  };
}

function mergeWithDefaults(userConfig: Partial<Config>): Config {
  return {
    providers: {
      zai: mergeProviderConfig("zai", userConfig),
      dashscope: mergeProviderConfig("dashscope", userConfig),
      deepseek: mergeProviderConfig("deepseek", userConfig),
    },
    defaultProvider: userConfig.defaultProvider ?? DEFAULT_CONFIG.defaultProvider,
    defaultModel: userConfig.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    defaultThinkingEffort: userConfig.defaultThinkingEffort ?? DEFAULT_CONFIG.defaultThinkingEffort,
    maxTokens: userConfig.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    contextMaxTokens: userConfig.contextMaxTokens ?? DEFAULT_CONFIG.contextMaxTokens,
    contextMaxMessages: userConfig.contextMaxMessages ?? DEFAULT_CONFIG.contextMaxMessages,
    maxToolCalls: userConfig.maxToolCalls ?? DEFAULT_CONFIG.maxToolCalls,
    server: {
      port: userConfig.server?.port ?? DEFAULT_SERVER_CONFIG.port,
      host: userConfig.server?.host ?? DEFAULT_SERVER_CONFIG.host,
    },
    fs: {
      allowedDirs: userConfig.fs?.allowedDirs ?? DEFAULT_FS_CONFIG.allowedDirs,
      allowedFiles: userConfig.fs?.allowedFiles ?? DEFAULT_FS_CONFIG.allowedFiles,
    },
    tools: {
      tavily: {
        enabled: userConfig.tools?.tavily?.enabled ?? DEFAULT_TOOLS_CONFIG.tavily.enabled,
        apiKey: userConfig.tools?.tavily?.apiKey ?? DEFAULT_TOOLS_CONFIG.tavily.apiKey,
        baseUrl: userConfig.tools?.tavily?.baseUrl ?? DEFAULT_TOOLS_CONFIG.tavily.baseUrl,
        searchDepth: userConfig.tools?.tavily?.searchDepth ?? DEFAULT_TOOLS_CONFIG.tavily.searchDepth,
        maxResults: userConfig.tools?.tavily?.maxResults ?? DEFAULT_TOOLS_CONFIG.tavily.maxResults,
        includeAnswer: userConfig.tools?.tavily?.includeAnswer ?? DEFAULT_TOOLS_CONFIG.tavily.includeAnswer,
        includeRawContent: userConfig.tools?.tavily?.includeRawContent ?? DEFAULT_TOOLS_CONFIG.tavily.includeRawContent,
        includeUsage: userConfig.tools?.tavily?.includeUsage ?? DEFAULT_TOOLS_CONFIG.tavily.includeUsage,
        timeoutMs: userConfig.tools?.tavily?.timeoutMs ?? DEFAULT_TOOLS_CONFIG.tavily.timeoutMs,
        maxSearchContentChars: userConfig.tools?.tavily?.maxSearchContentChars ?? DEFAULT_TOOLS_CONFIG.tavily.maxSearchContentChars,
        fetchDepth: userConfig.tools?.tavily?.fetchDepth ?? DEFAULT_TOOLS_CONFIG.tavily.fetchDepth,
        fetchFormat: userConfig.tools?.tavily?.fetchFormat ?? DEFAULT_TOOLS_CONFIG.tavily.fetchFormat,
        maxFetchedChars: userConfig.tools?.tavily?.maxFetchedChars ?? DEFAULT_TOOLS_CONFIG.tavily.maxFetchedChars,
      },
      trilium: {
        enabled: userConfig.tools?.trilium?.enabled ?? DEFAULT_TOOLS_CONFIG.trilium.enabled,
        baseUrl: userConfig.tools?.trilium?.baseUrl ?? DEFAULT_TOOLS_CONFIG.trilium.baseUrl,
        token: userConfig.tools?.trilium?.token ?? DEFAULT_TOOLS_CONFIG.trilium.token,
        ancestorNoteId: userConfig.tools?.trilium?.ancestorNoteId ?? DEFAULT_TOOLS_CONFIG.trilium.ancestorNoteId,
        timeoutMs: userConfig.tools?.trilium?.timeoutMs ?? DEFAULT_TOOLS_CONFIG.trilium.timeoutMs,
      },
    },
    compaction: {
      provider: userConfig.compaction?.provider ?? DEFAULT_CONFIG.compaction.provider,
      model: userConfig.compaction?.model ?? DEFAULT_CONFIG.compaction.model,
      thinkingEffort: normalizeEffort(userConfig.compaction?.thinkingEffort) ?? DEFAULT_CONFIG.compaction.thinkingEffort,
      keepRecentRounds: userConfig.compaction?.keepRecentRounds ?? DEFAULT_CONFIG.compaction.keepRecentRounds,
    },
  };
}

async function loadConfigFile(configPath: string): Promise<Partial<Config>> {
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    assertNoLegacyFields(parsed);
    return parsed as Partial<Config>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError("Invalid JSON in config file", {
        code: "config_parse_error",
        path: configPath,
      });
    }
    throw error;
  }
}

function validateConfig(userConfig: Partial<Config>): Config {
  const mergedConfig = mergeWithDefaults(userConfig);
  const result = ConfigSchema.safeParse(mergedConfig);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${(issue.path || []).join(".")}: ${issue.message}`)
      .join(", ");
    throw new ConfigError(`Config validation failed: ${errors}`, {
      code: "config_validation_error",
      errors: result.error.flatten(),
    });
  }
  return result.data;
}

export function getProviderCredential(config: Config, provider: ProviderName): ProviderCredential {
  const credential = config.providers[provider];
  if (!credential?.apiKey) {
    throw new ConfigError(`API Key is required for provider '${provider}'. Please update config.json.`, {
      code: "config_validation_error",
    });
  }
  return credential;
}

export function getAvailableProviders(config: Config): ProviderName[] {
  return SUPPORTED_PROVIDERS.filter((provider) => Boolean(config.providers[provider]?.apiKey));
}

export function getDefaultProviderCredential(config: Config): ProviderCredential {
  return getProviderCredential(config, config.defaultProvider);
}

function normalizeEffort(value: string | undefined): ThinkingEffort | undefined {
  if (!value || value === "none") return "off";
  return value as ThinkingEffort;
}

function normalizeLegacyEffort(config: Record<string, unknown>): void {
  // Normalize legacy "none" thinking effort values to "off"
  if (config.defaultThinkingEffort === "none") (config as Record<string, unknown>).defaultThinkingEffort = "off";
  const compaction = config.compaction as Record<string, unknown> | undefined;
  if (compaction?.thinkingEffort === "none") compaction.thinkingEffort = "off";
}

export function resolveModelThinking(config: Config, provider: ProviderName, model: string, level?: string): { level: string; params: ThinkingParams } {
  const modelConfig = config.providers[provider]?.models.find((item) => item.id === model);
  if (!level || level === "off") return { level: "off", params: modelConfig?.thinkingOff ?? {} };
  const option = modelConfig?.thinking?.find((item) => item.id === level);
  return option ? { level: option.id, params: option.params } : { level: "off", params: modelConfig?.thinkingOff ?? {} };
}

export async function loadConfig(userDataDir?: string): Promise<Config> {
  const config = await loadConfigWithoutApiKey(userDataDir);
  getDefaultProviderCredential(config);
  return config;
}

export async function loadConfigWithoutApiKey(userDataDir?: string): Promise<Config> {
  const paths = getPaths(userDataDir);
  await ensureDirectories(paths);
  const userConfig = await loadConfigFile(paths.config);
  normalizeLegacyEffort(userConfig);
  return validateConfig(userConfig);
}

export async function initConfig(userDataDir?: string): Promise<Config> {
  const paths = getPaths(userDataDir);
  await ensureDirectories(paths);

  const configExists = await pathExists(paths.config);
  await migrateLegacySystemPrompt(paths);
  logger.info("Synchronizing default templates...");
  await copyTemplates(paths);

  if (configExists) {
    logger.info("Config file already exists, loading...");
  } else {
    logger.warn("Default config created. Please edit config.json and set your API Key.");
  }

  const userConfig = await loadConfigFile(paths.config);
  return validateConfig(userConfig);
}

export async function getConfig(userDataDir?: string): Promise<Config> {
  const paths = getPaths(userDataDir);
  if (!(await pathExists(paths.config))) {
    return initConfig(userDataDir);
  }
  return loadConfig(userDataDir);
}

export * from "./schema.js";
export * from "./paths.js";
