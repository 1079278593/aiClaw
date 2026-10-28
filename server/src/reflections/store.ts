/**
 * 心得落盘：真相源为 inputs/reflections 文件树；无 index.json。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import { parseReflectionPaste } from "./parse.js";

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

export class ReflectionsError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const ROOT_REL = "inputs/reflections";
const TEXT_EXT = new Set([".md", ".txt"]);

export function reflectionsRoot(userDataDir?: string): string {
  return path.join(getPaths(userDataDir).inputs, "reflections");
}

export async function ensureReflectionsDirs(userDataDir?: string): Promise<void> {
  const root = reflectionsRoot(userDataDir);
  await mkdir(path.join(root, "inbox"), { recursive: true });
}

function normalizeRel(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function assertUnderRoot(abs: string, root: string): void {
  const resolved = path.resolve(abs);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new ReflectionsError("路径不允许", 400);
  }
}

/** 将用户传入的 path（完整相对或根内相对）解析为绝对路径与规范相对路径。 */
export function resolveReflectionPath(inputPath: string, userDataDir?: string): {
  relativePath: string;
  absolutePath: string;
  root: string;
} {
  const root = reflectionsRoot(userDataDir);
  let rel = normalizeRel(inputPath);
  if (rel === ROOT_REL || rel.startsWith(`${ROOT_REL}/`)) {
    // keep
  } else if (!rel.includes("..")) {
    rel = `${ROOT_REL}/${rel}`;
  } else {
    throw new ReflectionsError("路径不允许", 400);
  }
  if (rel.includes("..")) throw new ReflectionsError("路径不允许", 400);
  const absolutePath = path.resolve(getPaths(userDataDir).base, rel);
  assertUnderRoot(absolutePath, root);
  return { relativePath: normalizeRel(rel), absolutePath, root };
}

function resolveFolder(folder: string | undefined, userDataDir?: string): {
  relativeFolder: string;
  absoluteFolder: string;
} {
  const raw = normalizeRel(folder || "inbox") || "inbox";
  const withoutRoot = raw === ROOT_REL ? "" : raw.startsWith(`${ROOT_REL}/`) ? raw.slice(ROOT_REL.length + 1) : raw;
  if (withoutRoot.includes("..")) throw new ReflectionsError("路径不允许", 400);
  const relativeFolder = withoutRoot ? `${ROOT_REL}/${withoutRoot}` : ROOT_REL;
  const absoluteFolder = path.resolve(getPaths(userDataDir).base, relativeFolder);
  assertUnderRoot(absoluteFolder, reflectionsRoot(userDataDir));
  return { relativeFolder: normalizeRel(relativeFolder), absoluteFolder };
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

async function uniqueMdPath(absoluteFolder: string, relativeFolder: string, title: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const baseName = sanitizeFilename(title);
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? `${baseName}.md` : `${baseName}_${i + 1}.md`;
    const absolutePath = path.join(absoluteFolder, name);
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
  const title = input.title !== undefined ? String(input.title).trim() : current.title;
  if (!title) throw new ReflectionsError("标题不能为空", 400);
  const content = serializeDoc({
    title,
    occurredAt: input.occurredAt !== undefined ? String(input.occurredAt).trim() || current.occurredAt : current.occurredAt,
    context: input.context !== undefined ? String(input.context).trim() : current.context,
    createdAt: current.createdAt || now,
    updatedAt: now,
    body: input.body !== undefined ? String(input.body) : current.body,
  });
  // .txt 首次保存为同主名 .md
  let targetAbs = absolutePath;
  let targetRel = relativePath;
  if (path.extname(absolutePath).toLowerCase() === ".txt") {
    targetAbs = absolutePath.replace(/\.txt$/i, ".md");
    targetRel = relativePath.replace(/\.txt$/i, ".md");
    await writeAtomic(targetAbs, content);
    await rm(absolutePath).catch(() => undefined);
  } else {
    await writeAtomic(targetAbs, content);
  }
  return readReflection(targetRel, input.userDataDir);
}

export async function deleteReflection(inputPath: string, userDataDir?: string): Promise<void> {
  const { absolutePath } = resolveReflectionPath(inputPath, userDataDir);
  try {
    await rm(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReflectionsError("文件不存在或已被删除", 404);
    throw error;
  }
}

export type ReflectionTreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  title?: string;
  occurredAt?: string;
  context?: string;
  children?: ReflectionTreeNode[];
};

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
      nodes.push({
        name: entry.name,
        path: rel,
        kind: "directory",
        children: await buildTree(abs, rel, userDataDir),
      });
      continue;
    }
    if (!entry.isFile() || !TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const meta = await readMetaFromFile(abs, rel);
      nodes.push({
        name: entry.name,
        path: rel,
        kind: "file",
        title: meta.title,
        occurredAt: meta.occurredAt,
        context: meta.context,
      });
    } catch {
      // skip
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
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
