/**
 * 记忆存储（plan §8 方案 A）。
 *
 * 磁盘布局（每个 tenant）：
 * ```
 * agents/main/
 *   ├── AGENT.md                    # 宪法，AI 只读（ACL denied）
 *   ├── user.md                     # 画像正文（多条，`##` 分条）
 *   ├── runtime.md                  # 工作记忆正文（多条）
 *   ├── memory/
 *   │   ├── focus.md                # 关注点正文（多条）
 *   │   ├── longterm.md             # 长期记忆正文（多条）
 *   │   ├── index.jsonl             # 全部条目的元数据（一行一条）
 *   │   └── _archive/               # 覆盖前的兜底，每文件保留最近 3 份
 *   └── _archive/
 * ```
 *
 * 为什么正文与元数据分开：`used` / `lastUsed` 会在**每轮注入**时更新
 * （plan §8.2「`used` 仅在本轮确实注入时 +1」）。若元数据写在 Markdown 正文里，
 * 每轮对话都要重写整个 `longterm.md`；分开后每轮只追加一行 jsonl。
 *
 * 正文里 id 用不可见的 HTML 注释承载：
 * ```
 * ## 用户偏好简短回答
 *
 * <!-- memory:20260328T120000-ab12 -->
 *
 * 正文……
 * ```
 * 渲染时看不见，读源码时一眼可辨，手写条目漏了 id 也能在下次写入时补上。
 */

import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import {
  ARCHIVE_KEEP,
  LAYER_BYTE_MAX,
  MEMORY_LAYERS,
  MemoryError,
  type MemoryEntry,
  type MemoryEntryMeta,
  type MemoryImportance,
  type MemoryLayer,
  type MemoryWriter,
} from "./types.js";

function mainDir(userDataDir?: string): string {
  return getPaths(userDataDir).agentsMain;
}

function memoryDir(userDataDir?: string): string {
  return getPaths(userDataDir).agentMemory;
}

/** 某一层正文文件的绝对路径。 */
export function layerFile(layer: MemoryLayer, userDataDir?: string): string {
  if (layer === "user") return path.join(mainDir(userDataDir), "user.md");
  if (layer === "runtime") return path.join(mainDir(userDataDir), "runtime.md");
  return path.join(memoryDir(userDataDir), `${layer}.md`);
}

/** 元数据 jsonl 的绝对路径。 */
export function indexFile(userDataDir?: string): string {
  return path.join(memoryDir(userDataDir), "index.jsonl");
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const byte of randomBytes(2)) suffix += alphabet[byte % alphabet.length];
  return `${stamp}-${suffix}`;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// ---- 正文解析 ----

const ID_MARKER = /^<!--\s*memory:([A-Za-z0-9-]+)\s*-->$/;

/** 一条正文块：标题行之后的正文 + 可选 id。 */
export type MemoryBlock = { id: string | null; title: string; text: string };

/**
 * 解析一层正文为若干条目。
 *
 * 分隔规则只有一条：`## ` 开头的行是新条目的起点。文件头的说明文字（第一个
 * `## ` 之前的内容）不产生条目——用户可以在那里写「这一层放什么」。
 */
export function parseLayer(raw: string): MemoryBlock[] {
  const lines = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").split("\n");
  const blocks: MemoryBlock[] = [];
  let current: { id: string | null; title: string; body: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) blocks.push(finish(current));
      current = { id: null, title: line.slice(3).trim(), body: [] };
      continue;
    }
    if (!current) continue; // 文件头说明，忽略
    const marker = line.trim().match(ID_MARKER);
    if (marker) {
      current.id = marker[1];
      continue;
    }
    current.body.push(line);
  }
  if (current) blocks.push(finish(current));
  return blocks;
}

function finish(block: { id: string | null; title: string; body: string[] }): MemoryBlock {
  return {
    id: block.id,
    title: block.title,
    text: block.body.join("\n").trim(),
  };
}

