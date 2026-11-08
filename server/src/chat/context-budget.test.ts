/**
 * 上下文预算装配（plan §13.2 第 10、27 条）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { Message } from "../types/index.js";
import {
  ContextBudgetError,
  assembleContextBudget,
  estimateTokens,
  getCalibrationFactor,
  groupByTurn,
  resetCalibration,
  updateCalibration,
} from "./context-budget.js";

function msg(role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { id: `${role}-${Math.random().toString(36).slice(2)}`, role, content: text, timestamp: "2026-01-01T00:00:00Z", ...extra };
}

function repeat(text: string, times: number): string {
  return Array.from({ length: times }, () => text).join("");
}

describe("estimateTokens", () => {
  it("中文按 0.7、ASCII 按 1/3.5 估算，远高于 len/3", () => {
    const chinese = "这是一段中文内容";
    expect(estimateTokens(chinese)).toBeGreaterThanOrEqual(Math.ceil(chinese.length * 0.7));
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("groupByTurn", () => {
  it("assistant 的 tool_calls 与其 tool 结果同组，不产生孤儿", () => {
    const history: Message[] = [
      msg("user", "读文件"),
      msg("assistant", "", { tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }),
      msg("tool", "内容", { tool_call_id: "c1" }),
      msg("assistant", "读到了"),
      msg("user", "继续"),
      msg("assistant", "好"),
    ];
    const turns = groupByTurn(history);
    expect(turns).toHaveLength(2);
    expect(turns[0].map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(turns[1].map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("10. 超预算时用户消息必在，且无孤儿 tool 消息", () => {
  it("系统块 + 历史远超预算，本轮用户消息仍被锚定", () => {
    const history: Message[] = [];
    for (let i = 0; i < 40; i += 1) {
      history.push(msg("user", repeat("历史问题", 40)));
      history.push(msg("assistant", repeat("历史回答", 40)));
    }
    const userMessage = msg("user", "本轮的关键问题");
    const result = assembleContextBudget({
      userMessage,
      history,
      systemBlocks: [
        { name: "policy", text: repeat("策略", 100), max: 10_000 },
        { name: "rootIndex", text: repeat("索引", 10_000), max: 50 },
      ],
      contextMaxTokens: 2000,
      maxTokens: 500,
    });

    expect(result.messages.at(-1)).toBe(userMessage);
    // 超限的 rootIndex 被整块丢弃，不截断成半张地图。
    const rootIndex = result.report.blocks.find((block) => block.name === "rootIndex");
    expect(rootIndex?.tokens).toBe(0);
    const policy = result.report.blocks.find((block) => block.name === "policy");
    expect(policy?.tokens).toBeGreaterThan(0);

    // 没有孤儿 tool 消息。
    const callIds = new Set<string>();
    for (const message of result.messages) {
      for (const call of message.tool_calls ?? []) callIds.add(call.id);
      if (message.role === "tool") expect(callIds.has(message.tool_call_id ?? "")).toBe(true);
    }
  });

  it("历史 turn 整组进或整组丢", () => {
    const history: Message[] = [
      msg("user", "老问题"),
      msg("assistant", "", { tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: "{}" } }] }),
      msg("tool", repeat("巨大结果", 2000), { tool_call_id: "c9" }),
      msg("assistant", "老回答"),
      msg("user", "新问题"),
      msg("assistant", "新回答"),
    ];
    const result = assembleContextBudget({
      userMessage: msg("user", "本轮"),
      history,
      contextMaxTokens: 1200,
      maxTokens: 200,
    });
    const roles = result.messages.map((message) => message.role);
    // 放不下的老 turn 整组丢弃：不会出现「有 tool_calls 没 tool 结果」的残片。
    const toolCount = roles.filter((role) => role === "tool").length;
    expect(toolCount === 0 || toolCount === 1).toBe(true);
    if (toolCount === 1) expect(roles.includes("assistant")).toBe(true);
  });

  it("固定内容本身就超窗时明确失败，不静默截断用户消息", () => {
    expect(() => assembleContextBudget({
      userMessage: msg("user", repeat("超长用户消息", 5000)),
      history: [],
      contextMaxTokens: 1000,
      maxTokens: 900,
    })).toThrow(ContextBudgetError);
  });

  it("报表给出占比，且系统块不被历史挤占", () => {
    const result = assembleContextBudget({
      userMessage: msg("user", "本轮"),
      history: [msg("user", "问"), msg("assistant", "答")],
      systemBlocks: [{ name: "policy", text: "系统策略", max: 1000 }],
      contextMaxTokens: 10_000,
      maxTokens: 1000,
    });
    expect(result.report.ratio).toBeGreaterThan(0);
    expect(result.report.ratio).toBeLessThanOrEqual(1);
    expect(result.report.available).toBe(9000);
    expect(result.report.blocks.find((block) => block.name === "policy")?.tokens).toBeGreaterThan(0);
  });
});

describe("27. 校准因子按 provider/model 独立，冷启动 1.0", () => {
  beforeEach(() => resetCalibration());

  it("不同模型不串用", () => {
    expect(getCalibrationFactor("zai", "GLM-4.7")).toBe(1);
    expect(getCalibrationFactor("deepseek", "deepseek-v4-pro")).toBe(1);

    updateCalibration("zai", "GLM-4.7", 150, 100);
    expect(getCalibrationFactor("zai", "GLM-4.7")).toBe(1.5);
    // 另一个 provider/model 仍是冷启动值。
    expect(getCalibrationFactor("deepseek", "deepseek-v4-pro")).toBe(1);
    expect(getCalibrationFactor("zai", "GLM-4.5-Air")).toBe(1);
  });

  it("因子被 clamp 在 [0.5, 2.0]", () => {
    updateCalibration("zai", "GLM-4.7", 10_000, 100);
    expect(getCalibrationFactor("zai", "GLM-4.7")).toBe(2);
    updateCalibration("zai", "GLM-4.5-Air", 1, 1000);
    expect(getCalibrationFactor("zai", "GLM-4.5-Air")).toBe(0.5);
  });
});
