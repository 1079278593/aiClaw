/**
 * Apply 提案：二路 + 哈希校验。
 *
 * 关键语义（plan §4.3 / §4.5）：
 * - commit 边界 = 「文件 + 本提案 meta」；索引不参与判定，失败只记 `needsIndexSync`；
 * - 内容写入失败是致命的（不碰索引）；索引写入失败是**普通返回值**，不重试、不回滚；
 * - baseHash 重定位不唯一时**不猜**，退 `stale` + `ambiguous-basehash`。
 */

import { randomBytes } from "node:crypto";
import { readFile, readdir, stat, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import { createIndexWriter, listChildEntries, type IndexWriter } from "../index/indexer.js";
import { createReflectionsStore } from "../reflections/store.js";
import {
  archiveProposal,
  contentForHash,
  hashForKind,
  listPending,
  normalizeRelative,
  readPendingDetail,
  readPendingMeta,
  writePendingMeta,
  type PendingMeta,
} from "./store.js";

export type ApplyResult =
  | { ok: true; status: "applied"; path: string; indexSynced: boolean; idempotent?: true }
  | { ok: true; status: "dry-run"; bytes: number; diffLines: number }
  | { ok: false; status: "stale"; reason: string }
  | { ok: false; error: "conflict"; target: string; baseHash: string; currentHash: string }
  | { ok: false; error: "pending not found" };

function relativeToBase(abs: string, base: string): string {
  return path.relative(base, abs).replaceAll("\\", "/");
}

/** 收集知识区内的所有可索引文本文件（不含 `_index.md` 与 `.assets/`）。 */
async function collectKnowledgeFiles(absDir: string, out: string[] = []): Promise<string[]> {
  const entries = await listChildEntries(absDir);
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDir) {
      await collectKnowledgeFiles(abs, out);
      continue;
    }
    out.push(abs);
  }
  return out;
}

type Relocation =
  | { kind: "found"; path: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

/**
 * baseHash 重定位：五级收敛。
 * 同目录同名 → 同目录唯一 → 前缀最长且严格长于第二名；否则 ambiguous（判 stale）。
 */
async function relocateByBaseHash(
  baseHash: string,
  kind: PendingMeta["kind"],
  target: string,
  renamedFrom: string | undefined,
  base: string,
): Promise<Relocation> {
  if (!baseHash) return { kind: "none" };
  const roots = [path.join(base, "reflections"), path.join(base, "knowledge_base")];
  const candidates: string[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await collectKnowledgeFiles(root);
    } catch {
      continue;
    }
    for (const file of files) {
      const raw = await readFile(file, "utf-8").catch(() => null);
      if (raw === null) continue;
      // 心得按正文比较：front matter 里的 updatedAt 每次保存都会变。
      if (hashForKind(kind, raw) === baseHash) candidates.push(file);
    }
  }
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "found", path: candidates[0] };

  const targetDir = path.posix.dirname(normalizeRelative(target));
  const fromBase = renamedFrom ? path.posix.basename(normalizeRelative(renamedFrom)) : "";
  const asRel = (abs: string) => relativeToBase(abs, base);

  if (fromBase) {
    const sameDirSameName = candidates.filter((abs) =>
      path.posix.dirname(asRel(abs)) === targetDir && path.posix.basename(asRel(abs)) === fromBase);
    if (sameDirSameName.length === 1) return { kind: "found", path: sameDirSameName[0] };
  }

  const sameDir = candidates.filter((abs) => path.posix.dirname(asRel(abs)) === targetDir);
  if (sameDir.length === 1) return { kind: "found", path: sameDir[0] };

  if (renamedFrom) {
    const prefix = normalizeRelative(renamedFrom);
    const scored = candidates
      .map((abs) => {
        const rel = asRel(abs);
        let shared = 0;
        while (shared < Math.min(rel.length, prefix.length) && rel[shared] === prefix[shared]) shared += 1;
        return { abs, score: shared };
      })
      .sort((a, b) => b.score - a.score);
    // 严格长于第二名才采用：并列即无法区分。
    if (scored.length >= 2 && scored[0].score > scored[1].score) return { kind: "found", path: scored[0].abs };
    if (scored.length === 1) return { kind: "found", path: scored[0].abs };
  }

  return { kind: "ambiguous" };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 改名的提案引用同步：只改本提案自己的字段，不扫描其他提案。 */