/** 把条目渲染回 Markdown。`header` 是文件头说明（第一个 `##` 之前的内容）。 */
export function renderLayer(header: string, blocks: MemoryBlock[]): string {
  const parts: string[] = [];
  const head = header.trim();
  if (head) parts.push(head);
  for (const block of blocks) {
    const lines = [`## ${block.title}`];
    if (block.id) lines.push("", `<!-- memory:${block.id} -->`);
    if (block.text.trim()) lines.push("", block.text.trim());
    parts.push(lines.join("\n"));
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/** 取出文件头说明（第一个 `## ` 之前），写回时原样保留，避免吃掉用户的注释。 */
export function layerHeader(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").split("\n");
  const head: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) break;
    head.push(line);
  }
  return head.join("\n").trim();
}

/** 手写条目没有 id 时，用内容派生一个稳定 id，避免每次读都变。 */
export function deriveId(layer: MemoryLayer, block: MemoryBlock): string {
  const hash = createHash("sha256").update(`${layer}\n${block.title}\n${block.text}`).digest("hex");
  return `h-${hash.slice(0, 16)}`;
}

// ---- 元数据读写 ----

export async function readMetas(userDataDir?: string): Promise<MemoryEntryMeta[]> {
  const raw = await readText(indexFile(userDataDir));
  const metas: MemoryEntryMeta[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryEntryMeta>;
      if (!parsed.id || !parsed.layer) continue;
      metas.push({
        id: String(parsed.id),
        layer: parsed.layer as MemoryLayer,
        importance: (parsed.importance === "high" ? "high" : "medium") as MemoryImportance,
        created: String(parsed.created ?? new Date(0).toISOString()),
        lastUsed: String(parsed.lastUsed ?? parsed.created ?? new Date(0).toISOString()),
        used: Number(parsed.used) || 0,
        pinned: Boolean(parsed.pinned),
        writtenBy: (parsed.writtenBy ?? "user") as MemoryWriter,
        ...(parsed.sourceSessionId ? { sourceSessionId: String(parsed.sourceSessionId) } : {}),
      });
    } catch {
      // 坏行跳过：记忆元数据是派生信息，一行坏了不该让整层不可读。
    }
  }
  return metas;
}

export async function writeMetas(metas: MemoryEntryMeta[], userDataDir?: string): Promise<void> {
  const body = metas.length ? `${metas.map((meta) => JSON.stringify(meta)).join("\n")}\n` : "";
  await writeAtomic(indexFile(userDataDir), body);
}

// ---- 归档（plan §3.4：覆盖/删除前移入 _archive，保留最近 3 份）----

function archiveDir(layer: MemoryLayer, userDataDir?: string): string {
  if (layer === "user") return path.join(mainDir(userDataDir), "_archive");
  if (layer === "runtime") return path.join(mainDir(userDataDir), "_archive");
  return path.join(memoryDir(userDataDir), "_archive");
}

function archiveStamp(): string {
  // 精确到毫秒 + 随机后缀：同一进程内连续写入不能重名，否则后一份会覆盖前一份，
  // 「保留最近 3 份」就退化成「永远只有 1 份」。
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace("T", "").replace(".", "").replace("Z", "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const byte of randomBytes(2)) suffix += alphabet[byte % alphabet.length];
  return `${iso}-${suffix}`;
}

/**
 * 把当前正文存一份到 `_archive/<stamp>-<name>.md`，然后**修剪到只留最近 3 份**。
 * 失败不影响主流程（兜底文件丢了不该让写入失败）。
 */
async function archiveLayer(layer: MemoryLayer, userDataDir?: string): Promise<void> {
  const src = layerFile(layer, userDataDir);
  const content = await readText(src);
  if (!content.trim()) return;
  const dir = archiveDir(layer, userDataDir);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  const name = `${archiveStamp()}-${path.basename(src)}`;
  await writeFile(path.join(dir, name), content, "utf-8").catch(() => undefined);
  await pruneArchive(dir, path.basename(src));
}

/** 同一份文件的归档只保留最近 `ARCHIVE_KEEP` 份，按文件名（含时间戳）倒序。 */
async function pruneArchive(dir: string, baseName: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(`-${baseName}`));
  } catch {
    return;
  }
  if (names.length <= ARCHIVE_KEEP) return;
  const sorted = names.sort().reverse();
  for (const stale of sorted.slice(ARCHIVE_KEEP)) {
    await rm(path.join(dir, stale), { force: true }).catch(() => undefined);
  }
}

