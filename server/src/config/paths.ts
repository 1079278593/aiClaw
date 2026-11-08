/**
 * Path utilities - Resolve user data directory and paths
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import dotenv from "dotenv";
import {
  BRAND_SLUG,
  dataDirEnvMissingMessage,
  getDataDirFromEnv,
} from "../brand.js";
import { currentTenant } from "../tenant/store.js";

dotenv.config();

/**
 * Install root from AICLAW_DATA_DIR. Process logs and auth live here.
 * Tenant data lives in tenants/<id>/ under this root.
 */
export function getInstallRoot(): string {
  const envDir = getDataDirFromEnv();
  if (envDir) return envDir;
  throw new Error(dataDirEnvMissingMessage());
}

/**
 * Active tenant data directory when a request/CLI command entered runWithTenant.
 * Outside that scope this is the install root, which tests and one-off scripts still use.
 */
export function getUserDataDir(): string {
  return currentTenant()?.base ?? getInstallRoot();
}

/**
 * Get paths relative to user data directory
 */
export function getPaths(userDataDir?: string) {
  const base = userDataDir ?? getUserDataDir();

  return {
    base,
    config: path.join(base, "config.json"),
    logs: path.join(base, "logs"),
    conversations: path.join(base, "conversations"),
    conversationArchive: path.join(base, "conversation_archive"),
    reflections: path.join(base, "reflections"),
    people: path.join(base, "people"),
    distill: path.join(base, "distill"),
    pending: path.join(base, "pending"),
    pendingArchive: path.join(base, "pending", "_archive"),
    agents: path.join(base, "agents"),
    agentsMain: path.join(base, "agents", "main"),
    agentMemory: path.join(base, "agents", "main", "memory"),
    knowledgeBase: path.join(base, "knowledge_base"),
    files: path.join(base, "files"),
    commandsFile: path.join(base, "files", "commands.md"),
    usageTempFile: path.join(base, "files", "usage_temp.json"),
    usageDaily: path.join(base, "files", "usage_daily.json"),
    usageTotal: path.join(base, "files", "usage_total.json"),
    appStateFile: path.join(base, "files", "app_state.json"),
    agentSystemPromptFile: path.join(base, "files", "prompts", "agent_system_prompt.txt"),
    /** 单一来源的首选宪法（plan §8.1）；不存在时回退 agentSystemPromptFile。 */
    agentConstitutionFile: path.join(base, "agents", "main", "AGENT.md"),
    compactionPromptFile: path.join(base, "files", "prompts", "compaction_prompt.txt"),
    knowledgeInstructionsFile: path.join(base, "knowledge_base", "instructions.md"),
    installedTemplatesFile: path.join(base, ".installed_templates.json"),
  };
}

/**
 * Ensure all required directories exist
 */
export async function ensureDirectories(paths: ReturnType<typeof getPaths>): Promise<void> {
  const fs = await import("node:fs/promises");

  await fs.mkdir(paths.base, { recursive: true });

  const dirs = [
    paths.logs,
    paths.conversations,
    paths.conversationArchive,
    paths.reflections,
    path.join(paths.reflections, "inbox"),
    paths.people,
    paths.distill,
    paths.pending,
    paths.pendingArchive,
    paths.agentsMain,
    path.join(paths.agentMemory, "_archive"),
    path.join(paths.agentsMain, "_archive"),
    paths.knowledgeBase,
    paths.files,
  ];

  for (const dir of dirs) {
    await mkdirResilient(fs, dir);
  }

  // `_index.md` 是系统元数据，创建目录时一并补齐空文件（plan §2.3）：
  // reflections/、reflections/inbox/、knowledge_base/。已存在的索引不动。
  const indexer = await import("../index/indexer.js");
  await indexer.ensureIndexRoots(paths.base);

  // 记忆正文/元数据的空壳（plan §3.4）。已存在的内容不动。
  const memory = await import("../memory/store.js");
  await memory.ensureMemoryFiles(paths.base);
}

/**
 * 目录可能正被外部删除/重建（测试清理、租户切换），`recursive` 仍可能撞上
 * 父目录被并发移除产生的 ENOENT。这里重试几次，避免启动/鉴权因瞬时竞争失败。
 */
async function mkdirResilient(
  fs: typeof import("node:fs/promises"),
  dir: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.mkdir(dir, { recursive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/**
 * Check if a path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a temporary test data directory
 * Creates a unique temp directory for each test run
 */
export function getTestDir(): string {
  const testId = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `${BRAND_SLUG}-test-${testId}`);
}
