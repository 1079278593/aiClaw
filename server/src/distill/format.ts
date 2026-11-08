/**
 * 蒸馏文件的格式层（plan_distill §2）。
 *
 * 只用一行 HTML 注释作头，**不用 YAML front matter**：
 * `distill/` 是 AI 直接写的区，要求模型手写合法 YAML 经常写坏，
 * 而写坏了解析失败就会连带「读原文」也失败。缓存坏掉不该有这种后果。
 *
 * 解析失败一律**退化**，绝不抛异常：
 * - 头读不出 `id` → 视为用户手写的普通笔记（`id: null`），系统永不覆盖；
 * - `refreshed` 读不出 → 视为过期，但不自动重算（`needsRefresh` 为 false，由调用方决定）。
 */

/** 头的正则：`<!-- distill id:xxx refreshed:ISO -->`，字段顺序固定、缺一即视为无头。 */
const HEAD_RE = /^<!--\s*distill\s+id:([^\s]+)\s+refreshed:([^\s]+)\s*-->\s*$/;

export type DistillHeader = {
  /** 摘要 id。`null` 表示「无主文件」——用户手写，不参与刷新与归档。 */
  id: string | null;
  /** ISO-8601 生成时刻。`null` 表示头损坏或缺失。 */
  refreshed: string | null;
};

export type DistillDoc = DistillHeader & {
  /** 去掉头之后的正文（保留原始换行）。 */
  body: string;
};

export const DISTILL_HEAD_LINE = 1;

/** 渲染头行。`id` 与 `refreshed` 都必须是合法值，调用方负责。 */
export function renderHead(id: string, refreshed: Date | string): string {
  const iso = typeof refreshed === "string" ? refreshed : refreshed.toISOString();
  return `<!-- distill id:${id} refreshed:${iso} -->`;
}

/**
 * 从文件内容里解析出 id / refreshed。
 *
 * 只看**第一行**：正文里出现同样形状的注释不应改变语义。
 * 第一行不是合法头时整份文件按普通 markdown 处理。
 */
export function parseDistillHead(content: string): DistillHeader {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const match = HEAD_RE.exec(firstLine.trim());
  if (!match) return { id: null, refreshed: null };
  const [, id, refreshed] = match;
  return {
    id: id && id.trim() ? id.trim() : null,
    refreshed: isValidIso(refreshed) ? refreshed : null,
  };
}

/** 解析成文档：头 + 去掉头行的正文。 */
export function parseDistillDoc(content: string): DistillDoc {
  const header = parseDistillHead(content);
  if (!header.id) return { ...header, body: content };
  const lines = content.split("\n");
  return { ...header, body: lines.slice(1).join("\n").replace(/^\n/, "") };
}

/**
 * 渲染一份完整的蒸馏文件。
 *
 * 结尾统一补一个换行（与 pending/store.ts 的归一化口径一致），
 * 避免「有没有末尾换行」在 diff 与归档里变成噪声。
 */
export function renderDistillDoc(id: string, refreshed: Date | string, body: string): string {
  const trimmed = body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return `${renderHead(id, refreshed)}\n\n${trimmed}\n`;
}

function isValidIso(value: string | undefined): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  return !Number.isNaN(at);
}

/** `refreshed` 是否可解析；解析不了就无法判断过期（调用方按「不自动重算」处理）。 */
export function refreshedAt(header: DistillHeader): Date | null {
  if (!header.refreshed) return null;
  const at = new Date(header.refreshed);
  return Number.isNaN(at.getTime()) ? null : at;
}

export type StalenessInput = {
  header: DistillHeader;
  /** 来源文件里最新的 mtime；来源为空时为 null。 */
  newestSourceMtime: Date | null;
  /** 列在「来源」里但已不存在的路径数。 */
  missingSources: number;
};

export type Staleness =
  /** 无头文件：不参与自动刷新。 */
  | "unowned"
  /** 头里的时间解析不了：视为过期但不自动重算。 */
  | "unknown"
  | "fresh"
  | "stale";

/**
 * 过期判定（plan_distill §3.2）：不带 hash，只用时间与文件集合，与 L1 索引校准同构。
 *
 * 注意 `unknown` 与 `stale` 的区别：前者是**我们不知道**什么时候生成的，
 * 自动重算可能覆盖掉用户手写的、恰好带了个坏头的文件，所以只标出来不动它。
 */
export function classifyStaleness(input: StalenessInput): Staleness {
  if (!input.header.id) return "unowned";
  const refreshed = refreshedAt(input.header);
  if (!refreshed) return "unknown";
  if (input.missingSources > 0) return "stale";
  if (!input.newestSourceMtime) return "fresh";
  return input.newestSourceMtime.getTime() > refreshed.getTime() ? "stale" : "fresh";
}

/**
 * 「来源」小节里的路径列表。
 *
 * 只认 `## 来源` 下的 `- ` 行；路径去掉反引号与首尾空白。
 * 解析不出就返回空数组——**不报错**，只意味着这次刷新无从判断过期。
 */
export function parseSources(body: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s*来源\s*$/.test(line.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("##")) break;
    if (!trimmed.startsWith("-")) continue;
    const value = trimmed.replace(/^-\s*/, "").replace(/`/g, "").trim();
    if (value) out.push(value);
  }
  return out;
}

/** 从文件内容里取「来源」列表（`parseDistillDoc` + `parseSources` 的便利封装）。 */
export function sourcesOf(content: string): string[] {
  return parseSources(parseDistillDoc(content).body);
}

/**
 * 蒸馏 id 生成：`dst-` + 8 位十六进制 + 时间后缀。
 *
 * 时间后缀让同一秒内连续生成的两个 id 不撞（与 `memory/store.ts` 的归档戳同一个坑）。
 */
export function newDistillId(now: Date = new Date()): string {
  const random = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  const stamp = now.getTime().toString(36);
  return `dst-${random}${stamp}`;
}

/** `meta/overview.md` 的固定 id：全库唯一，不随刷新变化。 */
export const OVERVIEW_ID = "dst-meta";
