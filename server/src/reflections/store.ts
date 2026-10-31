/**
 * 心得落盘：真相源为 inputs/reflections 文件树；无 index.json。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import {
  deleteAssetsPair,
  isAssetsDirName,
  moveAssetsPair,
  reflectionStem,
  rewriteAssetsPrefixInBody,
} from "./media.js";
import { parseReflectionPaste } from "./parse.js";
import {
  ReflectionsError,
  ROOT_REL,
  assertUnderRoot,
  normalizeRel,
  reflectionsRoot,
  resolveFolder,
  resolveReflectionPath,
} from "./paths.js";

export type ReflectionMeta = {
  path: string;
  title: string;
  occurredAt: string;
  context: string;
  folder: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ReflectionDoc = ReflectionMeta & {
  body: string;
};

export { ReflectionsError, reflectionsRoot, resolveReflectionPath };

const TEXT_EXT = new Set([".md", ".txt"]);

export async function ensureReflectionsDirs(userDataDir?: string): Promise<void> {
  const root = reflectionsRoot(userDataDir);
  await mkdir(path.join(root, "inbox"), { recursive: true });
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

type FrontMatter = {
  title?: string;
  occurredAt?: string;
  context?: string;
  createdAt?: string;
  updatedAt?: string;
};

function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  const text = stripBom(raw).replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: text };
  const yaml = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta: FrontMatter = {};
  for (const line of yaml.split("\n")) {
    const m = /^(title|occurredAt|context|createdAt|updatedAt):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[m[1] as keyof FrontMatter] = value;
  }
  return { meta, body };
}

function escapeYaml(value: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function serializeDoc(fields: {
  title: string;
  occurredAt: string;
  context: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}): string {
  const lines = [
    "---",
    `title: ${escapeYaml(fields.title)}`,
    `occurredAt: ${escapeYaml(fields.occurredAt)}`,
    `context: ${escapeYaml(fields.context)}`,
    `createdAt: ${escapeYaml(fields.createdAt)}`,
    `updatedAt: ${escapeYaml(fields.updatedAt)}`,
    "---",
    "",
    fields.body.replace(/^\n+/, ""),
  ];
  if (!fields.body.endsWith("\n") && fields.body.length > 0) lines.push("");
  return lines.join("\n");
}

function fileTitleFallback(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)) || "未命名心得";
}

function folderOf(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === ROOT_REL ? "" : dir.slice(ROOT_REL.length + 1);
}

async function walkFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isAssetsDirName(entry.name)) continue;
      await walkFiles(abs, root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    out.push(abs);
  }
}

async function readMetaFromFile(absolutePath: string, relativePath: string): Promise<ReflectionMeta> {
  const st = await stat(absolutePath);
  const raw = await readFile(absolutePath, "utf-8");
  const { meta } = parseFrontMatter(raw);
  const mtimeIso = st.mtime.toISOString();
  return {
    path: relativePath,
    title: (meta.title || "").trim() || fileTitleFallback(absolutePath),
    occurredAt: (meta.occurredAt || "").trim() || mtimeIso,
    context: (meta.context || "").trim(),
    folder: folderOf(relativePath),
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : { updatedAt: mtimeIso }),
  };
}

const EXCERPT_MAX = 80;

/**
 * 列表第二行的正文摘要：去掉 front matter 之外的结构标记，压成一行。
 * 语音卡整块跳过（:::aiclaw-audio[...] 包起来的转写不是正文），图片只留 alt。
 */
