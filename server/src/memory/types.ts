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

/** 每轮最多注入的条数（plan §8.2「5～8 条」）。 */
export const INJECT_MAX = 8;

export class MemoryError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "MemoryError";
  }
}
