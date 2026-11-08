/**
 * 蒸馏存储（plan_distill §2 / §3.3 / §7）。
 *
 * 磁盘布局（每个 tenant）：
 * ```
 * distill/
 *   ├── meta/overview.md          # 全局地图，唯一被注入的蒸馏文件
 *   ├── reflections/<主题>.md
 *   ├── knowledge/<库名>/overview.md
 *   └── _archive/                 # 覆盖前的旧版本，保留最近 3 份
 * ```
 *
 * 三条贯穿本模块的原则：
 * 1. **蒸馏是缓存**：任何读写失败都不得让「读原文」失败，除显式写入外一律不抛；
 * 2. **无头文件不属于系统**：没有 `id` 的文件当用户手写笔记，永不覆盖、不归档；
 * 3. **原子写**：先写 `.tmp` 再 `rename`，绝不留下半截摘要。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import { ARCHIVE_KEEP } from "../memory/types.js";
import {
  OVERVIEW_ID,
  parseDistillDoc,
  parseSources,
  renderDistillDoc,
  type DistillDoc,
} from "./format.js";

/** `meta/overview.md` 的体积上限（与 `memory/focus.md` 同级，plan_distill §2.2）。 */
export const OVERVIEW_BYTE_MAX = 2 * 1024;

/** 单份摘要正文上限。超了说明主题太大，该拆了。 */
export const DISTILL_BODY_BYTE_MAX = 32 * 1024;

export class DistillError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "DistillError";
  }
}

export function distillRoot(userDataDir?: string): string {
  return getPaths(userDataDir).distill;
}

export function distillMetaDir(userDataDir?: string): string {
  return path.join(distillRoot(userDataDir), "meta");
}

export function overviewFile(userDataDir?: string): string {
  return path.join(distillMetaDir(userDataDir), "overview.md");
}

export function archiveDir(userDataDir?: string): string {
  return path.join(distillRoot(userDataDir), "_archive");
}

/** 可放摘要的两个子树。`chat/` 有意不做（plan_distill §3.1.1）。 */
export const DISTILL_SCOPES = ["reflections", "knowledge"] as const;
export type DistillScope = (typeof DISTILL_SCOPES)[number];

export function isDistillScope(value: string): value is DistillScope {
  return (DISTILL_SCOPES as readonly string[]).includes(value);
}

/**
 * 摘要文件的绝对路径。
 *
 * 只允许 `<scope>/<相对路径>.md`，且必须落在 `distill/` 内——
 * 这里的输入可能来自 HTTP 参数，越界检查不能省。
 */
export function distillFile(
  scope: DistillScope,
  relative: string,
  userDataDir?: string,
): string {
  const rel = relative.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) {
    throw new DistillError("摘要路径不合法", 400);
  }
  if (!rel.endsWith(".md")) {
    throw new DistillError("摘要必须是 .md", 400);
  }
  const root = distillRoot(userDataDir);
  const abs = path.resolve(root, scope, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) {
    throw new DistillError("摘要路径越界", 400);
  }
  return abs;
}

