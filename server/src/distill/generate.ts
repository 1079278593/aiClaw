/**
 * 蒸馏生成（plan_distill §3.3 / §6）。
 *
 * 流程固定为五步，**任何一步失败都保留旧摘要**：
 * ```
 * 1. 收集来源（readdir + 按需读正文）
 * 2. 调 LLM 生成摘要
 * 3. 原子写摘要（先归档旧版本）
 * 4. 重建 meta/overview.md
 * ```
 *
 * 第 2 步失败**必须**直接返回、不写任何文件：蒸馏是缓存，
 * 宁可继续给过期内容，也不要出现一份「生成失败但文件被清空」的空摘要。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/index.js";
import { getProviderCredential, resolveModelThinking } from "../config/index.js";
import { getPaths } from "../config/paths.js";
import { createProvider } from "../llm/index.js";
import { logger } from "../logger/index.js";
import {
  classifyStaleness,
  newDistillId,
  parseDistillDoc,
  parseSources,
  refreshedAt,
  renderDistillDoc,
  type DistillDoc,
} from "./format.js";
import {
  distillFile,
  distillRoot,
  isDistillScope,
  rebuildOverview,
  titleOf,
  writeDistill,
  type DistillScope,
} from "./store.js";

/** 单次蒸馏最多汇入的原文份数：太多会让摘要变成目录，也烧 token。 */
export const MAX_SOURCES = 20;

/** 自动重算只处理这么多篇，避免首次启动把全部历史一次算完。 */
export const MAX_AUTO_ITEMS = 3;

/** 自动重算只碰「最近这么多天内刷新过」的摘要：更老的大概率已无人关心。 */
export const MAX_AUTO_AGE_DAYS = 30;

/** 单份来源正文截断长度：只取开头，避免一篇长文吃满预算。 */
export const SOURCE_CHAR_MAX = 6000;

export type GenerateInput = {
  scope: DistillScope;
  /** `scope` 下的相对路径，如 `agent-memory.md`（不含 scope）。 */
  relative: string;
  /** 主题标题；缺省按来源推断。 */
  title?: string;
  /** 来源路径（相对数据根），如 `reflections/inbox/a.md`。 */
  sources: string[];
  userDataDir?: string;
  config?: Config;
};

export type GenerateResult =
  | { ok: true; path: string; id: string; sources: number }
  | { ok: false; error: string };

/** 可注入的 LLM 调用点，测试用它替代真实模型。 */
export type Summarizer = (input: { title: string; sources: Array<{ path: string; text: string }> }) => Promise<string>;

const DISTILL_PROMPT = `你是一个知识蒸馏器。把下列原文压缩成一份主题摘要。

要求：
- 只写「这组原文在说什么」，不要评论、不要建议、不要复述原文的结构
- 3~8 行短段落，中文，不要标题、不要列表以外的格式
- 保留关键结论与术语；删掉举例、寒暄、重复内容
- 原文里没有的信息一律不要编造，宁可少写

主题：{{TITLE}}
`;

/**
 * 生成一篇摘要。
 *
 * `summarizer` 可注入：生产环境走真实 provider，测试里喂固定文本，
 * 这样「LLM 失败保留旧摘要」这条分支才测得出来。
 */
