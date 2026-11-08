/**
 * Pending 提案：通往知识区（reflections / knowledge_base）的唯一出口。
 *
 * 本模块只负责「提案」本身：写入、读取、列表、状态流转、归档。
 * apply 的哈希校验与文件写入在 `apply.ts`，避免 store 变成一个巨型文件。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";

export type PendingKind = "reflection" | "doc";
export type PendingChangeType = "create" | "update";
export type PendingStatus = "open" | "applied" | "stale" | "expired";

export type PendingFields = {
  title?: string;
  context?: string;
  occurredAt?: string;
};

export type PendingRelation = { path: string; relation: string };

export type PendingMeta = {
  id: string;
  kind: PendingKind;
  changeType: PendingChangeType;
  target: string;
  targetDir: string | null;
  fields: PendingFields;
  summary: string;
  sourceSessionId: string;
  baseHash: string;
  proposedHash: string;
  normalized: boolean;
  relatesTo: PendingRelation[];
  createdAt: string;
  status: PendingStatus;
  appliedAt: string | null;
  /** 离开 `open` 的时刻：TTL 的起算点（plan §4.4）。 */
  settledAt?: string | null;
  /** 移入 `pending/_archive` 的时刻：物理删除的起算点。 */
  archivedAt?: string | null;
  /** 本次 apply 发生过改名/移动时的旧路径，供其他提案 lazy resolve。 */
  renamedFrom?: string;
  /** 索引写入失败的诊断标记，不参与 apply 判定。 */
  needsIndexSync?: boolean;
};

export type PendingSummary = {
  id: string;
  kind: PendingKind;
  changeType: PendingChangeType;
  target: string;
  summary: string;
  createdAt: string;
  status: PendingStatus;
};

export type PendingDetail = {
  meta: PendingMeta;
  base: string;
  proposed: string;
};

export class PendingError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export const KNOWLEDGE_ROOTS = ["reflections", "knowledge_base"] as const;