/** 把绝对路径换算成 `distill/` 下的相对路径（用于日志与来源记录）。 */
export function relativeToDistill(abs: string, userDataDir?: string): string {
  const root = distillRoot(userDataDir);
  const rel = path.relative(root, abs).replaceAll("\\", "/");
  return rel.startsWith("distill/") ? rel : `distill/${rel}`;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function readText(abs: string): Promise<string> {
  return readFile(abs, "utf-8").catch(() => "");
}

/** 读一份摘要；不存在返回 `null`（缓存缺失是正常状态，不是错误）。 */
export async function readDistill(
  scope: DistillScope,
  relative: string,
  userDataDir?: string,
): Promise<DistillDoc | null> {
  const abs = distillFile(scope, relative, userDataDir);
  if (!(await exists(abs))) return null;
  return parseDistillDoc(await readText(abs));
}

/** 读地图；不存在返回空字符串。 */
export async function readOverview(userDataDir?: string): Promise<string> {
  return readText(overviewFile(userDataDir));
}

/**
 * 原子写一个文件。
 *
 * tmp 名带 pid 与随机后缀：两个并发请求写同一路径时，
 * 固定的 `.tmp` 名会让它们互相覆盖对方的半成品。
 */
async function atomicWrite(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, abs);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 归档戳：毫秒精度 + 随机后缀，避免同一秒内连续刷新同名（与 memory 同一个坑）。 */
export function archiveStamp(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace("T", "").replace(".", "").replace("Z", "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const byte of randomBytes(2)) suffix += alphabet[byte % alphabet.length];
  return `${iso}-${suffix}`;
}

/**
 * 覆盖前把旧内容存一份到 `_archive/`，并把**同一份摘要**的归档修剪到最近 `ARCHIVE_KEEP` 份。
 *
 * 修剪必须按「同一份摘要」分组：`_archive` 里混杂着所有主题的旧版本，
 * 按全局时间戳修剪会把别的主题的备份挤掉。
 */
export async function archiveBeforeOverwrite(
  abs: string,
  options: { userDataDir?: string; now?: Date } = {},
): Promise<void> {
  const previous = await readText(abs);
  if (!previous.trim()) return;
  const dir = archiveDir(options.userDataDir);
  await mkdir(dir, { recursive: true }).catch(() => undefined);

  // 归档名：`<时间戳>-<原相对路径扁平化>`，扁平化把 `/` 换成 `__`，避免建子目录。
  const rel = path.relative(distillRoot(options.userDataDir), abs).replaceAll("\\", "/");
  const flat = rel.replaceAll("/", "__");
  const name = `${archiveStamp(options.now)}-${flat}`;
  await writeFile(path.join(dir, name), previous, "utf-8").catch(() => undefined);
  await pruneArchiveFor(dir, flat);
}

async function pruneArchiveFor(dir: string, flat: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(`-${flat}`));
  } catch {
    return;
  }
  if (names.length <= ARCHIVE_KEEP) return;
  // 时间戳前缀可字典序排序，倒序保留最新。
  for (const stale of names.sort().reverse().slice(ARCHIVE_KEEP)) {
    await rm(path.join(dir, stale), { force: true }).catch(() => undefined);
  }
}

/**
 * 写一份摘要。`content` 是**完整文件内容**（含头），由调用方用 `renderDistillDoc` 生成。
 *
 * 只有带 `id` 的文件才会被归档：无头文件是用户的，我们不该动它
 * （也不该在覆盖前偷偷备份，那会让 `_archive` 混进用户内容）。
 */
export async function writeDistill(
  scope: DistillScope,
  relative: string,
  content: string,
  options: { userDataDir?: string; now?: Date; archive?: boolean } = {},
): Promise<string> {
  const abs = distillFile(scope, relative, options.userDataDir);
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > DISTILL_BODY_BYTE_MAX) {
    throw new DistillError(
      `摘要过大（${bytes} 字节 > ${DISTILL_BODY_BYTE_MAX}），请拆分主题后重试`,
      413,
    );
  }
  const previous = await readText(abs);
  const previousIsOwned = previous ? Boolean(parseDistillDoc(previous).id) : false;
  if (previousIsOwned && options.archive !== false) {
    await archiveBeforeOverwrite(abs, { userDataDir: options.userDataDir, now: options.now });
  }
  await atomicWrite(abs, content);
  return abs;
}

/**
 * 删除一份摘要：先归档再删，返回是否真的删掉了。
 * 无头文件拒绝删除——那是用户的笔记。
 */
export async function removeDistill(
  scope: DistillScope,
  relative: string,
  options: { userDataDir?: string; now?: Date } = {},
): Promise<boolean> {
  const abs = distillFile(scope, relative, options.userDataDir);
  const previous = await readText(abs);
  if (!previous) return false;
  if (!parseDistillDoc(previous).id) {
    throw new DistillError("该文件不是系统生成的摘要，不能通过此接口删除", 409);
  }
  await archiveBeforeOverwrite(abs, { userDataDir: options.userDataDir, now: options.now });
  await rm(abs, { force: true });
  return true;
}