export async function generateDistill(
  input: GenerateInput,
  options: { summarizer?: Summarizer; now?: Date } = {},
): Promise<GenerateResult> {
  if (!isDistillScope(input.scope)) {
    return { ok: false, error: `未知的蒸馏范围：${input.scope}` };
  }
  const sources = normalizeSources(input.sources);
  if (sources.length === 0) {
    return { ok: false, error: "没有可用的来源，未生成摘要" };
  }
  if (sources.length > MAX_SOURCES) {
    return { ok: false, error: `来源过多（${sources.length} > ${MAX_SOURCES}），请先合并主题` };
  }

  const loaded: Array<{ path: string; text: string }> = [];
  const missing: string[] = [];
  for (const rel of sources) {
    const abs = path.resolve(getPaths(input.userDataDir).base, rel);
    const text = await readFile(abs, "utf-8").catch(() => null);
    if (text === null) {
      missing.push(rel);
      continue;
    }
    loaded.push({ path: rel, text: clip(text, SOURCE_CHAR_MAX) });
  }
  if (loaded.length === 0) {
    return { ok: false, error: "所有来源都读不到，未生成摘要" };
  }

  const title = input.title?.trim() || titleFromSources(loaded[0].path);
  const now = options.now ?? new Date();

  let summary: string;
  try {
    const summarize = options.summarizer ?? createLlmSummarizer(input.config);
    summary = await summarize({ title, sources: loaded });
  } catch (error) {
    // 关键：此处不写任何文件，旧摘要保持可用（plan_distill §8）。
    logger.warn(`distill: summarizer failed for ${input.scope}/${input.relative}: ${(error as Error).message}`);
    return { ok: false, error: `摘要生成失败：${(error as Error).message}` };
  }

  const body = renderBody(title, summary.trim(), sources, missing);
  const id = newDistillId(now);
  const content = renderDistillDoc(id, now, body);
  try {
    await writeDistill(input.scope, input.relative, content, { userDataDir: input.userDataDir, now });
  } catch (error) {
    return { ok: false, error: `写入失败：${(error as Error).message}` };
  }

  // 地图写失败不回滚摘要：具体文件已经能用，只是地图旧了（与索引 indexSynced 同构）。
  await rebuildOverview({ userDataDir: input.userDataDir, now }).catch((error: unknown) => {
    logger.warn(`distill: overview rebuild failed: ${(error as Error).message}`);
  });

  return { ok: true, path: `${input.scope}/${input.relative}`, id, sources: loaded.length };
}

/**
 * 归一化模型输出：去掉它自作主张加的标题、`## 摘要` 之类的重复小节。
 *
 * prompt 里已经写了「不要标题」，但**不能靠模型自律**：真实模型经常照抄
 * `# 主题` 与 `## 摘要`，直接拼进 `renderBody` 就会出现「# 标题 / ## 摘要 /
 * # 标题 / ## 摘要」的双层结构。这里只削掉开头的标题与相邻的空摘要小节，
 * 正文里后续的小标题一律保留。
 */
