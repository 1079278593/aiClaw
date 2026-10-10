import type { NormalizedUsage } from "./types.js";
import type { CostConfig, CostSchedule } from "../config/schema.js";

const TOKENS_PER_UNIT = 1_000_000;

// 北京时间 = UTC + 8（无夏令时），时段判定与 usage-store 统计口径一致
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * 按北京时间（UTC+8）解析当前生效的价格配置：
 * - schedules 按数组顺序匹配，第一个命中的时段价格生效
 * - 未命中任何时段（或未配置 schedules）返回顶层默认价
 */
export function resolveCostConfig(now: Date, cost: CostConfig | undefined): CostConfig | undefined {
  if (!cost || !cost.schedules?.length) return cost;

  const bj = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const weekday = bj.getUTCDay() === 0 ? 7 : bj.getUTCDay(); // 0(周日) → 7
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();

  for (const s of cost.schedules) {
    if (s.weekdays && !s.weekdays.includes(weekday)) continue;
    const start = parseTime(s.start);
    const end = parseTime(s.end);
    const hit = end > start ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    if (hit) return pickSchedule(s);
  }
  return cost;
}

function pickSchedule(s: CostSchedule): CostConfig {
  return { input: s.input, output: s.output, cachedRead: s.cachedRead, cachedWrite: s.cachedWrite };
}

export function calcCost(usage: NormalizedUsage, cost: CostConfig | undefined, now: Date = new Date()): number {
  const resolved = resolveCostConfig(now, cost);
  if (!resolved) return 0;

  const cachedRead = usage.cachedReadTokens ?? 0;
  const cachedWrite = usage.cachedWriteTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cachedRead - cachedWrite);

  const raw =
    uncachedInput * resolved.input +
    usage.billingOutputTokens * resolved.output +
    cachedRead * resolved.cachedRead +
    cachedWrite * resolved.cachedWrite;

  return Number((raw / TOKENS_PER_UNIT).toFixed(6));
}
