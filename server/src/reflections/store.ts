/**
 * 心得落盘：真相源为 reflections 文件树；无 index.json。
 *
 * 索引同步通过可注入的 `IndexWriter` 协作对象完成（见 plan §5.6）：
 * 业务层收到 `ok: false` 只记录 `needsIndexSync` 并透传 `indexSynced: false`，
 * 不重试、不回滚、不冒泡成错误。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import {
  compareNameZh,
  createIndexWriter,
  ensureIndexFiles,
  isAssetsDirName as isIndexAssetsDirName,
  isSystemMetaFile,
  listChildEntries,
  noopIndexWriter,
  type IndexSyncReason,
  type IndexWriter,
} from "../index/indexer.js";
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

/** 每个写操作都返回索引同步结果，调用方据此透传给前端。 */
export type IndexSynced = { indexSynced: boolean };

export async function ensureReflectionsDirs(userDataDir?: string): Promise<void> {
  const root = reflectionsRoot(userDataDir);
  const inbox = path.join(root, "inbox");
  await mkdir(inbox, { recursive: true });
  await ensureIndexFiles(root);
  await ensureIndexFiles(inbox);
}

/**
 * 空目录也要有空 `_index.md`；已存在的索引不动（避免每次启动都写盘）。
 * 实现在 `index/indexer.ts`，此处保留导出以兼容既有调用点与测试。
 */
export { ensureIndexFiles } from "../index/indexer.js";

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

