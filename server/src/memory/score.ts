/**
 * 记忆检索打分（plan §8.2）。
 *
 * ```
 * score = 0.5 * importance + 0.3 * recency + 0.2 * relevance
 * recency   = exp(-daysSinceLastUsed / 30)
 * relevance = 字符 bigram 的 Jaccard
 * ```
 *
 * 三条不可动摇的约定：
 * 1. **衰减只影响排序**，绝不触发自动归档（归档只由用户「忘掉」或 `_archive` TTL 触发）；
 * 2. 不持久化 `salience`/分数——每次检索现算，避免正文被写入派生值；
 * 3. `pinned` 恒定注入，不参与竞争（但仍要计入注入条数上限）。
 */

import { IMPORTANCE_SCORE, type MemoryEntry } from "./types.js";

/** 半衰期参数：30 天不用，recency 降到 `1/e ≈ 0.37`。 */
const RECENCY_DECAY_DAYS = 30;

const CJK_PUNCT = /[\s\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~]/g;

/**
 * 取字符级 bigram 集合：去空白与标点、转小写后，相邻两字符一组。
 * 长度 < 2 的串退化为自身单字符，避免空集合让 Jaccard 恒为 0。
 */
export function bigrams(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(CJK_PUNCT, "");
  const chars = [...cleaned];
  const out = new Set<string>();
  if (chars.length === 0) return out;
  if (chars.length === 1) {
    out.add(chars[0]);
    return out;
  }
  for (let i = 0; i < chars.length - 1; i += 1) {
    out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

/** Jaccard 相似度：分母用并集，避免长条目因词多被系统性压低（plan §8.2）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** `exp(-days / 30)`。未来时间按 0 天算，返回值落在 (0, 1]。 */
export function recency(lastUsed: string, now: Date): number {
  const at = new Date(lastUsed);
  if (Number.isNaN(at.getTime())) return 1;
  const days = Math.max(0, (now.getTime() - at.getTime()) / 86_400_000);
  return Math.exp(-days / RECENCY_DECAY_DAYS);
}

export type ScoreParts = {
  importance: number;
  recency: number;
  relevance: number;
  score: number;
};

/** 单条打分。`query` 为空时 relevance 记 0（没有查询就没有相关性可言）。 */
export function scoreEntry(entry: MemoryEntry, query: string, now: Date): ScoreParts {
  const importance = IMPORTANCE_SCORE[entry.importance] ?? 0.5;
  const fresh = recency(entry.lastUsed, now);
  const relevance = query.trim() ? jaccard(bigrams(query), bigrams(entry.text)) : 0;
  return {
    importance,
    recency: Number(fresh.toFixed(4)),
    relevance: Number(relevance.toFixed(4)),
    score: Number((0.5 * importance + 0.3 * fresh + 0.2 * relevance).toFixed(4)),
  };
}

/**
 * 从一层记忆里挑出本轮要注入的条目。
 *
 * 规则：
 * - `pinned` 无条件入选（按 `created` 旧→新，稳定的「常驻」区）；
 * - 其余按 score 降序取，直到占满 `max`;
 * - 新建条目 `lastUsed === created` → recency 接近 1，因此**不会被衰减归零**
 *   （§13.2 第 12 条要的就是这个性质）。
 */
export function selectForInjection(
  entries: MemoryEntry[],
  query: string,
  now: Date,
  max: number,
): MemoryEntry[] {
  const pinned = entries
    .filter((entry) => entry.pinned)
    .sort((a, b) => a.created.localeCompare(b.created));
  if (pinned.length >= max) return pinned.slice(0, max);

  const rest = entries
    .filter((entry) => !entry.pinned)
    .map((entry) => ({ entry, score: scoreEntry(entry, query, now).score }))
    .sort((a, b) => b.score - a.score || a.entry.created.localeCompare(b.entry.created))
    .slice(0, max - pinned.length)
    .map((item) => item.entry);

  return [...pinned, ...rest];
}
