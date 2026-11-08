/**
 * `pending/_archive` 的 TTL（plan §4.4 / §11）。
 *
 * 两段生命周期，都以「离开 open」为起算点：
 *   open → applied/stale/expired --30d--> pending/_archive --30d--> 物理删除
 *
 * `open` 永不清理：它是用户的待办，静默删除等于丢工作。
 */

import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import {
  archiveProposal,
  listPending,
  pendingArchiveRoot,
  readPendingMeta,
  type PendingMeta,
} from "./store.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 离开 open 后多久进入 _archive。 */
export const ARCHIVE_AFTER_DAYS = 30;
/** 进入 _archive 后多久物理删除。 */
export const DELETE_AFTER_DAYS = 30;

export type PendingCleanupReport = {
  archived: string[];
  deleted: string[];
  failed: { id: string; reason: string }[];
};

/** 状态的起算点：优先 `settledAt`，缺省退回 `appliedAt`，再退回 `createdAt`（旧数据兼容）。 */
export function settledAtOf(meta: PendingMeta): string {
  return meta.settledAt || meta.appliedAt || meta.createdAt;
}

function ageDays(iso: string, now: Date): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return (now.getTime() - at) / DAY_MS;
}

/**
 * 纯判定函数：给定 meta 与当前时间，是否应当归档。
 * 抽出来是为了单测能直接喂固定时间，不依赖真实时钟。
 */
export function shouldArchive(meta: PendingMeta, now: Date = new Date()): boolean {
  if (meta.status === "open") return false;
  return ageDays(settledAtOf(meta), now) >= ARCHIVE_AFTER_DAYS;
}

/** 已归档目录里，是否应当物理删除（优先读 meta.archivedAt，缺省按目录 mtime 兜底）。 */
export function shouldDeleteArchiveDir(mtimeMs: number, now: Date = new Date()): boolean {
  return (now.getTime() - mtimeMs) / DAY_MS >= DELETE_AFTER_DAYS;
}

/** 归档目录的删除起算点：meta.archivedAt 优先，缺失时退回目录 mtime。 */
export async function archiveAgeAnchor(dir: string, now: Date): Promise<Date> {
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8")) as PendingMeta;
    if (meta.archivedAt) {
      const at = new Date(meta.archivedAt);
      if (!Number.isNaN(at.getTime())) return at;
    }
  } catch {
    // 归档目录里 meta 可能已损坏：退回 mtime。
  }
  return (await stat(dir)).mtime;
}

export async function sweepPendingTtl(
  options: { userDataDir?: string; now?: Date; log?: (message: string) => void } = {},
): Promise<PendingCleanupReport> {
  const now = options.now ?? new Date();
  const log = options.log ?? (() => undefined);
  const report: PendingCleanupReport = { archived: [], deleted: [], failed: [] };

  // 1. 归档：非 open 且离开 open 满 30 天。
  const pending = await listPending({ status: "all", userDataDir: options.userDataDir });
  for (const item of pending) {
    let meta: PendingMeta;
    try {
      meta = await readPendingMeta(item.id, options.userDataDir);
    } catch {
      continue;
    }
    if (!shouldArchive(meta, now)) continue;
    try {
      await archiveProposal(item.id, options.userDataDir);
      report.archived.push(item.id);
    } catch (error) {
      report.failed.push({ id: item.id, reason: (error as Error).message });
    }
  }

  // 2. 删除：_archive 内满 30 天（archivedAt 优先，mtime 兜底）。
  //    本次刚归档的条目必须跳过：它们的 30 天从此刻起算，不能被同一个 now 立即删掉。
  const justArchived = new Set(report.archived);
  const archiveRoot = pendingArchiveRoot(options.userDataDir);
  let entries;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch {
    return report;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (justArchived.has(entry.name)) continue;
    const abs = path.join(archiveRoot, entry.name);
    try {
      const anchor = await archiveAgeAnchor(abs, now);
      if (!shouldDeleteArchiveDir(anchor.getTime(), now)) continue;
      await rm(abs, { recursive: true, force: true });
      report.deleted.push(entry.name);
    } catch (error) {
      report.failed.push({ id: entry.name, reason: (error as Error).message });
    }
  }

  if (report.archived.length || report.deleted.length) {
    log(`pending TTL: archived=${report.archived.length} deleted=${report.deleted.length}`);
  }
  for (const failure of report.failed) {
    log(`pending TTL failed for ${failure.id}: ${failure.reason}`);
  }
  return report;
}

/** 单租户数据目录（供后台任务遍历）。 */
export function tenantPendingRoot(userDataDir: string): string {
  return getPaths(userDataDir).pending;
}
