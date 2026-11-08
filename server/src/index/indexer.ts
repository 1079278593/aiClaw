/**
 * 目录级结构索引 `_index.md`。
 *
 * 三条硬性约定（见 plan §5）：
 * 1. 唯一写入者是服务端；Agent 只读，默认不注入上下文。
 * 2. 索引是派生物：写失败不回滚文件、不阻断业务，靠 L1 校准自愈。
 * 3. 过滤规则只实现一次（`listChildEntries`），索引与 `view=tree` 共用。
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";

export const INDEX_FILENAME = "_index.md";

/** 系统元数据文件名：所有遍历都必须忽略它。 */
export function isSystemMetaFile(name: string): boolean {
  return name === INDEX_FILENAME;
}

/** 心得媒体目录（`某篇.assets`）：属于某篇的附属，不是可导航层级。 */
export function isAssetsDirName(name: string): boolean {
  return name.endsWith(".assets");
}

const BLACKLIST = new Set([".DS_Store", "Thumbs.db", "@eaDir", "node_modules", "dist", "build"]);
const INDEXABLE_EXT = new Set([".md", ".txt"]);

export type ChildEntry = { name: string; isDir: boolean };

/**
 * 列出一个目录的「可索引直接子项」，已应用全部过滤：
 * 点开头、黑名单、非 .md/.txt 文件、`*.assets/`、`_index.md` 自身。
 * 返回 readdir 顺序，不排序（排序是调用方的事）。
 */
export async function listChildEntries(absDir: string): Promise<ChildEntry[]> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: ChildEntry[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || BLACKLIST.has(name)) continue;
    if (isSystemMetaFile(name)) continue;
    if (entry.isDirectory()) {
      if (isAssetsDirName(name)) continue;
      out.push({ name, isDir: true });
      continue;
    }
    if (!entry.isFile()) continue;
    if (!INDEXABLE_EXT.has(path.extname(name).toLowerCase())) continue;
    out.push({ name, isDir: false });
  }
  return out;
}

/** 索引与树的公共名称比较器：中文序、数字自然序、大小写不敏感、忽略标点。 */
export function compareNameZh(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base", ignorePunctuation: true });
}

/** 渲染一层索引内容：目录在前，各按中文名排序；空目录 = 空文件。 */
export function renderIndex(entries: ChildEntry[]): string {
  const dirs = entries.filter((entry) => entry.isDir).map((entry) => entry.name).sort(compareNameZh);
  const files = entries.filter((entry) => !entry.isDir).map((entry) => entry.name).sort(compareNameZh);
  if (dirs.length === 0 && files.length === 0) return "";
  return [...dirs.map((name) => `${name}/`), ...files].join("\n") + "\n";
}

export type IndexSyncReason = "apply" | "create" | "move" | "delete" | "rename" | "calibrate" | "calibrate-all";

/**
 * 索引写入的协作对象。
 *
 * 契约：`syncDirs` **绝不抛异常**，失败以返回值表达，业务层据此只做两件事——
 * 记 `needsIndexSync`、把 `indexSynced: false` 透传出去。
 */
export interface IndexWriter {
  syncDirs(dirs: string[], reason: IndexSyncReason): Promise<IndexSyncResult>;
}

export type IndexSyncResult = { ok: boolean; failedDirs: string[]; error?: string };

/** 绝对路径去重并按字典序排队，保证两个请求不会同时重写同一层。 */
function normalizeDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    seen.add(path.resolve(dir));
  }
  return [...seen].sort();
}

export type IndexWriterOptions = {
  /**
   * 覆盖根路径解析，便于测试。默认从 paths 取。
   *
   * 允许传函数：默认实例是进程级单例，而 `AICLAW_DATA_DIR` / tenant 作用域
   * 是按请求切换的——若在创建时快照路径，换租户后索引会写到上一个数据目录。
   */
  baseDir?: string | (() => string);
  /** 允许写入索引的根（默认 reflections 与 knowledge_base）。 */
  indexRoots?: string[];
  /** 用于日志；默认不输出。 */
  onError?: (dir: string, error: Error) => void;
};

/**
 * 生产实现：内部维护按目录串行队列，去重后逐层重写。
 * 任何失败都被收敛成 `{ ok: false, failedDirs }`。
 */
