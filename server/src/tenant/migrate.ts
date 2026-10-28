/**
 * Move a pre-tenant install (config and data at AICLAW_DATA_DIR root)
 * into tenants/<userId>/ once. Process logs stay at the install root.
 */

import path from "node:path";
import { rename, mkdir } from "node:fs/promises";
import { pathExists } from "../config/paths.js";
import { assertUserId } from "./store.js";

const LEGACY_ENTRIES = [
  "config.json",
  "conversations",
  "conversation_archive",
  "inputs",
  "knowledge_base",
  "files",
  ".installed_templates.json",
] as const;

export type MigrateResult = "migrated" | "already" | "fresh";

export function defaultTenantDir(installRoot: string, userId = "default"): string {
  return path.join(installRoot, "tenants", assertUserId(userId));
}

export async function migrateLegacyInstall(installRoot: string, userId = "default"): Promise<MigrateResult> {
  const dest = defaultTenantDir(installRoot, userId);
  const destConfig = path.join(dest, "config.json");
  const srcConfig = path.join(installRoot, "config.json");
  const hasDest = await pathExists(destConfig);
  const hasSrc = await pathExists(srcConfig);

  if (hasDest && hasSrc) {
    throw new Error(
      `Both ${srcConfig} and ${destConfig} exist. Move or remove one before migrating.`,
    );
  }
  if (hasDest) return "already";
  if (!hasSrc) return "fresh";

  await mkdir(dest, { recursive: true });
  for (const name of LEGACY_ENTRIES) {
    const from = path.join(installRoot, name);
    if (!(await pathExists(from))) continue;
    await rename(from, path.join(dest, name));
  }
  return "migrated";
}
