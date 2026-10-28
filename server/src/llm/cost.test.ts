/**
 * 费用计算与分时段价格测试
 */

import { describe, it, expect } from "vitest";
import { calcCost, resolveCostConfig } from "./cost.js";
import type { CostConfig } from "../config/schema.js";
import type { NormalizedUsage } from "./types.js";

// 北京时间 = UTC+8。bj(y, m, d, hh, mm) 构造北京时区的 Date
function bj(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
}

const usage: NormalizedUsage = {
  inputTokens: 1_000_000,
  billingOutputTokens: 500_000,
  outputTokens: 500_000,
};

const flat: CostConfig = { input: 1, output: 2, cachedRead: 0.1, cachedWrite: 0.5 };

describe("calcCost 基础（无时段）", () => {
  it("无 cost 配置返回 0", () => {
    expect(calcCost(usage, undefined)).toBe(0);
  });

  it("按单价计算：input*1M + output*500K", () => {
    expect(calcCost(usage, flat)).toBe(2); // (1*1 + 2*0.5)
  });

  it("缓存命中从输入中扣减", () => {
    const u: NormalizedUsage = { ...usage, cachedReadTokens: 400_000 };
    expect(calcCost(u, flat)).toBe(1.64); // (0.6*1 + 2*0.5 + 0.4*0.1)
  });
});

describe("分时段价格", () => {
  const withSchedules: CostConfig = {
    input: 1,
    output: 2,
    cachedRead: 0.1,
    cachedWrite: 0.5,
    schedules: [
      { name: "peak-am", weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", input: 2, output: 4, cachedRead: 0.2, cachedWrite: 1 },
      { name: "peak-pm", weekdays: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", input: 2, output: 4, cachedRead: 0.2, cachedWrite: 1 },
    ],
  };

  // 2025-01-06 是周一，2025-01-11 是周六
  it("周一 9:00 命中早高峰（含头）", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 9, 0), withSchedules)?.input).toBe(2);
  });

  it("周一 12:00 不命中早高峰（不含尾）", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 12, 0), withSchedules)?.input).toBe(1);
  });

  it("周一 8:59 未到高峰", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 8, 59), withSchedules)?.input).toBe(1);
  });

  it("周一 14:00 命中午高峰（含头）", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 14, 0), withSchedules)?.input).toBe(2);
  });

  it("周一 18:00 不命中（不含尾）", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 18, 0), withSchedules)?.input).toBe(1);
  });

  it("周六 10:00 全天空闲", () => {
    expect(resolveCostConfig(bj(2025, 1, 11, 10, 0), withSchedules)?.input).toBe(1);
  });

  it("午休时段 12:30 空闲", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 12, 30), withSchedules)?.input).toBe(1);
  });

  it("命中时段时 cost 按高峰价计算", () => {
    expect(calcCost(usage, withSchedules, bj(2025, 1, 6, 10, 0))).toBe(4); // (2*1 + 4*0.5)
  });

  it("未命中时段时 cost 按默认价计算", () => {
    expect(calcCost(usage, withSchedules, bj(2025, 1, 6, 12, 30))).toBe(2);
  });

  it("无 schedules 时 resolveCostConfig 原样返回", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 10, 0), flat)).toBe(flat);
  });
});

describe("跨天时段", () => {
  const night: CostConfig = {
    ...flat,
    schedules: [{ start: "22:00", end: "06:00", input: 0.5, output: 1, cachedRead: 0.05, cachedWrite: 0.25 }],
  };

  it("23:00 命中（当日跨天区间内）", () => {
    expect(resolveCostConfig(bj(2025, 1, 6, 23, 0), night)?.input).toBe(0.5);
  });

  it("凌晨 03:00 命中（跨到次日）", () => {
    expect(resolveCostConfig(bj(2025, 1, 7, 3, 0), night)?.input).toBe(0.5);
  });

  it("06:00 不命中（不含尾）", () => {
    expect(resolveCostConfig(bj(2025, 1, 7, 6, 0), night)?.input).toBe(1);
  });
});