function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {  const text = stripBom(raw).replace(/\r\n/g, "\n");
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
    // `_index.md` 是系统元数据，不属于用户内容。
    if (isSystemMetaFile(entry.name)) continue;
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

// ---- store 工厂：索引写入是唯一被「协作对象化」的部分 ----

export type ReflectionsStore = ReturnType<typeof createReflectionsStore>;

export type ReflectionsStoreOptions = {
  indexWriter?: IndexWriter;
  userDataDir?: string;
};

/**
 * 创建心得 store。
 *
 * 注意：只把「索引同步」这一处协作对象化，其余函数保持原有导出签名，
 * 这样 `listReflections` 等仍可在任意位置单独调用。
 */
export function createReflectionsStore(options: ReflectionsStoreOptions = {}) {
  const userDataDir = options.userDataDir;
  // 索引作用域必须跟着 store 的数据目录走，否则注入 userDataDir 的场景会写错树。
  const indexWriter = options.indexWriter ?? createIndexWriter({ baseDir: () => getPaths(userDataDir).base });

  async function syncDirs(dirs: string[], reason: IndexSyncReason): Promise<boolean> {
    const result = await indexWriter.syncDirs(dirs, reason);
    return result.ok;
  }

  async function syncPaths(relativePaths: string[], reason: IndexSyncReason): Promise<boolean> {
    const base = getPaths(userDataDir).base;
    const dirs = relativePaths
      .filter(Boolean)
      .map((rel) => path.resolve(base, path.posix.dirname(normalizeRel(rel))));
    return syncDirs(dirs, reason);
  }

  async function listReflections(opts: { q?: string; userDataDir?: string } = {}): Promise<ReflectionMeta[]> {
    await ensureReflectionsDirs(opts.userDataDir ?? userDataDir);
    const root = reflectionsRoot(opts.userDataDir ?? userDataDir);
    const base = getPaths(opts.userDataDir ?? userDataDir).base;
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
    const q = (opts.q || "").trim().toLowerCase();
    const filtered = q
      ? items.filter((item) =>
        item.title.toLowerCase().includes(q)
        || item.context.toLowerCase().includes(q)
        || item.path.toLowerCase().includes(q))
      : items;
    filtered.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.path.localeCompare(b.path));
    return filtered;
  }

  async function readReflection(inputPath: string, dir?: string): Promise<ReflectionDoc> {
    const { relativePath, absolutePath } = resolveReflectionPath(inputPath, dir ?? userDataDir);
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

  async function createReflection(input: {
    title: string;
    body?: string;
    occurredAt?: string;
    context?: string;
    folder?: string;
    userDataDir?: string;
    /** 批量导入时先跳过逐条索引，收尾统一重写一次（plan §13.2 第 20 条）。 */
    skipIndexSync?: boolean;
  }): Promise<ReflectionDoc & IndexSynced> {
    const dir = input.userDataDir ?? userDataDir;
    await ensureReflectionsDirs(dir);
    const title = String(input.title || "").trim();
    if (!title) throw new ReflectionsError("标题不能为空", 400);
    const { relativeFolder, absoluteFolder } = resolveFolder(input.folder, dir);
    await mkdir(absoluteFolder, { recursive: true });
    await ensureIndexFiles(absoluteFolder);
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
    const indexSynced = input.skipIndexSync ? true : await syncPaths([relativePath], "create");
    return { ...(await readReflection(relativePath, dir)), indexSynced };
  }

  async function updateReflection(input: {
    path: string;
    title?: string;
    body?: string;
    occurredAt?: string;
    context?: string;
    userDataDir?: string;
  }): Promise<ReflectionDoc & IndexSynced> {
    const dir = input.userDataDir ?? userDataDir;
    const current = await readReflection(input.path, dir);
    const { absolutePath, relativePath } = resolveReflectionPath(input.path, dir);
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
    await writeAtomic(destAbs, content);
    if (destAbs !== absolutePath) {
      await rm(absolutePath).catch(() => undefined);
    }
    if (assetsDirRelativeNeedsMove(relativePath, destRel)) {
      await moveAssetsPair(relativePath, destRel, dir);
    }
    const indexSynced = await syncPaths([relativePath, destRel], "rename");
    return { ...(await readReflection(destRel, dir)), indexSynced };
  }

  async function deleteReflection(inputPath: string, dir?: string): Promise<IndexSynced> {
    const workingDir = dir ?? userDataDir;
    const { absolutePath, relativePath } = resolveReflectionPath(inputPath, workingDir);
    try {
      await rm(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReflectionsError("文件不存在或已被删除", 404);
      throw error;
    }
    await deleteAssetsPair(relativePath, workingDir);
    const indexSynced = await syncPaths([relativePath], "delete");
    return { indexSynced };
  }

  async function buildTree(absDir: string, relDir: string): Promise<ReflectionTreeNode[]> {
    // 过滤规则与索引共用 listChildEntries，此处只保留「读 meta / 排序」的差异。
    const entries = await listChildEntries(absDir);
    const nodes: ReflectionTreeNode[] = [];
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = normalizeRel(`${relDir}/${entry.name}`);
      if (entry.isDir) {
        const children = await buildTree(abs, rel);
        nodes.push({
          name: entry.name,
          path: rel,
          kind: "directory",
          noteCount: countNotesIn(children),
          children,
        });
        continue;
      }
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
      if (a.kind === "directory") return compareNameZh(a.name, b.name);
      return (b.updatedAt || "").localeCompare(a.updatedAt || "") || compareNameZh(a.name, b.name);
    });
    return nodes;
  }

  async function listReflectionTree(dir?: string): Promise<ReflectionTreeNode[]> {
    await ensureReflectionsDirs(dir ?? userDataDir);
    const root = reflectionsRoot(dir ?? userDataDir);
    return buildTree(root, ROOT_REL);
  }

  async function mkdirReflection(folder: string, dir?: string): Promise<{ path: string } & IndexSynced> {
    const workingDir = dir ?? userDataDir;
    await ensureReflectionsDirs(workingDir);
    const { relativeFolder, absoluteFolder } = resolveFolder(folder, workingDir);
    await mkdir(absoluteFolder, { recursive: true });
    // 新目录要建自己的空 _index.md，同时父层加一行。
    await ensureIndexFiles(absoluteFolder);
    const indexSynced = await syncDirs([path.dirname(absoluteFolder)], "create");
    return { path: relativeFolder, indexSynced };
  }

  async function renameReflectionFolder(input: {
    path: string;
    name?: string;
    userDataDir?: string;
  }): Promise<{ path: string } & IndexSynced> {
    const workingDir = input.userDataDir ?? userDataDir;
    const { relativePath, absolutePath } = await assertRealFolder(input.path, workingDir);
    const name = sanitizeFolderName(input.name || "");
    if (!name) throw new ReflectionsError("文件夹名不能为空", 400);
    const parentRel = path.posix.dirname(relativePath);
    const destRel = normalizeRel(`${parentRel}/${name}`);
    const { absolutePath: destAbs } = resolveReflectionPath(destRel, workingDir);
    if (destAbs === absolutePath) return { path: relativePath, indexSynced: true };
    try {
      await stat(destAbs);
      throw new ReflectionsError("已存在同名文件夹", 409);
    } catch (error) {
      if (error instanceof ReflectionsError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(absolutePath, destAbs);
    // 父层改一行；目录自身索引跟着目录走，不需要动。
    const indexSynced = await syncDirs([path.dirname(absolutePath)], "rename");
    return { path: destRel, indexSynced };
  }

  async function deleteReflectionFolder(folderPath: string, dir?: string): Promise<IndexSynced> {
    const workingDir = dir ?? userDataDir;
    const { absolutePath } = await assertRealFolder(folderPath, workingDir);
    await rm(absolutePath, { recursive: true, force: true });
    const indexSynced = await syncDirs([path.dirname(absolutePath)], "delete");
    return { indexSynced };
  }

  async function moveReflection(input: {
    from: string;
    toFolder?: string;
    toPath?: string;
    userDataDir?: string;
  }): Promise<ReflectionDoc & IndexSynced> {
    const workingDir = input.userDataDir ?? userDataDir;
    const { absolutePath: fromAbs, relativePath: fromRel } = resolveReflectionPath(input.from, workingDir);
    const baseName = path.basename(fromAbs);
    let destRel: string;
    let destAbs: string;
    if (input.toPath) {
      const resolved = resolveReflectionPath(input.toPath, workingDir);
      destRel = resolved.relativePath;
      destAbs = resolved.absolutePath;
    } else {
      const { relativeFolder, absoluteFolder } = resolveFolder(input.toFolder || "inbox", workingDir);
      await mkdir(absoluteFolder, { recursive: true });
      await ensureIndexFiles(absoluteFolder);
      destAbs = path.join(absoluteFolder, baseName);
      destRel = normalizeRel(`${relativeFolder}/${baseName}`);
      assertUnderRoot(destAbs, reflectionsRoot(workingDir));
    }
    if (destAbs === fromAbs) {
      return { ...(await readReflection(fromRel, workingDir)), indexSynced: true };
    }
    try {
      await stat(destAbs);
      throw new ReflectionsError("目标已存在同名文件", 409);
    } catch (error) {
      if (error instanceof ReflectionsError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(destAbs), { recursive: true });
    await rename(fromAbs, destAbs);
    await moveAssetsPair(fromRel, destRel, workingDir);
    const indexSynced = await syncPaths([fromRel, destRel], "move");
    return { ...(await readReflection(destRel, workingDir)), indexSynced };
  }

  /** 按 occurredAt 的年/月归入 YYYY/MM（东八墙钟优先）。 */
  async function organizeReflectionByDate(inputPath: string, dir?: string): Promise<ReflectionDoc & IndexSynced> {
    const workingDir = dir ?? userDataDir;
    const doc = await readReflection(inputPath, workingDir);
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
    return moveReflection({ from: doc.path, toFolder: `${year}/${month}`, userDataDir: workingDir });
  }

  async function importReflections(input: {
    text?: string;
    sourcePath?: string;
    folder?: string;
    dryRun?: boolean;
    deleteSource?: boolean;
    userDataDir?: string;
  }): Promise<{ items: Array<{ title: string; occurredAt?: string; context?: string; body: string }>; reflections?: Array<ReflectionDoc & IndexSynced> }> {
    const workingDir = input.userDataDir ?? userDataDir;
    let text = input.text ?? "";
    if (input.sourcePath) {
      const { absolutePath } = resolveReflectionPath(input.sourcePath, workingDir);
      text = await readFile(absolutePath, "utf-8");
    }
    const items = parseReflectionPaste(text);
    if (input.dryRun) return { items };

    const reflections: Array<ReflectionDoc & IndexSynced> = [];
    for (const item of items) {
      reflections.push(await createReflection({
        title: item.title,
        body: item.body,
        occurredAt: item.occurredAt,
        context: item.context,
        folder: input.folder || "inbox",
        userDataDir: workingDir,
        // 批量导入：逐条跳过索引，收尾一次性重写受影响层（见下方）。
        skipIndexSync: items.length > 1,
      }));
    }

    // 批量后只重算一次受影响层：收集目录 → 去重 → 串行重写（writer 内部也会去重）。
    if (reflections.length > 0) {
      const base = getPaths(workingDir).base;
      const dirs = reflections.map((item) => path.dirname(path.resolve(base, item.path)));
      const ok = await syncDirs(dirs, "create");
      for (const item of reflections) item.indexSynced = ok;
    }
    if (input.deleteSource && input.sourcePath) {
      await deleteReflection(input.sourcePath, workingDir);
    }
    return { items, reflections };
  }

  return {
    indexWriter,
    ensureReflectionsDirs: (dir?: string) => ensureReflectionsDirs(dir ?? userDataDir),
    listReflections,
    readReflection,
    createReflection,
    updateReflection,
    deleteReflection,
    listReflectionTree,
    mkdirReflection,
    renameReflectionFolder,
    deleteReflectionFolder,
    moveReflection,
    organizeReflectionByDate,
    importReflections,
    syncDirs,
  };
}

// ---- 默认实例：保持原有导出签名，其余模块可以继续按函数调用 ----

let defaultStore: ReflectionsStore | null = null;

export function getReflectionsStore(): ReflectionsStore {
  defaultStore ??= createReflectionsStore();
  return defaultStore;
}

/** 测试用：注入 stub writer 后再取默认实例。 */
export function setReflectionsStore(store: ReflectionsStore | null): void {
  defaultStore = store;
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

function assetsDirRelativeNeedsMove(fromRel: string, toRel: string): boolean {
  return (
    path.posix.dirname(fromRel) !== path.posix.dirname(toRel)
    || reflectionStem(fromRel) !== reflectionStem(toRel)
  );
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

// ---- 函数式导出：转发到默认 store ----

export const listReflections = (options: { q?: string; userDataDir?: string } = {}) =>
  getReflectionsStore().listReflections(options);
export const readReflection = (inputPath: string, userDataDir?: string) =>
  getReflectionsStore().readReflection(inputPath, userDataDir);
export const createReflection = (input: Parameters<ReflectionsStore["createReflection"]>[0]) =>
  getReflectionsStore().createReflection(input);
export const updateReflection = (input: Parameters<ReflectionsStore["updateReflection"]>[0]) =>
  getReflectionsStore().updateReflection(input);
export const deleteReflection = (inputPath: string, userDataDir?: string) =>
  getReflectionsStore().deleteReflection(inputPath, userDataDir);
export const listReflectionTree = (userDataDir?: string) =>
  getReflectionsStore().listReflectionTree(userDataDir);
export const mkdirReflection = (folder: string, userDataDir?: string) =>
  getReflectionsStore().mkdirReflection(folder, userDataDir);
export const renameReflectionFolder = (input: Parameters<ReflectionsStore["renameReflectionFolder"]>[0]) =>
  getReflectionsStore().renameReflectionFolder(input);
export const deleteReflectionFolder = (folderPath: string, userDataDir?: string) =>
  getReflectionsStore().deleteReflectionFolder(folderPath, userDataDir);
export const moveReflection = (input: Parameters<ReflectionsStore["moveReflection"]>[0]) =>
  getReflectionsStore().moveReflection(input);
export const organizeReflectionByDate = (inputPath: string, userDataDir?: string) =>
  getReflectionsStore().organizeReflectionByDate(inputPath, userDataDir);
export const importReflections = (input: Parameters<ReflectionsStore["importReflections"]>[0]) =>
  getReflectionsStore().importReflections(input);

export { isAssetsDirName, isSystemMetaFile, listChildEntries, compareNameZh, noopIndexWriter };