export function createIndexWriter(options: IndexWriterOptions = {}): IndexWriter {
  const resolveBase = typeof options.baseDir === "function"
    ? options.baseDir
    : () => options.baseDir as string;
  const base = () => resolveBase() ?? getPaths().base;
  const roots = (indexRoots?: string[]) => (indexRoots ?? ["reflections", "knowledge_base"])
    .map((root) => path.resolve(base(), root));
  const queues = new Map<string, Promise<void>>();

  function insideIndexRoots(dir: string): boolean {
    const resolved = path.resolve(dir);
    return roots(options.indexRoots).some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  async function writeOne(dir: string): Promise<void> {
    const entries = await listChildEntries(dir);
    const content = renderIndex(entries);
    const file = path.join(dir, INDEX_FILENAME);
    const current = await readFile(file, "utf-8").catch(() => null);
    if (current === content) return;
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, file);
  }

  function enqueue(dir: string): Promise<void> {
    const previous = queues.get(dir) ?? Promise.resolve();
    const next = previous.then(() => writeOne(dir), () => writeOne(dir));
    queues.set(dir, next.then(() => undefined, () => undefined));
    return next;
  }

  return {
    async syncDirs(dirs: string[], _reason: IndexSyncReason): Promise<IndexSyncResult> {
      const failedDirs: string[] = [];
      let firstError: string | undefined;
      for (const dir of normalizeDirs(dirs)) {
        // 只索引 reflections/ 与 knowledge_base/：people、distill、pending 从不放 _index.md。
        if (!insideIndexRoots(dir)) continue;
        try {
          await enqueue(dir);
        } catch (error) {
          failedDirs.push(path.relative(base(), dir).replaceAll("\\", "/"));
          firstError ??= (error as Error).message;
          options.onError?.(dir, error as Error);
        }
      }
      return failedDirs.length === 0
        ? { ok: true, failedDirs: [] }
        : { ok: false, failedDirs, ...(firstError ? { error: firstError } : {}) };
    },
  };
}

/**
 * 空目录也要有空 `_index.md`；已存在的索引不动（避免每次启动都写盘）。
 * 只建空文件，不预生成条目（plan §2.3）。
 */
export async function ensureIndexFiles(absDir: string): Promise<void> {
  const file = path.join(absDir, INDEX_FILENAME);
  try {
    await stat(file);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  await writeFile(file, "", "utf-8").catch(() => undefined);
}

/**
 * 为「应当有索引」的根补齐索引文件：`reflections/`、`reflections/inbox/`、
 * `knowledge_base/`。`people/`、`distill/` 不放索引（plan §5.5）。
 *
 * 目录不存在时先建出来——初始化阶段调用，不会误创建用户没要的目录。
 */
export async function ensureIndexRoots(baseDir: string): Promise<void> {
  const dirs = [
    path.join(baseDir, "reflections"),
    path.join(baseDir, "reflections", "inbox"),
    path.join(baseDir, "knowledge_base"),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    await ensureIndexFiles(dir);
  }
}

/** 禁用的 writer：所有写入都被视为成功（用于不关心索引的场景）。 */
export const noopIndexWriter: IndexWriter = {
  async syncDirs() {
    return { ok: true, failedDirs: [] };
  },
};

export type CalibrationResult = {
  /** 实际被重写的层。 */
  rewritten: string[];
  /** 索引与 readdir 一致的层。 */
  clean: string[];
  indexSynced: boolean;
  failedDirs: string[];
};

/**
 * L1 校准：对该层做 `readdir` + 现状比较，只在确有差异时经 `IndexWriter` 重写。
 *
 * 差异检测本身不写盘，可以直接用 fs；只有「确认有差异 → 重写」这一步必须经过
 * 注入的 writer —— 否则「stub 让索引失败 → L1 自愈」的测试会假通过。
 */
export async function calibrateDirs(
  dirs: string[],
  writer: IndexWriter,
  options: { baseDir?: string; reason?: IndexSyncReason } = {},
): Promise<CalibrationResult> {
  const base = options.baseDir ?? getPaths().base;
  const candidates = normalizeDirs(dirs);  const stale: string[] = [];
  const clean: string[] = [];
  for (const dir of candidates) {
    const entries = await listChildEntries(dir);
    const expected = renderIndex(entries);
    const file = path.join(dir, INDEX_FILENAME);
    const current = await readFile(file, "utf-8").catch(() => null);
    if (current === expected) clean.push(path.relative(base, dir).replaceAll("\\", "/"));
    else stale.push(dir);
  }
  if (stale.length === 0) {
    return { rewritten: [], clean, indexSynced: true, failedDirs: [] };
  }
  const result = await writer.syncDirs(stale, options.reason ?? "calibrate");
  return {
    rewritten: result.ok ? stale.map((dir) => path.relative(base, dir).replaceAll("\\", "/")) : [],
    clean,
    indexSynced: result.ok,
    failedDirs: result.failedDirs,
  };
}

/** 递归列出某区所有需要索引的目录（用于「重建索引」一次性动作）。 */
export async function listIndexableDirs(absDir: string, out: string[] = []): Promise<string[]> {
  let info;
  try {
    info = await stat(absDir);
  } catch {
    return out;
  }
  if (!info.isDirectory()) return out;
  out.push(absDir);
  const entries = await listChildEntries(absDir).catch(() => [] as ChildEntry[]);
  for (const entry of entries) {
    if (!entry.isDir) continue;
    await listIndexableDirs(path.join(absDir, entry.name), out);
  }
  return out;
}