/** 知识区判定：只有这两棵树下才允许提案。 */
export function isKnowledgePath(relativePath: string): boolean {
  const rel = normalizeRelative(relativePath);
  return KNOWLEDGE_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

export function normalizeRelative(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

/**
 * 内容归一化：去 BOM、CRLF → LF、末尾补齐单个换行。
 * 混用 Windows / NAS 编辑时不产生假冲突。
 */
export function normalizeContent(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** 心得文件去掉 front matter，只留正文（与 `proposed.md` 的存储口径一致）。 */
export function reflectionBodyOnly(raw: string): string {
  const text = normalizeContent(raw);
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return text;
  return text.slice(end + 5).replace(/^\n+/, "");
}

/**
 * 按提案类型取哈希口径：
 * - `doc`：全文；
 * - `reflection`：正文（`proposed.md` 只存正文，全文哈希永远对不上）。
 */
export function contentForHash(kind: PendingKind, raw: string): string {
  return kind === "reflection" ? reflectionBodyOnly(raw) : normalizeContent(raw);
}

export function hashContent(raw: string): string {
  return createHash("sha256").update(normalizeContent(raw), "utf-8").digest("hex");
}

/** 与 `contentForHash` 配套的哈希：先按提案类型取口径，再归一化哈希。 */
export function hashForKind(kind: PendingKind, raw: string): string {
  return hashContent(contentForHash(kind, raw));
}

export function pendingRoot(userDataDir?: string): string {
  return getPaths(userDataDir).pending;
}

export function pendingArchiveRoot(userDataDir?: string): string {
  return getPaths(userDataDir).pendingArchive;
}

export function proposalDir(id: string, userDataDir?: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new PendingError("pending not found", 404);
  return path.join(pendingRoot(userDataDir), id);
}

function newProposalId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const byte of randomBytes(3)) suffix += alphabet[byte % alphabet.length];
  return `${stamp}-${suffix}`;
}

async function readText(file: string): Promise<string> {
  return readFile(file, "utf-8");
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function readPendingMeta(id: string, userDataDir?: string): Promise<PendingMeta> {
  const file = path.join(proposalDir(id, userDataDir), "meta.json");
  let raw: string;
  try {
    raw = await readText(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PendingError("pending not found", 404);
    throw error;
  }
  try {
    return JSON.parse(raw) as PendingMeta;
  } catch {
    throw new PendingError("pending meta.json 解析失败", 500);
  }
}

/** 只改本提案自己的 meta：不扫描、不改写其他提案。 */
export async function writePendingMeta(meta: PendingMeta, userDataDir?: string): Promise<void> {
  const dir = proposalDir(meta.id, userDataDir);
  const file = path.join(dir, "meta.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  await rename(tmp, file);
}

export async function readPendingDetail(id: string, userDataDir?: string): Promise<PendingDetail> {
  const meta = await readPendingMeta(id, userDataDir);
  const dir = proposalDir(id, userDataDir);
  const base = await readText(path.join(dir, "base.md")).catch(() => "");
  const proposed = await readText(path.join(dir, "proposed.md")).catch(() => "");
  return { meta, base, proposed };
}

/** 待应用列表：默认只返回 open；status=all 返回全部。 */
export async function listPending(
  options: { status?: string; userDataDir?: string } = {},
): Promise<PendingSummary[]> {
  const root = pendingRoot(options.userDataDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const wantAll = options.status === "all";
  const wantStatus = options.status && !wantAll ? options.status : undefined;
  const items: PendingSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    let meta: PendingMeta;
    try {
      meta = await readPendingMeta(entry.name, options.userDataDir);
    } catch {
      continue;
    }
    if (wantStatus ? meta.status !== wantStatus : !wantAll && meta.status !== "open") continue;
    items.push({
      id: meta.id,
      kind: meta.kind,
      changeType: meta.changeType,
      target: meta.target,
      summary: meta.summary,
      createdAt: meta.createdAt,
      status: meta.status,
    });
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export async function countOpenPending(userDataDir?: string): Promise<number> {
  return (await listPending({ userDataDir })).length;
}

export type ProposeChangeInput = {
  target: string;
  kind: PendingKind;
  body: string;
  fields?: PendingFields;
  summary: string;
  sourceSessionId?: string;
  relatesTo?: PendingRelation[];
  userDataDir?: string;
};

/**
 * 创建提案。
 *
 * 校验：target 必须在知识区内；update 时目标必须存在；body 不得为空或与现有内容相同。
 * 写入：先落临时目录，再 rename 成 `pending/<id>/`，避免半成品被列表看到。
 */
export async function createProposal(input: ProposeChangeInput): Promise<PendingMeta> {
  const base = getPaths(input.userDataDir).base;
  const target = normalizeRelative(input.target);
  if (!target) throw new PendingError("target 不能为空", 400);
  if (!isKnowledgePath(target)) {
    throw new PendingError("只能对 reflections/ 或 knowledge_base/ 提案", 400);
  }
  if (target.includes("..")) throw new PendingError("路径不允许", 400);

  const targetAbs = path.resolve(base, target);
  const targetDirAbs = path.dirname(targetAbs);
  const targetStat = await stat(targetAbs).catch(() => null);
  if (targetStat?.isDirectory()) throw new PendingError("target 不能是目录", 400);

  const boundary = getPaths(input.userDataDir).pending;
  if (targetAbs.startsWith(boundary + path.sep)) throw new PendingError("target 不能在 pending/ 内", 400);

  const body = String(input.body ?? "");
  if (!body.trim() && input.kind === "doc") throw new PendingError("内容不能为空", 400);

  const changeType: PendingChangeType = targetStat ? "update" : "create";
  if (input.kind === "reflection" && changeType === "update" && !body.trim()) {
    throw new PendingError("正文不能为空", 400);
  }

  const currentRaw = targetStat ? await readText(targetAbs) : null;
  if (currentRaw !== null) {
    // reflection 只比较正文 + 显式字段：正文没变且没带任何 front matter 字段才是「无需变更」。
    const hasFieldUpdates = Object.values(input.fields ?? {}).some((value) => typeof value === "string" && value.trim());
    const same = contentForHash(input.kind, currentRaw) === contentForHash(input.kind, body);
    if (same && !hasFieldUpdates) throw new PendingError("提案内容与现有内容相同，无需变更", 400);
  }

  const id = newProposalId();
  const dir = proposalDir(id, input.userDataDir);
  const staging = `${dir}.staging-${process.pid}`;
  const meta: PendingMeta = {
    id,
    kind: input.kind,
    changeType,
    target,
    targetDir: changeType === "create" ? normalizeRelative(path.relative(base, targetDirAbs)) : null,
    fields: input.fields ?? {},
    summary: String(input.summary ?? "").trim() || "未填写摘要",
    sourceSessionId: input.sourceSessionId ?? "",
    baseHash: currentRaw === null ? "" : hashForKind(input.kind, currentRaw),
    proposedHash: hashForKind(input.kind, body),
    normalized: true,
    relatesTo: input.relatesTo ?? [],
    createdAt: new Date().toISOString(),
    status: "open",
    appliedAt: null,
  };

  await mkdir(staging, { recursive: true });
  try {
    await writeFile(path.join(staging, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
    await writeFile(path.join(staging, "base.md"), currentRaw ?? "", "utf-8");
    await writeFile(path.join(staging, "proposed.md"), body, "utf-8");
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return meta;
}

/** 无副作用地丢弃提案：status=expired，等待 TTL 归档。 */
export async function dismissProposal(id: string, userDataDir?: string): Promise<PendingMeta> {
  const meta = await readPendingMeta(id, userDataDir);
  if (meta.status !== "open") return meta;
  const next: PendingMeta = { ...meta, status: "expired", settledAt: new Date().toISOString() };
  await writePendingMeta(next, userDataDir);
  return next;
}

/** 归档：移动到 pending/_archive/<id>/，同名已存在时带时间戳后缀。 */
export async function archiveProposal(id: string, userDataDir?: string): Promise<void> {
  const from = proposalDir(id, userDataDir);
  const archiveRoot = pendingArchiveRoot(userDataDir);
  await mkdir(archiveRoot, { recursive: true });
  let to = path.join(archiveRoot, id);
  if (await exists(to)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    to = path.join(archiveRoot, `${id}-${stamp}`);
  }
  await rename(from, to).catch(() => undefined);
  // 删除计时从「进入 _archive」起算，而不是从离开 open 起算。
  await markArchivedAt(id, to, userDataDir);
}

/** 在归档后的 meta 上补 `archivedAt`（失败不影响归档结果）。 */
async function markArchivedAt(id: string, archiveDir: string, userDataDir?: string): Promise<void> {
  const file = path.join(archiveDir, "meta.json");
  try {
    const raw = await readText(file);
    const meta = JSON.parse(raw) as PendingMeta;
    if (meta.archivedAt) return;
    const next: PendingMeta = { ...meta, archivedAt: new Date().toISOString() };
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  } catch {
    void id;
    void userDataDir;
  }
}
