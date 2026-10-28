/**
 * 工具串行执行回归测试：
 * 同一轮的多个工具调用必须逐个执行——Edit 等写文件工具是"读→改→写回"，
 * 并行执行同一文件会互相覆盖导致修改丢失。
 */
import { describe, it, expect } from "vitest";
import { runAgenticLoopStreaming } from "./index.js";
import type { LLMProvider, StreamChunk, StreamFinish } from "../llm/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Message } from "../types/index.js";
import type { createProvider } from "../llm/index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Provider = ReturnType<typeof createProvider>;

function makeProvider(turns: StreamFinish[]): Provider {
  let i = 0;
  return {
    async *stream(): AsyncGenerator<StreamChunk, StreamFinish, unknown> {
      const finish = turns[i++]!;
      if (finish.tool_calls?.length) yield { type: "toolCallDelta", index: 0 };
      return finish;
    },
    async complete() {
      throw new Error("complete 不应被调用");
    },
  } as unknown as Provider;
}

function makeSlowTool() {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const tool: ToolDefinition = {
    name: "slow",
    description: "用于观测并发度的慢工具",
    inputSchema: { type: "object" },
    async execute(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      order.push((input as { tag?: string }).tag ?? "");
      active -= 1;
      return { content: "ok" };
    },
  };
  return { tool, getMaxActive: () => maxActive, order };
}

const userMessage = (): Message => ({ id: "m1", role: "user", content: "hi", timestamp: new Date().toISOString() });

describe("runAgenticLoopStreaming 工具执行", () => {
  it("同一轮的多个工具调用串行执行且保持顺序", async () => {
    const { tool, getMaxActive, order } = makeSlowTool();
    const provider = makeProvider([
      {
        finish_reason: "tool_calls",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "slow", arguments: '{"tag":"a"}' } },
          { id: "c2", type: "function", function: { name: "slow", arguments: '{"tag":"b"}' } },
          { id: "c3", type: "function", function: { name: "slow", arguments: '{"tag":"c"}' } },
        ],
      },
      { finish_reason: "stop" },
    ]);

    const gen = runAgenticLoopStreaming(provider, "key", [userMessage()], [tool], "s1", "t", 10, {}, false);
    const toolResults: string[] = [];
    for await (const event of gen) {
      if (event.type === "toolResult") toolResults.push(event.callId);
    }

    expect(toolResults).toEqual(["c1", "c2", "c3"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(getMaxActive()).toBe(1);
  });

  it("多轮工具调用各自串行，轮与轮之间正常衔接", async () => {
    const { tool, getMaxActive } = makeSlowTool();
    const provider = makeProvider([
      {
        finish_reason: "tool_calls",
        tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: '{"tag":"a"}' } }],
      },
      {
        finish_reason: "tool_calls",
        tool_calls: [{ id: "c2", type: "function", function: { name: "slow", arguments: '{"tag":"b"}' } }],
      },
      { finish_reason: "stop" },
    ]);

    const gen = runAgenticLoopStreaming(provider, "key", [userMessage()], [tool], "s1", "t", 10, {}, false);
    let toolResultCount = 0;
    for await (const event of gen) {
      if (event.type === "toolResult") toolResultCount += 1;
    }

    expect(toolResultCount).toBe(2);
    expect(getMaxActive()).toBe(1);
  });
});
