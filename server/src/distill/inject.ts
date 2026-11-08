/**
 * 蒸馏地图的注入（plan_distill §4 / §5 规则 C）。
 *
 * 只注入 `meta/overview.md` 一份，不注入具体摘要——地图告诉 Agent
 * 「有哪些摘要可用」，需要时它自己 `read`。这与索引「先看地图再下钻」同构。
 *
 * 与记忆的「联动」**只发生在这里**，而且是两条单向规则：
 * 1. 同一来源不重复注入：地图里某行指向的来源若已作为记忆注入，该行跳过；
 * 2. 预算共享：`distillMap` 与 `memory` 合计不超 `MEMORY_TOKEN_MAX`，
 *    超了先砍地图（它是加速层，记忆是事实）。
 *
 * 幂等性与安全性：
 * - 超过字节上限**整块丢弃**，绝不截断成半张表（半张地图比没有更误导）；
 * - 地图里被丢弃时返回空串，调用方按「没有这个块」处理。
 */

import { readOverview, OVERVIEW_BYTE_MAX } from "./store.js";

/** 估算 token：中文按 1 字 ≈ 1 token 偏保守，与 `chat/index.ts` 的口径保持一致。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

export type DistillMapInjection = {
  /** 注入用文本；空串表示不注入。 */
  text: string;
  /** 被丢弃的原因，便于日志与测试断言。 */
  skipped?: "disabled" | "empty" | "too-large" | "budget";
  bytes: number;
};

export type BuildDistillMapOptions = {
  /** 功能开关（`config.features.injectDistillMap`）；默认关闭。 */
  enabled?: boolean;
  userDataDir?: string;
  /** 记忆块已占用的 token 预算；地图只能吃剩下的。 */
  memoryTokensUsed?: number;
  /** 记忆 + 地图的合计上限；缺省不限制。 */
  budget?: number;
  /** 已作为记忆注入的来源路径，命中则从地图里删掉对应行。 */
  memorySources?: string[];
};

/**
 * 读地图并处理预算。
 *
 * 注意**不做** markdown 重排或内容改写：地图是给人也看得到的文件，
 * 注入时改动它会让「文件里写的」和「模型看到的」不一致，排查时极难解释。
 * 只要不超限就原样注入。
 */
export async function buildDistillMapInjection(
  options: BuildDistillMapOptions = {},
): Promise<DistillMapInjection> {
  const raw = await readOverview(options.userDataDir);
  const bytes = Buffer.byteLength(raw, "utf-8");

  if (raw.trim().length === 0) return { text: "", skipped: "empty", bytes };
  if (options.enabled === false) return { text: "", skipped: "disabled", bytes };
  if (bytes > OVERVIEW_BYTE_MAX) return { text: "", skipped: "too-large", bytes };

  const deduped = dropMemoryOverlap(raw, options.memorySources ?? []);
  if (!deduped.trim()) return { text: "", skipped: "empty", bytes };

  // 预算：地图在地图+记忆的合计里只能吃剩下的。
  if (options.budget !== undefined) {
    const used = options.memoryTokensUsed ?? 0;
    if (used + estimateTokens(deduped) > options.budget) {
      return { text: "", skipped: "budget", bytes };
    }
  }

  return { text: deduped.trim(), bytes };
}

/**
 * 删掉与已注入记忆重叠的来源行。
 *
 * 地图是 markdown 表格，行形如 `| 标题 | reflections/x.md | 2 | 2026-11-08 |`。
 * 只删「文件列命中 memorySources」的行，表头与分隔行保留——
 * 留一个空表比删掉整张表更诚实（说明「这里本来有摘要，但已在记忆里」）。
 */
export function dropMemoryOverlap(map: string, memorySources: string[]): string {
  if (memorySources.length === 0) return map;
  // 两边都过 `sourceKey`：地图里存的是摘要文件路径，记忆里存的是原文路径，
  // 只有按「文件名主干」比较才可能命中（目录与扩展名都可能不同）。
  const merged = new Set(memorySources.map((source) => sourceKey(source)));
  const lines = map.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) {
      out.push(line);
      continue;
    }
    // 表头与分隔行（`|---|`）永远保留。
    if (/^\|\s*-/.test(line) || /^\|\s*(主题|title)\s*\|/i.test(line)) {
      out.push(line);
      continue;
    }
    if (merged.has(distillRowSource(line))) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 从表格行里取「来源路径」。
 *
 * 我们的表格存的是**摘要文件**路径（`reflections/xxx.md`），而记忆的来源是
 * **原文**路径。两者的重叠判定只能靠文件名主干：见 `sourceKey`。
 */
function distillRowSource(line: string): string {
  const cells = line.split("|").map((cell) => cell.trim());
  // cells[0] 与最后一个是空（首尾竖线），所以文件列是 cells[2]。
  const file = cells[2] ?? "";
  return sourceKey(file);
}

/** 重叠加定的键：去掉目录与扩展名的文件名主干。 */
export function sourceKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.replace(/\.(md|txt)$/i, "");
}

/** 给预算报告用：地图实际占了多少 token。 */
export function distillMapTokens(text: string): number {
  return estimateTokens(text);
}
