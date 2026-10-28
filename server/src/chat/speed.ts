/**
 * 生成速度跟踪：统计本次回复的所有 LLM 产出（思考 / 正文 / 工具调用参数），
 * 一视同仁地累加，用滚动窗口计算速率。
 *
 * 工具执行期间 LLM 不产 token，事件流自然静默（不发事件）；
 * 每个快照带时间戳，由前端自行决定如何呈现间隔与静默。
 */

/** 速度估算专用：中文按 4 字符/token（通用口径 3 在速度场景偏高估）。 */
export const SPEED_CHARS_PER_TOKEN = 4;

/** 滚动窗口长度：速率 ≈ 窗口内 token 数 / 窗口时长 */
export const SPEED_WINDOW_MS = 5000;
/** 事件发射最小间隔（节流，首个事件必发） */
export const SPEED_EMIT_INTERVAL_MS = 500;
/** 计算速率的最小时间基数，避免单次突发造成速率尖峰 */
export const SPEED_MIN_DT_MS = 1000;

export interface TokenSpeedSnapshot {
  /** 滚动窗口估算速率（token/s，1 位小数） */
  tokensPerSecond: number;
  /** 本次回复累计估算 token（思考 + 正文 + 工具参数，按 SPEED_CHARS_PER_TOKEN 口径） */
  totalTokens: number;
  /** 距首个 token 的墙钟时间 */
  elapsedMs: number;
  /** 快照时间戳（前端据此判断流是否已静默） */
  ts: number;
  /** 仅结束快照附带：provider 真实 outputTokens（跨轮累计），用于精确平均 */
  outputTokens?: number;
}

interface Sample {
  at: number;
  delta: number;
}

export class TokenSpeedTracker {
  private firstAt: number | null = null;
  private total = 0;
  private samples: Sample[] = [];
  private lastEmitAt = 0;

  /** 记录一段文本增量（按速度口径 chars/SPEED_CHARS_PER_TOKEN 估算 token） */
  addText(text: string | undefined, now = Date.now()): void {
    if (!text) return;
    this.addTokens(Math.ceil(text.length / SPEED_CHARS_PER_TOKEN), now);
  }

  addTokens(delta: number, now = Date.now()): void {
    if (delta <= 0) return;
    this.firstAt ??= now;
    this.total += delta;
    this.samples.push({ at: now, delta });
  }

  /** 距上次发射是否达到节流间隔；尚未产生任何 token 时恒为 false */
  shouldEmit(now = Date.now()): boolean {
    return this.firstAt !== null && now - this.lastEmitAt >= SPEED_EMIT_INTERVAL_MS;
  }

  /** 达到节流间隔则返回快照并记一次发射，否则返回 null */
  maybeSnapshot(now = Date.now()): TokenSpeedSnapshot | null {
    if (!this.shouldEmit(now)) return null;
    this.lastEmitAt = now;
    return this.snapshot(now);
  }

  /** 当前快照（不受节流限制）；尚无 token 时返回 null */
  snapshot(now = Date.now(), outputTokens?: number): TokenSpeedSnapshot | null {
    if (this.firstAt === null) return null;

    this.samples = this.samples.filter((s) => now - s.at <= SPEED_WINDOW_MS);
    const windowTokens = this.samples.reduce((sum, s) => sum + s.delta, 0);
    const windowStart = this.samples[0]?.at ?? now;
    const dtMs = Math.min(SPEED_WINDOW_MS, Math.max(now - windowStart, SPEED_MIN_DT_MS));
    const tokensPerSecond = Math.round((windowTokens / dtMs) * 1000 * 10) / 10;

    return {
      tokensPerSecond,
      totalTokens: this.total,
      elapsedMs: now - this.firstAt,
      ts: now,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }
}