export function buildReflectionExcerpt(raw: string, max = EXCERPT_MAX): string {
  const { body } = parseFrontMatter(raw);
  const cleaned = body
    .replace(/:::aiclaw-audio\[[^\]]*\][\s\S]*?:::/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max).trimEnd()}…`;
}

function fileCreatedAt(st: { birthtime: Date; mtime: Date }): string {
  const birth = st.birthtime?.getTime?.() ?? 0;
  if (Number.isFinite(birth) && birth > 0) return st.birthtime.toISOString();
  return st.mtime.toISOString();
}

export async function listReflections(options: { q?: string; userDataDir?: string } = {}): Promise<ReflectionMeta[]> {
  await ensureReflectionsDirs(options.userDataDir);
  const root = reflectionsRoot(options.userDataDir);
  const base = getPaths(options.userDataDir).base;
  const files: string[] = [];
  await walkFiles(root, root, files);
  const items: ReflectionMeta[] = [];
  for (const abs of files) {
    const relativePath = normalizeRel(path.relative(base, abs));
    try {
      items.push(await readMetaFromFile(abs, relativePath));
    } catch {
      // skip unreadable
    }
  }
  const q = (options.q || "").trim().toLowerCase();
  const filtered = q
    ? items.filter((item) =>
      item.title.toLowerCase().includes(q)
      || item.context.toLowerCase().includes(q)
      || item.path.toLowerCase().includes(q))
    : items;
  filtered.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.path.localeCompare(b.path));
  return filtered;
}

export async function readReflection(inputPath: string, userDataDir?: string): Promise<ReflectionDoc> {
  const { relativePath, absolutePath } = resolveReflectionPath(inputPath, userDataDir);
  try {
    const raw = await readFile(absolutePath, "utf-8");
    const { meta, body } = parseFrontMatter(raw);
    const st = await stat(absolutePath);
    const mtimeIso = st.mtime.toISOString();
    return {
      path: relativePath,
      title: (meta.title || "").trim() || fileTitleFallback(absolutePath),
      occurredAt: (meta.occurredAt || "").trim() || mtimeIso,
      context: (meta.context || "").trim(),
      folder: folderOf(relativePath),
      body: body.replace(/^\n+/, ""),
      ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
      ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : { updatedAt: mtimeIso }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReflectionsError("文件不存在或已被删除", 404);
    throw error;
  }
}

function sanitizeFilename(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return cleaned || "未命名心得";
}

function sanitizeFolderName(name: string): string {
  return String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

async function uniqueMdPath(
  absoluteFolder: string,
  relativeFolder: string,
  title: string,
  allowAbsolute?: string,
): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const baseName = sanitizeFilename(title);
  const allow = allowAbsolute ? path.resolve(allowAbsolute) : "";
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? `${baseName}.md` : `${baseName}_${i + 1}.md`;
    const absolutePath = path.join(absoluteFolder, name);
    if (allow && path.resolve(absolutePath) === allow) {
      return { absolutePath, relativePath: normalizeRel(`${relativeFolder}/${name}`) };
    }
    try {
      await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { absolutePath, relativePath: normalizeRel(`${relativeFolder}/${name}`) };
      }
      throw error;
    }
  }
  throw new ReflectionsError("无法生成唯一文件名", 400);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

/** 历史版本留在 data 根下，不进心得树，也不会被移动/改名操作带走。 */
const HISTORY_DIR = ".reflection-history";
/** 只留最近几版，够应对误保存/误删；长期归档靠 NAS 快照或 git。 */
const HISTORY_KEEP = 3;

function historyDirFor(relativePath: string, userDataDir?: string): string {
  return path.join(getPaths(userDataDir).base, HISTORY_DIR, relativePath);
}

/** 覆盖或删除前先把当前版本存一份，防止误覆盖后无法找回。 */
async function snapshotBeforeChange(relativePath: string, userDataDir?: string): Promise<void> {
  const { absolutePath } = resolveReflectionPath(relativePath, userDataDir);
  try {
    const raw = await readFile(absolutePath, "utf-8");
    const dir = historyDirFor(relativePath, userDataDir);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let target = path.join(dir, `${stamp}.md`);
    for (let seq = 1; seq < 1000; seq += 1) {
      try {
        await stat(target);
        target = path.join(dir, `${stamp}-${seq}.md`);
      } catch {
        break;
      }
    }
    await writeAtomic(target, raw);
    const entries = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - HISTORY_KEEP))) {
      await rm(path.join(dir, stale)).catch(() => undefined);
    }
  } catch {
    // 备份失败不阻断正常写入
  }
}

export async function createReflection(input: {
  title: string;
  body?: string;
  occurredAt?: string;
  context?: string;
  folder?: string;
  userDataDir?: string;
}): Promise<ReflectionDoc> {
  await ensureReflectionsDirs(input.userDataDir);
  const title = String(input.title || "").trim();
  if (!title) throw new ReflectionsError("标题不能为空", 400);
  const { relativeFolder, absoluteFolder } = resolveFolder(input.folder, input.userDataDir);
  await mkdir(absoluteFolder, { recursive: true });
  const { absolutePath, relativePath } = await uniqueMdPath(absoluteFolder, relativeFolder, title);
  const now = new Date().toISOString();
  const occurredAt = (input.occurredAt || "").trim() || now;
  const context = String(input.context || "").trim();
  const body = String(input.body || "");
  const content = serializeDoc({
    title,
    occurredAt,
    context,
    createdAt: now,
    updatedAt: now,
    body,
  });
  await writeAtomic(absolutePath, content);
  return readReflection(relativePath, input.userDataDir);
}

export async function updateReflection(input: {
  path: string;
  title?: string;
  body?: string;
  occurredAt?: string;
  context?: string;
  userDataDir?: string;
}): Promise<ReflectionDoc> {
  const current = await readReflection(input.path, input.userDataDir);
  const { absolutePath, relativePath } = resolveReflectionPath(input.path, input.userDataDir);
  const now = new Date().toISOString();
  const st = await stat(absolutePath);
  const title = input.title !== undefined ? String(input.title).trim() : current.title;
  if (!title) throw new ReflectionsError("标题不能为空", 400);
  let bodyText = input.body !== undefined ? String(input.body) : current.body;
  // 客户端 bug 曾用空串覆盖整篇正文；已有内容时不接受「清空式」保存（真要删光需先写占位再删）。
  if (
    input.body !== undefined
    && !bodyText.trim()
    && current.body.trim().length > 0
  ) {
    bodyText = current.body;
  }

  // .txt 先视为同主名 .md，再决定是否因标题改名
  let workAbs = absolutePath;
  let workRel = relativePath;
  const wasTxt = path.extname(absolutePath).toLowerCase() === ".txt";
  if (wasTxt) {
    workAbs = absolutePath.replace(/\.txt$/i, ".md");
    workRel = relativePath.replace(/\.txt$/i, ".md");
  }

  let destAbs = workAbs;
  let destRel = workRel;
  const oldStem = reflectionStem(workRel);
  const desiredStem = sanitizeFilename(title);
  if (desiredStem !== oldStem) {
    const folderAbs = path.dirname(workAbs);
    const folderRel = path.posix.dirname(workRel);
    const unique = await uniqueMdPath(folderAbs, folderRel, title, workAbs);
    destAbs = unique.absolutePath;
    destRel = unique.relativePath;
    bodyText = rewriteAssetsPrefixInBody(bodyText, oldStem, reflectionStem(destRel));
  }

  const content = serializeDoc({
    title,
    occurredAt: input.occurredAt !== undefined ? String(input.occurredAt).trim() || current.occurredAt : current.occurredAt,
    context: input.context !== undefined ? String(input.context).trim() : current.context,
    createdAt: current.createdAt || fileCreatedAt(st),
    updatedAt: now,
    body: bodyText,
  });
  await snapshotBeforeChange(relativePath, input.userDataDir);
  await writeAtomic(destAbs, content);
  if (destAbs !== absolutePath) {
    await rm(absolutePath).catch(() => undefined);
  }
  if (assetsDirRelativeNeedsMove(relativePath, destRel)) {
    await moveAssetsPair(relativePath, destRel, input.userDataDir);
  }
  return readReflection(destRel, input.userDataDir);
}

function assetsDirRelativeNeedsMove(fromRel: string, toRel: string): boolean {
  return (
    path.posix.dirname(fromRel) !== path.posix.dirname(toRel)
    || reflectionStem(fromRel) !== reflectionStem(toRel)
  );
}

export async function deleteReflection(inputPath: string, userDataDir?: string): Promise<void> {
  const { absolutePath, relativePath } = resolveReflectionPath(inputPath, userDataDir);
  await snapshotBeforeChange(relativePath, userDataDir);
  try {
    await rm(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReflectionsError("文件不存在或已被删除", 404);
    throw error;
  }
  await deleteAssetsPair(relativePath, userDataDir);
}

export type ReflectionTreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  title?: string;
  excerpt?: string;
  noteCount?: number;
  occurredAt?: string;
  updatedAt?: string;
  createdAt?: string;
  context?: string;
  children?: ReflectionTreeNode[];
};

/** 文件夹徽标上的数字：本篇与所有子文件夹里的笔记总数。 */
function countNotesIn(nodes: ReflectionTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === "file") total += 1;
    else if (node.children) total += countNotesIn(node.children);
  }
  return total;
}

async function buildTree(absDir: string, relDir: string, userDataDir?: string): Promise<ReflectionTreeNode[]> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nodes: ReflectionTreeNode[] = [];
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = normalizeRel(`${relDir}/${entry.name}`);
    if (entry.isDirectory()) {
      if (isAssetsDirName(entry.name)) continue;
      const children = await buildTree(abs, rel, userDataDir);
      nodes.push({
        name: entry.name,
        path: rel,
        kind: "directory",
        noteCount: countNotesIn(children),
        children,
      });
      continue;
    }
    if (!entry.isFile() || !TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const meta = await readMetaFromFile(abs, rel);
      const raw = await readFile(abs, "utf-8");
      nodes.push({
        name: entry.name,
        path: rel,
        kind: "file",
        title: meta.title,
        excerpt: buildReflectionExcerpt(raw),
        occurredAt: meta.occurredAt,
        updatedAt: meta.updatedAt,
        createdAt: meta.createdAt,
        context: meta.context,
      });
    } catch {
      // skip
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (a.kind === "directory") return a.name.localeCompare(b.name, "zh-CN");
    return (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.name.localeCompare(b.name, "zh-CN");
  });
  return nodes;
}

export async function listReflectionTree(userDataDir?: string): Promise<ReflectionTreeNode[]> {
  await ensureReflectionsDirs(userDataDir);
  const root = reflectionsRoot(userDataDir);
  return buildTree(root, ROOT_REL, userDataDir);
}

export async function mkdirReflection(folder: string, userDataDir?: string): Promise<{ path: string }> {
  await ensureReflectionsDirs(userDataDir);
  const { relativeFolder, absoluteFolder } = resolveFolder(folder, userDataDir);
  await mkdir(absoluteFolder, { recursive: true });
  return { path: relativeFolder };
}

async function assertRealFolder(folderPath: string, userDataDir?: string): Promise<{ relativePath: string; absolutePath: string }> {
  const resolved = resolveReflectionPath(folderPath, userDataDir);
  if (resolved.relativePath === ROOT_REL) {
    throw new ReflectionsError("不能操作心得根目录", 400);
  }
  if (isAssetsDirName(path.basename(resolved.absolutePath))) {
    throw new ReflectionsError("不能操作附件目录", 400);
  }
  let st;
  try {
    st = await stat(resolved.absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReflectionsError("文件夹不存在或已被删除", 404);
    }
    throw error;
  }
  if (!st.isDirectory()) throw new ReflectionsError("不是文件夹", 400);
  return resolved;
}

/** 文件夹改名（连同里面的笔记与附件一起移动，正文里的相对引用不变）。 */
export async function renameReflectionFolder(input: {
  path: string;
  name?: string;
  userDataDir?: string;
}): Promise<{ path: string }> {
  const { relativePath, absolutePath } = await assertRealFolder(input.path, input.userDataDir);
  const name = sanitizeFolderName(input.name || "");
  if (!name) throw new ReflectionsError("文件夹名不能为空", 400);
  const parentRel = path.posix.dirname(relativePath);
  const destRel = normalizeRel(`${parentRel}/${name}`);
  const { absolutePath: destAbs } = resolveReflectionPath(destRel, input.userDataDir);
  if (destAbs === absolutePath) return { path: relativePath };
  try {
    await stat(destAbs);
    throw new ReflectionsError("已存在同名文件夹", 409);
  } catch (error) {
    if (error instanceof ReflectionsError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(absolutePath, destAbs);
  return { path: destRel };
}

/** 删除文件夹及其中的全部笔记与附件。 */
export async function deleteReflectionFolder(folderPath: string, userDataDir?: string): Promise<void> {
  const { absolutePath } = await assertRealFolder(folderPath, userDataDir);
  await rm(absolutePath, { recursive: true, force: true });
}

export async function moveReflection(input: {
  from: string;
  toFolder?: string;
  toPath?: string;
  userDataDir?: string;
}): Promise<ReflectionDoc> {
  const { absolutePath: fromAbs, relativePath: fromRel } = resolveReflectionPath(input.from, input.userDataDir);
  const baseName = path.basename(fromAbs);
  let destRel: string;
  let destAbs: string;
  if (input.toPath) {
    const resolved = resolveReflectionPath(input.toPath, input.userDataDir);
    destRel = resolved.relativePath;
    destAbs = resolved.absolutePath;
  } else {
    const { relativeFolder, absoluteFolder } = resolveFolder(input.toFolder || "inbox", input.userDataDir);
    await mkdir(absoluteFolder, { recursive: true });
    destAbs = path.join(absoluteFolder, baseName);
    destRel = normalizeRel(`${relativeFolder}/${baseName}`);
    assertUnderRoot(destAbs, reflectionsRoot(input.userDataDir));
  }
  if (destAbs === fromAbs) return readReflection(fromRel, input.userDataDir);
  try {
    await stat(destAbs);
    throw new ReflectionsError("目标已存在同名文件", 409);
  } catch (error) {
    if (error instanceof ReflectionsError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(destAbs), { recursive: true });
  await rename(fromAbs, destAbs);
  await moveAssetsPair(fromRel, destRel, input.userDataDir);
  return readReflection(destRel, input.userDataDir);
}

/** 按 occurredAt 的年/月归入 YYYY/MM（东八墙钟优先）。 */
export async function organizeReflectionByDate(inputPath: string, userDataDir?: string): Promise<ReflectionDoc> {
  const doc = await readReflection(inputPath, userDataDir);
  const stamp = doc.occurredAt;
  const cn = /^(\d{4})-(\d{2})/.exec(stamp);
  let year = "";
  let month = "";
  if (cn) {
    year = cn[1];
    month = cn[2];
  } else {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) throw new ReflectionsError("无法解析发生时刻", 400);
    // 用 UTC+8 墙钟
    const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    year = String(shifted.getUTCFullYear());
    month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  }
  return moveReflection({ from: doc.path, toFolder: `${year}/${month}`, userDataDir });
}

export async function importReflections(input: {
  text?: string;
  sourcePath?: string;
  folder?: string;
  dryRun?: boolean;
  deleteSource?: boolean;
  userDataDir?: string;
}): Promise<{ items: Array<{ title: string; occurredAt?: string; context?: string; body: string }>; reflections?: ReflectionDoc[] }> {
  let text = input.text ?? "";
  if (input.sourcePath) {
    const { absolutePath } = resolveReflectionPath(input.sourcePath, input.userDataDir);
    text = await readFile(absolutePath, "utf-8");
  }
  const items = parseReflectionPaste(text);
  if (input.dryRun) return { items };

  const reflections: ReflectionDoc[] = [];
  for (const item of items) {
    reflections.push(await createReflection({
      title: item.title,
      body: item.body,
      occurredAt: item.occurredAt,
      context: item.context,
      folder: input.folder || "inbox",
      userDataDir: input.userDataDir,
    }));
  }
  if (input.deleteSource && input.sourcePath) {
    await deleteReflection(input.sourcePath, input.userDataDir);
  }
  return { items, reflections };
}