// ---- 体积上限（plan §3.4：超限拒绝写入并说明原因，不静默截断）----

export async function layerBytes(layer: MemoryLayer, userDataDir?: string): Promise<number> {
  const file = layerFile(layer, userDataDir);
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

const LAYER_LABEL: Record<MemoryLayer, string> = {
  runtime: "runtime.md",
  focus: "focus.md",
  user: "user.md",
  longterm: "longterm.md",
};

/** 写入前校验体积：超限时抛出带明确原因的错误，绝不截断。 */
async function assertWithinCap(layer: MemoryLayer, nextContent: string, userDataDir?: string): Promise<void> {
  const bytes = Buffer.byteLength(nextContent, "utf-8");
  const max = LAYER_BYTE_MAX[layer];
  void userDataDir;
  if (bytes <= max) return;
  throw new MemoryError(
    `${LAYER_LABEL[layer]} 已满（${bytes} / ${max} 字节），请先合并或归档再写入`,
    413,
  );
}

// ---- 对外读写 ----

/** 读一层的全部条目：正文（磁盘）× 元数据（jsonl），按 `id` 合并。 */
export async function readLayer(layer: MemoryLayer, userDataDir?: string): Promise<MemoryEntry[]> {
  const file = layerFile(layer, userDataDir);
  const raw = await readText(file);
  const blocks = parseLayer(raw);
  const metas = (await readMetas(userDataDir)).filter((meta) => meta.layer === layer);
  const byId = new Map(metas.map((meta) => [meta.id, meta]));

  return blocks.map((block) => {
    const id = block.id ?? deriveId(layer, block);
    const meta = byId.get(id);
    const created = meta?.created ?? new Date(0).toISOString();
    return {
      id,
      layer,
      importance: meta?.importance ?? "medium",
      created,
      lastUsed: meta?.lastUsed ?? created,
      used: meta?.used ?? 0,
      pinned: meta?.pinned ?? false,
      writtenBy: meta?.writtenBy ?? "user",
      ...(meta?.sourceSessionId ? { sourceSessionId: meta.sourceSessionId } : {}),
      text: block.title ? (block.text ? `${block.title}\n\n${block.text}` : block.title) : block.text,
    };
  });
}

export type AddEntryInput = {
  layer: MemoryLayer;
  text: string;
  importance?: MemoryImportance;
  pinned?: boolean;
  writtenBy?: MemoryWriter;
  sourceSessionId?: string;
};

/**
 * 追加一条记忆：写正文 + 写元数据。
 * 空内容视为 no-op（plan §3.3 对 digest 的同一条原则），不写盘。
 */
export async function addEntry(input: AddEntryInput, userDataDir?: string): Promise<MemoryEntry | null> {
  const text = String(input.text ?? "").trim();
  if (!text) return null;

  const layer = input.layer;
  const file = layerFile(layer, userDataDir);
  const raw = await readText(file);
  const blocks = parseLayer(raw);
  const metaRows = await readMetas(userDataDir);

  const id = newId();
  const textLines = text.split("\n");
  const firstLine = textLines[0].trim();
  // 标题只用于目录展示：过长时截断标题，但**正文必须保留全文**，
  // 否则超长内容会被静默吃掉（体积上限也就失效了）。
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  const rest = firstLine.length > 60
    ? `${textLines.slice(1).join("\n").trim()}\n\n${textLines[0].trim()}`.trim()
    : textLines.slice(1).join("\n").trim();
  blocks.push({ id, title, text: rest });

  const next = renderLayer(layerHeader(raw), blocks);
  await assertWithinCap(layer, next, userDataDir);
  await archiveLayer(layer, userDataDir);
  await writeAtomic(file, next);

  const now = new Date().toISOString();
  const meta: MemoryEntryMeta = {
    id,
    layer,
    importance: input.importance ?? "medium",
    created: now,
    lastUsed: now,
    used: 0,
    pinned: Boolean(input.pinned),
    writtenBy: input.writtenBy ?? "agent",
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
  };
  await writeMetas([...metaRows, meta], userDataDir);

  return { ...meta, text };
}

/** 整体覆盖一层的正文（`focus.md` 这类「刷新」语义），保留文件头说明。 */
export async function replaceLayer(
  layer: MemoryLayer,
  text: string,
  options: { writtenBy?: MemoryWriter; sourceSessionId?: string } = {},
  userDataDir?: string,
): Promise<void> {
  const file = layerFile(layer, userDataDir);
  const raw = await readText(file);
  const blocks = text.trim() ? [{ id: newId(), title: "当前关注", text: text.trim() }] : [];
  const next = renderLayer(layerHeader(raw), blocks);
  await assertWithinCap(layer, next, userDataDir);
  await archiveLayer(layer, userDataDir);
  await writeAtomic(file, next);

  const metas = (await readMetas(userDataDir)).filter((meta) => meta.layer !== layer);
  const now = new Date().toISOString();
  for (const block of blocks) {
    metas.push({
      id: block.id as string,
      layer,
      importance: "medium",
      created: now,
      lastUsed: now,
      used: 0,
      pinned: true, // focus 恒定注入：它是「当前在关注什么」，不该被淘汰
      writtenBy: options.writtenBy ?? "user",
      ...(options.sourceSessionId ? { sourceSessionId: options.sourceSessionId } : {}),
    });
  }
  await writeMetas(metas, userDataDir);
}

/** 删除一条记忆（按 id）。正文与元数据同时清理，正文先归档。 */
export async function removeEntry(id: string, userDataDir?: string): Promise<boolean> {
  const metas = await readMetas(userDataDir);
  const target = metas.find((meta) => meta.id === id);
  if (!target) return false;

  const file = layerFile(target.layer, userDataDir);
  const raw = await readText(file);
  const blocks = parseLayer(raw).filter((block) => block.id !== id);
  await archiveLayer(target.layer, userDataDir);
  await writeAtomic(file, renderLayer(layerHeader(raw), blocks));
  await writeMetas(metas.filter((meta) => meta.id !== id), userDataDir);
  return true;
}

/**
 * 记录「这一轮真的注入了这些条目」：`used +1`、`lastUsed = now`。
 *
 * 只写 jsonl，不碰正文——这正是把元数据切出去的理由。
 */
export async function markInjected(ids: string[], now = new Date(), userDataDir?: string): Promise<void> {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  const stamp = now.toISOString();
  let changed = false;
  const metas = (await readMetas(userDataDir)).map((meta) => {
    if (!wanted.has(meta.id)) return meta;
    changed = true;
    return { ...meta, used: meta.used + 1, lastUsed: stamp };
  });
  if (changed) await writeMetas(metas, userDataDir);
}

/** 初始化：目录与空正文文件。空文件也建，让用户能直接打开写。 */
export async function ensureMemoryFiles(userDataDir?: string): Promise<void> {
  await mkdir(memoryDir(userDataDir), { recursive: true });
  await mkdir(path.join(memoryDir(userDataDir), "_archive"), { recursive: true });
  await mkdir(path.join(mainDir(userDataDir), "_archive"), { recursive: true });
  for (const layer of MEMORY_LAYERS) {
    const file = layerFile(layer, userDataDir);
    const existing = await readText(file);
    if (existing) continue;
    const header = `<!-- ${LAYER_LABEL[layer]}：${LAYER_HINT[layer]}。条目用二级标题分隔。 -->`;
    await writeAtomic(file, `${header}\n`);
  }
  const idx = indexFile(userDataDir);
  if (!(await readText(idx))) await writeAtomic(idx, "");
}

const LAYER_HINT: Record<MemoryLayer, string> = {
  runtime: "工作记忆（临时上下文，压缩时刷新）",
  focus: "当前关注点（恒定注入）",
  user: "用户画像",
  longterm: "长期记忆（按相关性检索注入）",
};
