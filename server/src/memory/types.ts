/**
 * 记忆条目的类型（plan §8.2「只存事实」）。
 *
 * 存储切成两半（plan §8.2 方案 A）：
 * - 正文在 `agents/main/{runtime.md, user.md, memory/focus.md, memory/longterm.md}`，
 *   人类可读、可手改；
 * - 元数据在 `agents/main/memory/index.jsonl`，一行一条，高频自增（`used`/`last_used`）
 *   不重写正文。
 *
 * 这样 `used` 每轮 +1 只会写一个小 jsonl，而不是重写整个 `longterm.md`。
 */

/** 记忆所在的四个文件。四个都是「多条条目」的容器，正文用 `## ` 分隔。 */
export type MemoryLayer = "runtime" | "focus" | "user" | "longterm";

export const MEMORY_LAYERS: MemoryLayer[] = ["runtime", "focus", "user", "longterm"];

/**
 * `importance` 只有两档（plan §8.2「明示关心=高，推断=中」）。
 * 不引入第三档：多一档就多一个需要解释给用户的区别，而检索里它只占 0.5 权重。
 */
export type MemoryImportance = "high" | "medium";

export const IMPORTANCE_SCORE: Record<MemoryImportance, number> = {
  high: 1,
  medium: 0.5,
};

/** 一条记忆的元数据。正文按 `id` 从 Markdown 文件里取，不在这里重复存。 */
export type MemoryEntryMeta = {
  id: string;
  layer: MemoryLayer;
  importance: MemoryImportance;
  /** ISO-8601 写入时刻。 */
  created: string;
  /** ISO-8601 上次被注入的时刻。从未注入过时等于 `created`。 */
  lastUsed: string;
  /** 被注入的累计轮数。只在「本轮确实注入」时 +1，plan §8.2。 */
  used: number;
  /** 恒定注入，不参与淘汰与打分竞争。 */
  pinned: boolean;
  /** 写入来源：agent 主动写入 / 压缩时 / 用户手改。 */
  writtenBy: MemoryWriter;
  sourceSessionId?: string;
};

export type MemoryWriter = "agent" | "compaction" | "user" | "system";

/** 正文 + 元数据合并后的完整条目。 */
export type MemoryEntry = MemoryEntryMeta & { text: string };

/** 各层的体积上限（plan §3.4）。 */
export const LAYER_BYTE_MAX: Record<MemoryLayer, number> = {
  runtime: 2 * 1024,
  focus: 2 * 1024,
  user: 64 * 1024,
  longterm: 64 * 1024,
};

/** 每层 `_archive` 保留的份数（plan §3.4「保留最近 3 份」）。 */
export const ARCHIVE_KEEP = 3;

/**
 * 每层注入的条数上限，按层各自计算（context_governance_plan §1）。
 *
 * 四层不再共用一份名额：常驻层各有自己的条数，`longterm` 只在自己的额度里
 * 按相关性取。条数是上限，token 硬顶见 `LAYER_TOKEN_MAX`，两者取更严的那个。
 * 旧的 `INJECT_MAX`（全局 8 条）已删除，不要再加回来。
 */
export const LAYER_INJECT_MAX: Record<MemoryLayer, number> = {
  user: 4,
  focus: 3,
  runtime: 3,
  longterm: 5,
};

/**
 * 每层注入的 token 硬顶。
 *
 * 合计 7500 就是整个记忆块的预算：超出硬顶时整条不注入，从该层最旧、
 * 未置顶的开始丢，不写半条，也不占用别的层的额度。
 */
export const LAYER_TOKEN_MAX: Record<MemoryLayer, number> = {
  user: 2000,
  focus: 1500,
  runtime: 1500,
  longterm: 2500,
};

/** 记忆块（四层合计）的 token 上限，等于各层硬顶之和。 */
export const MEMORY_TOKEN_MAX = 7500;

export class MemoryError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "MemoryError";
  }
}