function normalizeSummary(summary: string): string {
  const lines = summary.replace(/\r\n/g, "\n").split("\n");
  // 1. 削掉开头的 `# 标题`（可能不止一个，也可能带空行）。
  while (lines.length) {
    const first = lines[0].trim();
    if (!first) { lines.shift(); continue; }
    if (/^#{1,2}\s+/.test(first)) { lines.shift(); continue; }
    break;
  }
  // 2. 削掉紧跟着的 `## 摘要`（模型常见的第二段重复）。
  while (lines.length) {
    const first = lines[0].trim();
    if (!first) { lines.shift(); continue; }
    if (/^#{1,3}\s*摘要\s*$/.test(first)) { lines.shift(); continue; }
    break;
  }
  return lines.join("\n").trim();
}

/** 正文结构固定，Agent 才知道「来源」小节在哪（`parseSources` 依赖它）。 */
function renderBody(title: string, summary: string, sources: string[], missing: string[]): string {
  const body = normalizeSummary(summary);
  const lines = [`# ${title}`, "", "## 摘要", "", body, "", "## 来源", ""];
  for (const rel of sources) lines.push(`- ${rel}`);
  if (missing.length) {
    lines.push("", "## 缺失来源", "");
    for (const rel of missing) lines.push(`- ${rel}`);
  }
  return lines.join("\n");
}

function normalizeSources(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const rel = raw.replaceAll("\\", "/").replace(/^\/+/, "").trim();
    if (!rel || rel.includes("..") || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}

function titleFromSources(first: string | undefined): string {
  if (!first) return "未命名主题";
  return path.basename(first).replace(/\.(md|txt)$/i, "");
}

/** 生产用 summarizer：按 compaction 相同的 provider 解析方式取模型。 */
export function createLlmSummarizer(config?: Config): Summarizer {
  return async ({ title, sources }) => {
    if (!config) throw new Error("未提供配置，无法调用模型");
    const providerName = config.compaction.provider;
    const model = config.compaction.model;
    if (!providerName || !model) throw new Error("未配置蒸馏所用的 provider/model");

    const credential = getProviderCredential(config, providerName);
    const provider = createProvider(providerName);
    const thinking = resolveModelThinking(config, providerName, model, config.compaction.thinkingEffort);
    const corpus = sources
      .map((source) => `### ${source.path}\n\n${source.text}`)
      .join("\n\n");

    const response = await provider.complete(credential.apiKey, [
      {
        id: "system",
        role: "system",
        content: DISTILL_PROMPT.replace("{{TITLE}}", title),
        timestamp: new Date().toISOString(),
      },
      {
        id: "user",
        role: "user",
        content: corpus,
        timestamp: new Date().toISOString(),
      },
    ], {
      model,
      baseUrl: credential.baseUrl,
      maxTokens: 2048,
      thinkingEffort: thinking.level,
      thinkingParams: thinking.params,
    });

    const content = (response.content ?? "").trim();
    if (!content) throw new Error("模型返回空摘要");
    return content;
  };
}

// ---- 过期扫描（plan_distill §3.2 / §6） ----

export type StaleSummary = {
  /** `distill/` 下的相对路径。 */
  file: string;
  staleness: "stale" | "unknown";
  reason: string;
};

/**
 * 扫描全部摘要，找出过期的。
 *
 * 只做判定、**不重算**——重算必须由用户点击或 Agent 显式调用触发。
 * `unknown`（头时间解析不了）也返回，但调用方应只展示、不自动覆盖。
 */
export async function scanStaleSummaries(options: {
  userDataDir?: string;
  now?: Date;
} = {}): Promise<StaleSummary[]> {
  const root = distillRoot(options.userDataDir);
  const base = getPaths(options.userDataDir).base;
  const out: StaleSummary[] = [];

  for (const scope of ["reflections", "knowledge"] as const) {
    const files = await listFiles(path.join(root, scope));
    for (const abs of files) {
      const raw = await readFile(abs, "utf-8").catch(() => "");
      const doc = parseDistillDoc(raw);
      if (!doc.id) continue; // 无头文件不属于系统
      const sourceList = parseSources(doc.body);
      let newest: Date | null = null;
      let missing = 0;
      for (const rel of sourceList) {
        const info = await stat(path.resolve(base, rel)).catch(() => null);
        if (!info) {
          missing += 1;
          continue;
        }
        if (!newest || info.mtime > newest) newest = info.mtime;
      }
      const staleness = classifyStaleness({
        header: doc,
        newestSourceMtime: newest,
        missingSources: missing,
      });
      if (staleness === "stale" || staleness === "unknown") {
        out.push({
          file: path.relative(root, abs).replaceAll("\\", "/"),
          staleness,
          reason: staleness === "unknown"
            ? "头里的时间不可解析，无法判断是否过期"
            : missing > 0
              ? `有 ${missing} 个来源已不存在`
              : "来源在上次刷新后改动过",
        });
      }
    }
  }
  return out;
}

async function listFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "_archive") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(abs));
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

/** 供外部判断「这份摘要是不是该重算」：只有 `stale` 才自动重算。 */
export function shouldAutoRefresh(staleness: string): boolean {
  return staleness === "stale";
}

/**
 * 启动时的自动重算（plan_distill §6 表格第 3 行）。
 *
 * 计划原文写的是「过期且**最近 30 天被读过**」，但这里没有读取记录的数据源
 * ——蒸馏文件是普通 markdown，读它走的是通用 `read` 工具，没有钩子能记录。
 * 与其编一个假的「读过」标记，这里改用**可观测的等价条件**：
 *
 * - 只刷 `stale`：来源在上次刷新后确实改过（`unknown` 不刷，它意味着头坏了）；
 * - 只刷**最近 `MAX_AUTO_AGE_DAYS` 天内刷新过**的：太久没动过的主题大概率
 *   已经没人关心，自动重算它纯属烧钱；
 * - 单轮最多 `MAX_AUTO_ITEMS` 篇，避免首次启动把全部历史一次算完；
 * - 只处理**有头**的摘要（`id` 存在），手写文件永不碰。
 *
 * 任何一篇失败都只记日志并继续——蒸馏是缓存，坏一份不该拖垮整轮。
 */
export async function autoRefreshStaleDistill(options: {
  tenantDir: string;
  config?: Config;
  now?: Date;
  summarizer?: Summarizer;
  maxItems?: number;
  log?: (message: string) => void;
}): Promise<{ refreshed: string[]; failed: string[]; skipped: number }> {
  const now = options.now ?? new Date();
  const limit = Math.max(0, options.maxItems ?? MAX_AUTO_ITEMS);
  const log = options.log ?? (() => undefined);
  const refreshed: string[] = [];
  const failed: string[] = [];
  let skipped = 0;

  const stale = await scanStaleSummaries({ userDataDir: options.tenantDir, now });
  for (const item of stale) {
    if (!shouldAutoRefresh(item.staleness)) continue;
    if (refreshed.length + failed.length >= limit) break;

    const abs = path.join(distillRoot(options.tenantDir), item.file);
    // 只自动重算自己生成的（有头）摘要：手写笔记不在系统管理范围内。
    const raw = await readFile(abs, "utf-8").catch(() => "");
    const doc = parseDistillDoc(raw);
    if (!doc.id) continue;

    const age = refreshAgeOfDoc(doc, now);
    if (age === null || age > MAX_AUTO_AGE_DAYS) { skipped += 1; continue; }

    const [scope, ...rest] = item.file.split("/");
    if (!isDistillScope(scope) || rest.length === 0) continue;
    const sources = parseSources(doc.body);
    if (sources.length === 0) { skipped += 1; continue; }

    const result = await generateDistill({
      scope,
      relative: rest.join("/"),
      title: titleOf(doc.body, rest.join("/")),
      sources,
      userDataDir: options.tenantDir,
      config: options.config,
    }, {
      now,
      ...(options.summarizer ? { summarizer: options.summarizer } : {}),
    });

    if (result.ok) refreshed.push(item.file);
    else {
      failed.push(item.file);
      log(`distill auto-refresh failed for ${item.file}: ${result.error}`);
    }
  }

  return { refreshed, failed, skipped };
}

/** 摘要距上次刷新多少天；无头或时间不可解析时返回 `null`。 */
function refreshAgeOfDoc(doc: DistillDoc, now: Date): number | null {
  const at = refreshedAt(doc);
  if (!at) return null;
  return (now.getTime() - at.getTime()) / (24 * 60 * 60 * 1000);
}

/** 判断一个路径是否是系统生成的摘要（有 `id`）。 */
export async function isOwnedSummary(abs: string): Promise<boolean> {
  const raw = await readFile(abs, "utf-8").catch(() => "");
  if (!raw) return false;
  const doc = parseDistillDoc(raw);
  return Boolean(doc.id);
}

/** 读摘要并在过期时给出提示（用于注入前的轻量检查）。 */
export async function refreshAgeOf(abs: string): Promise<string | null> {
  const raw = await readFile(abs, "utf-8").catch(() => "");
  if (!raw) return null;
  const doc = parseDistillDoc(raw);
  const at = refreshedAt(doc);
  return at ? at.toISOString() : null;
}

export { distillFile };
export type { DistillDoc };