function rewriteMetaPaths(meta: PendingMeta, oldPath: string, newPath: string): PendingMeta {
  const rewrite = (value: string) => (value === oldPath ? newPath : value);
  return {
    ...meta,
    target: rewrite(meta.target),
    relatesTo: meta.relatesTo?.map((item) => ({ ...item, path: rewrite(item.path) })) ?? [],
  };
}

export type ApplyOptions = {
  dryRun?: boolean;
  /** 注入的索引写入器；缺省用真实实现。测试用 stub 覆盖失败分支。 */
  indexWriter?: IndexWriter;
  userDataDir?: string;
};

export async function applyProposal(id: string, options: ApplyOptions = {}): Promise<ApplyResult> {
  let meta: PendingMeta;
  try {
    meta = await readPendingMeta(id, options.userDataDir);
  } catch {
    return { ok: false, error: "pending not found" };
  }

  // 1. 已终结状态：直接返回，不改任何文件。
  if (meta.status === "applied" || meta.status === "expired") {
    return { ok: true, status: "applied", path: meta.target, indexSynced: true, idempotent: true };
  }
  if (meta.status === "stale") {
    return { ok: false, status: "stale", reason: "already stale" };
  }
  const base = getPaths(options.userDataDir).base;
  const detail = await readPendingDetail(id, options.userDataDir);
  let target = normalizeRelative(meta.target);
  let targetAbs = path.resolve(base, target);

  // 2. target 不存在 → renamedFrom 反查 → baseHash 全树重定位。
  //
  //    create 提案例外：它的 target 本来就**应该**不存在。若把 create 也塞进
  //    这套「目标找不到就重定位」的流程，baseHash 为空必然收敛到 none，
  //    每条新增提案都会被误判 stale(target-missing)——即新增类提案永远应用不了。
  if (meta.changeType === "create") {
    if (await exists(targetAbs)) {
      // 目标在提案之后被别人建出来了：按 create 的语义读当前内容走幂等/冲突判定。
      // 若内容不同则视为冲突，绝不覆盖别人新建的文件。
      const currentRaw = await readFile(targetAbs, "utf-8");
      const currentHash = hashForKind(meta.kind, currentRaw);
      if (currentHash !== meta.proposedHash) {
        return { ok: false, error: "conflict", target, baseHash: meta.baseHash, currentHash };
      }
      const now = new Date().toISOString();
      const next: PendingMeta = {
        ...meta,
        status: "applied",
        appliedAt: meta.appliedAt ?? now,
        settledAt: meta.settledAt ?? now,
      };
      await writePendingMeta(next, options.userDataDir);
      await archiveProposal(id, options.userDataDir);
      return { ok: true, status: "applied", path: target, indexSynced: true, idempotent: true };
    }
  } else if (!(await exists(targetAbs))) {
    const renameHint = await lookupRenamedFrom(target, options.userDataDir);
    let relocated: string | null = renameHint ? path.resolve(base, renameHint) : null;
    if (!relocated) {
      const lookup = await relocateByBaseHash(meta.baseHash, meta.kind, target, meta.renamedFrom, base);
      if (lookup.kind === "ambiguous") {
        const stale: PendingMeta = { ...meta, status: "stale", settledAt: new Date().toISOString() };
        await writePendingMeta(stale, options.userDataDir);
        return { ok: false, status: "stale", reason: "ambiguous-basehash" };
      }
      relocated = lookup.kind === "found" ? lookup.path : null;
    }
    if (!relocated || !(await exists(relocated))) {
      const stale: PendingMeta = { ...meta, status: "stale", settledAt: new Date().toISOString() };
      await writePendingMeta(stale, options.userDataDir);
      return { ok: false, status: "stale", reason: "target-missing" };
    }
    target = relativeToBase(relocated, base);
    targetAbs = relocated;
  }

  // create 提案走到这里时 target 必然不存在（存在的情形已在第 2 步处理完），
  // 因此没有「当前内容」可比：跳过幂等与冲突判定，直接进入写入。
  let currentRaw: string | null = null;
  let currentHash = "";
  if (meta.changeType !== "create") {
    currentRaw = await readFile(targetAbs, "utf-8");
    // 哈希口径与提案一致：reflection 只比正文，doc 比全文。
    currentHash = hashForKind(meta.kind, currentRaw);
  }

  // 3. 幂等：current == proposed → 视为已应用（正文已到位，且 fields 也已生效）。
  if (currentRaw !== null && currentHash === meta.proposedHash && fieldsAlreadyApplied(meta, currentRaw)) {
    const now = new Date().toISOString();
    const next: PendingMeta = {
      ...meta,
      status: "applied",
      appliedAt: meta.appliedAt ?? now,
      settledAt: meta.settledAt ?? now,
      target,
    };
    await writePendingMeta(next, options.userDataDir);
    await archiveProposal(id, options.userDataDir);
    return { ok: true, status: "applied", path: target, indexSynced: true, idempotent: true };
  }

  // 4. 哈希不匹配 → 冲突，不写。
  //    例外：正文已是提案内容但 front matter 字段还没写进去（例如只改标题）→ 继续走到第 5 步。
  if (meta.changeType === "update" && currentHash !== meta.baseHash && currentHash !== meta.proposedHash) {
    return { ok: false, error: "conflict", target, baseHash: meta.baseHash, currentHash };
  }

  if (options.dryRun) {
    const bytes = Buffer.byteLength(detail.proposed, "utf-8");
    const diffLines = countDiffLines(detail.base, detail.proposed);
    return { ok: true, status: "dry-run", bytes, diffLines };
  }

  // 5. 通过：按 target 写文件。索引写入失败只记 needsIndexSync，不回滚。
  const writer = options.indexWriter ?? createIndexWriter({ baseDir: base });
  const store = createReflectionsStore({ indexWriter: writer, userDataDir: options.userDataDir });
  let newPath = target;
  let indexSynced = true;

  if (meta.kind === "reflection") {
    if (meta.changeType === "create") {
      const dirOfTarget = path.posix.dirname(target);
      const folder = dirOfTarget === "." ? "" : dirOfTarget;
      const title = meta.fields.title || path.posix.basename(target, path.posix.extname(target));
      const created = await store.createReflection({
        title,
        body: detail.proposed,
        occurredAt: meta.fields.occurredAt,
        context: meta.fields.context,
        folder,
        userDataDir: options.userDataDir,
      });
      newPath = created.path;
      indexSynced = created.indexSynced;
    } else {
      const updated = await store.updateReflection({
        path: target,
        body: detail.proposed,
        title: meta.fields.title,
        context: meta.fields.context,
        occurredAt: meta.fields.occurredAt,
        userDataDir: options.userDataDir,
      });
      newPath = updated.path;
      indexSynced = updated.indexSynced;
    }
  } else {
    // doc：全文原子写，然后同步该层索引。
    await mkdir(path.dirname(targetAbs), { recursive: true });
    const tmp = `${targetAbs}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, detail.proposed, "utf-8");
    await rename(tmp, targetAbs);
    const sync = await writer.syncDirs([path.dirname(targetAbs)], "apply");
    indexSynced = sync.ok;
  }

  // commit 已达成：meta 更新 + 归档，此后的失败不回滚文件。
  if (newPath !== target) {
    meta = { ...rewriteMetaPaths(meta, target, newPath), renamedFrom: target };
  }
  const now = new Date().toISOString();
  const applied: PendingMeta = {
    ...meta,
    target: newPath,
    status: "applied",
    appliedAt: now,
    settledAt: now,
    ...(indexSynced ? {} : { needsIndexSync: true }),
  };
  await writePendingMeta(applied, options.userDataDir);
  await archiveProposal(id, options.userDataDir);

  return { ok: true, status: "applied", path: newPath, indexSynced };
}

/** 其他提案的 `renamedFrom` 反查（只读，不写回）。 */
async function lookupRenamedFrom(target: string, userDataDir?: string): Promise<string | null> {
  const archive = getPaths(userDataDir).pendingArchive;
  const root = getPaths(userDataDir).pending;
  const dirs = [root, archive];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      try {
        const meta = await readPendingMeta(entry.name, userDataDir === undefined ? undefined : userDataDir);
        if (meta.renamedFrom && normalizeRelative(meta.renamedFrom) === target) return meta.target;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** 读 front matter 里的单行字段（只用于判断「字段是否已落地」）。 */
function frontMatterField(raw: string, field: string): string {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return "";
  const match = new RegExp(`^${field}:\\s*(.*)$`, "m").exec(text.slice(4, end));
  if (!match) return "";
  return match[1].trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
}

/**
 * 提案带的 front matter 字段是否已经在文件里生效。
 * 正文相同但标题还没改时，不能算「已应用」，否则标题会永远丢掉。
 */
function fieldsAlreadyApplied(meta: PendingMeta, raw: string): boolean {
  if (meta.kind !== "reflection") return true;
  const title = (meta.fields.title ?? "").trim();
  if (title && frontMatterField(raw, "title") !== title) return false;
  const occurredAt = (meta.fields.occurredAt ?? "").trim();
  if (occurredAt && frontMatterField(raw, "occurredAt") !== occurredAt) return false;
  return true;
}

function countDiffLines(base: string, proposed: string): number {
  const a = base.split("\n");
  const b = proposed.split("\n");
  const setA = new Map<string, number>();
  for (const line of a) setA.set(line, (setA.get(line) ?? 0) + 1);
  let same = 0;
  for (const line of b) {
    const count = setA.get(line) ?? 0;
    if (count > 0) {
      same += 1;
      setA.set(line, count - 1);
    }
  }
  return Math.max(a.length, b.length) - same;
}

/** 批量应用的单条结果。 */
export type ApplyAllItem = {
  id: string;
  target: string;
  result: ApplyResult;
};

export type ApplyAllResult = {
  /** 逐条结果，顺序与传入 id 一致（未传 id 时按 createdAt 升序）。 */
  items: ApplyAllItem[];
  applied: number;
  stale: number;
  conflict: number;
  failed: number;
  /** 全部成功应用（含幂等已应用）才是 true。 */
  ok: boolean;
};

export type ApplyAllOptions = ApplyOptions & {
  /** 只应用这些 id；缺省为当前所有 open 提案。 */
  ids?: string[];
};

/**
 * 批量应用（plan §12.2「apply-all」）。
 *
 * 语义刻意保持**最笨**的一种，因为批量应用最容易在「部分成功」上骗人：
 *
 * 1. **顺序执行，单条独立**。前一条失败不中止后续——用户点「全部应用」时，
 *    期望的是「能应用的都应用」，而不是一条 stale 卡死整批。
 * 2. **冲突不吞**。每条都走完整的 `applyProposal`（含 baseHash 校验），
 *    所以「两个提案改同一文件」会真实地表现为：前者 applied、后者 stale/conflict。
 *    这里**不做**「基于第一个提案结果重算第二个」的合并——那是三路合并，
 *    做错了会静默覆盖用户内容，比让用户手动看第二条严重得多。
 * 3. **不预演后批量写**。每条独立提交，索引按层去重由 `IndexWriter` 兜底。
 *
 * 也因此这个接口**不是原子的**：调用方拿到 `items` 后应逐条展示结果，
 * 而不是把 `ok: false` 当成「什么都没发生」。
 */
export async function applyAllProposals(options: ApplyAllOptions = {}): Promise<ApplyAllResult> {
  let ids = options.ids;
  if (!ids) {
    const open = await listPending({ status: "open", userDataDir: options.userDataDir });
    // 旧提案先应用：新提案的 baseHash 更可能基于旧提案之前的内容，
    // 按创建时间正序能减少「新提案先落地导致旧提案 stale」的概率。
    ids = open
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => item.id);
  }

  const items: ApplyAllItem[] = [];
  let applied = 0;
  let stale = 0;
  let conflict = 0;
  let failed = 0;

  for (const id of ids) {
    let result: ApplyResult;
    try {
      result = await applyProposal(id, options);
    } catch (error) {
      // applyProposal 自称不抛异常，但真正失败时也不能让整批挂掉。
      result = { ok: false, status: "stale", reason: (error as Error).message };
    }
    let target = "";
    try {
      target = (await readPendingMeta(id, options.userDataDir)).target;
    } catch {
      target = "";
    }
    items.push({ id, target, result });
    if (result.ok && result.status === "applied") applied += 1;
    else if (!result.ok && "status" in result) stale += 1;
    else if (!result.ok && "error" in result && result.error === "conflict") conflict += 1;
    else failed += 1;
  }

  return {
    items,
    applied,
    stale,
    conflict,
    failed,
    ok: applied === items.length,
  };
}
