/**
 * 归档目录的 90 天 TTL（plan §11）。
 *
 * 覆盖三类「软删兜底区」，语义一致：**这些目录里的东西随时可删**，
 * 它们的存在只是为了给用户一次反悔机会，不是数据源。
 *
 * | 目录 | 生产者 |
 * |------|--------|
 * | `distill/<子目录>/_archive` | 蒸馏被覆盖/删除 |
 * | `agents/<id>/memory/_archive` | 记忆被弱化/覆盖（§3.3 保留最近 3 份） |
 * | `people/<id>/_archive` | 档案被覆盖/删除（每文件最多 3 份） |
 *
 * 判定只用**目录名里的时间戳**（当前归档命名都带 ISO 时间），
 * 读不到就以目录 mtime 兜底 —— 不为了删一个归档目录去解析业务文件。
 */

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import { DAY_MS } from "../pending/ttl.js";

/** 归档目录保留期（plan §11）。 */
export const ARCHIVE_TTL_DAYS = 90;

export type ArchiveSweepReport = {
  /** 被删除的目录（相对数据根，便于日志阅读）。 */
  deleted: string[];
  failed: { dir: string; reason: string }[];
};

/**
 * 目录名里是否带可解析的时间戳。
 *
 * 归档命名形如 `2026-11-08T12:34:56.789Z-a1b2c3`，也兼容只到秒的旧格式。
 * 越界的时间（未来、1970）一律视为不可解析，避免时钟错乱把新归档删掉。
 */
export function timestampFromName(name: string, now: Date = new Date()): Date | null {
  const match = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(name);
  if (!match) return null;
  const at = new Date(match[1]);
  if (Number.isNaN(at.getTime())) return null;
  // 未来时间说明时钟回拨或命名伪造：不认，退回 mtime。
  if (at.getTime() > now.getTime() + DAY_MS) return null;
  return at;
}

/** 纯判定：给定归档时间锚点，是否已过 90 天。 */
export function shouldDeleteArchive(anchor: Date, now: Date = new Date()): boolean {
  return (now.getTime() - anchor.getTime()) / DAY_MS >= ARCHIVE_TTL_DAYS;
}

/**
 * 递归找出 `root` 下所有名为 `_archive` 的目录。
 *
 * 用 `readdir` 逐层下钻而不是 `glob`：要跳过的目录（`.assets`、隐藏目录）
 * 在这里就能剪枝，避免把整棵心得树扫一遍。
 */
export async function findArchiveDirs(root: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out; // 目录不存在：这一支没有归档可清。
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "_archive") {
      out.push(path.join(root, entry.name));
      continue;
    }
    // 附属目录与隐藏目录里不会有归档；跳过能显著减少 IO。
    if (entry.name.startsWith(".") || entry.name.endsWith(".assets")) continue;
    await findArchiveDirs(path.join(root, entry.name), out);
  }
  return out;
}

/** 清理一个 `_archive` 目录里过期的条目（条目可文件也可目录）。 */
export async function sweepArchiveDir(
  archiveDir: string,
  options: { now?: Date; baseDir?: string } = {},
): Promise<ArchiveSweepReport> {
  const now = options.now ?? new Date();
  const report: ArchiveSweepReport = { deleted: [], failed: [] };
  let entries;
  try {
    entries = await readdir(archiveDir, { withFileTypes: true });
  } catch {
    return report;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(archiveDir, entry.name);
    try {
      // 先看目录名里有没有时间戳，再退回 mtime —— 少一次 stat。
      let anchor = timestampFromName(entry.name, now);
      if (!anchor) anchor = (await stat(abs)).mtime;
      if (!shouldDeleteArchive(anchor, now)) continue;
      await rm(abs, { recursive: true, force: true });
      report.deleted.push(options.baseDir ? path.relative(options.baseDir, abs).replaceAll("\\", "/") : abs);
    } catch (error) {
      report.failed.push({
        dir: options.baseDir ? path.relative(options.baseDir, abs).replaceAll("\\", "/") : abs,
        reason: (error as Error).message,
      });
    }
  }
  return report;
}

/**
 * 对一个租户跑完三类归档清理。
 *
 * 失败只记日志：清理是尽力而为的后台动作，不该让某个坏符号链接
 * 导致整个任务失败，更不该影响请求。
 */
export async function sweepArchiveTtl(
  options: { userDataDir?: string; now?: Date; log?: (message: string) => void } = {},
): Promise<ArchiveSweepReport> {
  const now = options.now ?? new Date();
  const log = options.log ?? (() => undefined);
  const paths = getPaths(options.userDataDir);
  const total: ArchiveSweepReport = { deleted: [], failed: [] };

  const roots = [
    path.join(paths.agents), // agents/**/memory/_archive
    paths.distill,
    paths.people,
  ];

  for (const root of roots) {
    const dirs = await findArchiveDirs(root);
    for (const dir of dirs) {
      const result = await sweepArchiveDir(dir, { now, baseDir: paths.base });
      total.deleted.push(...result.deleted);
      total.failed.push(...result.failed);
    }
  }

  if (total.deleted.length) log(`archive TTL: deleted=${total.deleted.length}`);
  for (const failure of total.failed) {
    log(`archive TTL failed for ${failure.dir}: ${failure.reason}`);
  }
  return total;
}
