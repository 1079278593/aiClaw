/**
 * Pending 提案的 HTTP 接口（5 条）：
 *
 *   GET  /api/pending                 列表 + 角标
 *   GET  /api/pending/:id             详情（meta + base + proposed）
 *   POST /api/pending/:id/apply       应用（支持 dryRun）
 *   POST /api/pending/:id/dismiss     丢弃（status=expired）
 *   GET  /api/reflections/index?path= 该层索引（读前先 L1 校准）
 */

import { getPaths } from "../../config/paths.js";
import { applyAllProposals, applyProposal } from "../../pending/apply.js";
import {
  countOpenPending,
  dismissProposal,
  listPending,
  PendingError,
  readPendingDetail,
} from "../../pending/store.js";
import { calibrateDirs, INDEX_FILENAME, listIndexableDirs } from "../../index/indexer.js";
import { getReflectionsStore } from "../../reflections/store.js";
import { normalizeRel, resolveReflectionPath, ReflectionsError } from "../../reflections/paths.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

const PENDING_ID_RE = /^\/api\/pending\/([A-Za-z0-9-]+)(?:\/(apply|dismiss))?$/;

export const handlePendingRoutes: RouteHandler = async ({ req, res, url }) => {
  try {
    if (url.pathname === "/api/pending" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      const items = await listPending({ status });
      sendJson(res, { items, badge: await countOpenPending() });
      return true;
    }

    if (url.pathname === "/api/reflections/index" && req.method === "GET") {
      const rawPath = url.searchParams.get("path") ?? "reflections";
      const { relativePath, absolutePath } = resolveReflectionPath(rawPath);
      // 读前先跑 L1 校准：这是「索引可以被信任」的唯一入口（read 工具永不触发）。
      const writer = getReflectionsStore().indexWriter;
      const calibration = await calibrateDirs([absolutePath], writer, { baseDir: getPaths().base });
      const entries = await readIndexEntries(absolutePath);
      sendJson(res, {
        path: normalizeRel(relativePath),
        indexFile: INDEX_FILENAME,
        entries,
        indexSynced: calibration.indexSynced,
      });
      return true;
    }

    if (url.pathname === "/api/reflections/index/rebuild" && req.method === "POST") {
      // 一次性动作（plan §16）：对 reflections 与 knowledge_base 各层递归跑一遍校准。
      // 不做常驻、不加 watcher；迁移完成后点一次即可补齐所有 `_index.md`。
      const writer = getReflectionsStore().indexWriter;
      const paths = getPaths();
      const targets = [paths.reflections, paths.knowledgeBase];
      const dirs: string[] = [];
      for (const target of targets) {
        dirs.push(...await listIndexableDirs(target));
      }
      const calibration = await calibrateDirs(dirs, writer, { baseDir: paths.base, reason: "calibrate-all" });
      sendJson(res, {
        ok: calibration.indexSynced,
        scanned: dirs.length,
        rewritten: calibration.rewritten.length,
        clean: calibration.clean.length,
        failedDirs: calibration.failedDirs,
        reason: "calibrate-all",
      });
      return true;
    }

    // 批量应用必须在 `:id` 匹配之前（否则 "apply-all" 会被当成 id）。
    if (url.pathname === "/api/pending/apply-all" && req.method === "POST") {
      const body = await readJsonBody<{ ids?: unknown; dryRun?: boolean }>(req).catch(() => ({}) as { ids?: unknown; dryRun?: boolean });
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.length > 0) : undefined;
      const result = await applyAllProposals({ ids, dryRun: body.dryRun === true });
      // 批量不是原子操作：始终 200，用 items 逐条表达结果，前端自己渲染冲突。
      sendJson(res, result);
      return true;
    }

    const match = PENDING_ID_RE.exec(url.pathname);
    if (match) {
      const id = match[1];
      const action = match[2];

      if (!action && req.method === "GET") {
        const detail = await readPendingDetail(id);
        sendJson(res, { meta: detail.meta, base: detail.base, proposed: detail.proposed });
        return true;
      }

      if (action === "apply" && req.method === "POST") {
        const body = await readJsonBody<{ dryRun?: boolean }>(req).catch(() => ({ dryRun: false }));
        const result = await applyProposal(id, { dryRun: body.dryRun === true });
        if (result.ok) {
          sendJson(res, result.status === "applied"
            ? { ok: true, status: result.status, path: result.path, indexSynced: result.indexSynced, ...(result.idempotent ? { idempotent: true } : {}) }
            : { ok: true, status: result.status, bytes: result.bytes, diffLines: result.diffLines });
          return true;
        }
        if ("error" in result && result.error === "pending not found") {
          sendJson(res, { error: "pending not found" }, 404);
          return true;
        }
        if ("error" in result && result.error === "conflict") {
          sendJson(res, {
            ok: false,
            error: "conflict",
            target: result.target,
            baseHash: result.baseHash,
            currentHash: result.currentHash,
          }, 409);
          return true;
        }
        // stale 是正常生命周期状态：用 200 表达。
        sendJson(res, { ok: false, status: "stale", reason: (result as { reason: string }).reason });
        return true;
      }

      if (action === "dismiss" && req.method === "POST") {
        const meta = await dismissProposal(id);
        sendJson(res, { ok: true, meta });
        return true;
      }
    }
  } catch (error) {
    if (error instanceof PendingError) {
      sendJson(res, { error: error.message }, error.statusCode);
      return true;
    }
    if (error instanceof ReflectionsError) {
      sendJson(res, { error: error.message }, error.statusCode);
      return true;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, { error: "请求不是 JSON" }, 400);
      return true;
    }
    sendJson(res, { error: (error as Error).message || "请求失败" }, 400);
    return true;
  }

  if (url.pathname === "/api/pending" || url.pathname.startsWith("/api/pending/")) return false;
  return false;
};

async function readIndexEntries(absDir: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const raw = await fs.readFile(path.join(absDir, INDEX_FILENAME), "utf-8").catch(() => "");
  return raw.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}