// ---- 地图（meta/overview.md） ----

export type OverviewRow = {
  /** `distill/` 下的相对路径，如 `reflections/agent-memory.md`。 */
  file: string;
  /** 从摘要正文的 `# 标题` 取；没有就用文件名。 */
  title: string;
  /** 来源条数。 */
  sourceCount: number;
  /** 生成时刻（ISO）。无法解析时为 `?`。 */
  refreshed: string;
  /** 是否已过期（来源改动或缺失）。 */
  stale: boolean;
};

const OVERVIEW_HEADER = [
  "# 蒸馏地图",
  "",
  "| 主题 | 文件 | 来源数 | 刷新于 |",
  "|------|------|--------|--------|",
];

/**
 * 渲染地图。
 *
 * **超 2 KB 时按行裁剪**（保留最新的在前），而不是截断成半行——
 * 半张表比少几行更容易误导（与根索引「超限整块丢弃」是同一种保守）。
 */
export function renderOverview(rows: OverviewRow[], now: Date = new Date()): string {
  const sorted = [...rows].sort((a, b) => b.refreshed.localeCompare(a.refreshed));
  const build = (items: OverviewRow[]): string => {
    const lines = [...OVERVIEW_HEADER];
    for (const row of items) {
      const marker = row.stale ? " ⚠" : "";
      lines.push(`| ${escapeCell(row.title)}${marker} | ${escapeCell(row.file)} | ${row.sourceCount} | ${row.refreshed.slice(0, 10)} |`);
    }
    return renderDistillDoc(OVERVIEW_ID, now, lines.join("\n"));
  };

  let content = build(sorted);
  // 超限按行裁剪（保留刷新时间最新的），绝不截断成半行——半张表比少几行更误导。
  while (Buffer.byteLength(content, "utf-8") > OVERVIEW_BYTE_MAX && sorted.length > 0) {
    sorted.pop();
    content = build(sorted);
  }
  return content;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * 重建地图：扫描 `reflections/` 与 `knowledge/` 下所有带 `id` 的摘要。
 *
 * 无头文件被跳过——它们不属于系统的蒸馏结果，列进地图反而会让
 * Agent 以为那是可刷新的摘要。
 */
export async function rebuildOverview(options: {
  userDataDir?: string;
  now?: Date;
  /** 判断摘要是否过期；缺省一律视为新鲜（只用于「只想要地图」的场景）。 */
  isStale?: (file: string, doc: DistillDoc) => Promise<boolean>;
} = {}): Promise<string> {
  const now = options.now ?? new Date();
  const rows: OverviewRow[] = [];
  for (const scope of DISTILL_SCOPES) {
    const root = path.join(distillRoot(options.userDataDir), scope);
    const files = await listSummaries(root);
    for (const abs of files) {
      const content = await readText(abs);
      const doc = parseDistillDoc(content);
      if (!doc.id) continue;
      const rel = path.relative(distillRoot(options.userDataDir), abs).replaceAll("\\", "/");
      rows.push({
        file: rel,
        title: titleOf(doc.body, path.basename(abs, ".md")),
        sourceCount: parseSources(doc.body).length,
        refreshed: doc.refreshed ?? "?",
        stale: options.isStale ? await options.isStale(abs, doc).catch(() => false) : false,
      });
    }
  }
  const content = renderOverview(rows, now);
  await atomicWrite(overviewFile(options.userDataDir), content);
  return content;
}

/** 递归列出某子树下的 `.md` 文件（跳过 `_archive` 与隐藏目录）。 */
export async function listSummaries(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "_archive") continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listSummaries(abs));
      continue;
    }
    if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

/** 摘要标题：正文第一行 `# xxx`；没有就用文件名。 */
export function titleOf(body: string, fallback: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("# ")) return trimmed.slice(2).trim() || fallback;
    break;
  }
  return fallback;
}
