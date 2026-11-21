import { describe, it, expect } from "vitest";
import { runAgenticLoopStreaming } from "./index.js";
import type { Message } from "../types/index.js";
import type { ToolDefinition } from "../tools/types.js";

/**
 * 用假 provider 驱动循环，验证 loopProgress 事件的轮次与计数。
 * 不触网：provider.stream 按脚本依次返回 tool_calls / stop。
 */
function makeFakeProvider(script: Array<{ toolCalls?: number; content?: string }>) {
  let step = 0;
  return {
    label: "fake",
    async complete() {
      throw new Error("not used");
    },
    async *stream() {
      const plan = script[Math.min(step, script.length - 1)];
      step += 1;
      if (plan.toolCalls && plan.toolCalls > 0) {
        for (let i = 0; i < plan.toolCalls; i += 1) {
          yield { type: "toolCallDelta" as const, index: i, id: `call_${step}_${i}`, arguments: "{}" };
        }
        return {
          finish_reason: "tool_calls",
          tool_calls: Array.from({ length: plan.toolCalls }, (_, i) => ({
            id: `call_${step}_${i}`,
            type: "function" as const,
            function: { name: "read", arguments: "{}" },
          })),
        };
      }
      yield { type: "content" as const, text: plan.content ?? "done" };
      return { finish_reason: "stop" };
    },
  };
}

const tools: ToolDefinition[] = [
  {
    name: "read",
    description: "fake read",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: "file body" };
    },
  },
];

const messages: Message[] = [
  { id: "u1", role: "user", content: "hello", timestamp: "2024-01-01T00:00:00Z" },
];

async function collect(script: Array<{ toolCalls?: number; content?: string }>, maxToolCalls: number) {
  const gen = runAgenticLoopStreaming(
    makeFakeProvider(script) as never,
    "key",
    messages,
    tools,
    "sess",
    "title",
    maxToolCalls,
    {},
    false,
  );
  const progress: Array<{ round: number; toolCalls: number; maxToolCalls: number }> = [];
  let final: unknown;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      final = value;
      break;
    }
    if (value.type === "loopProgress") progress.push(value.progress);
  }
  return { progress, final };
}

describe("loopProgress", () => {
  it("每轮工具往返后推送一次进度，计数与轮次递增", async () => {
    const { progress } = await collect([{ toolCalls: 2 }, { toolCalls: 1 }, { content: "ok" }], 10);

    expect(progress).toEqual([
      { round: 1, toolCalls: 2, maxToolCalls: 10 },
      { round: 2, toolCalls: 3, maxToolCalls: 10 },
    ]);
  });

  it("首轮直接结束时不推送任何进度", async () => {
    const { progress } = await collect([{ content: "直接回答" }], 10);
    expect(progress).toEqual([]);
  });

  it("达到 maxToolCalls 上限时停止，进度反映配置上限", async () => {
    const { progress, final } = await collect([{ toolCalls: 1 }], 2);

    expect(progress).toHaveLength(2);
    expect(progress.at(-1)).toEqual({ round: 2, toolCalls: 2, maxToolCalls: 2 });
    expect((final as { maxToolCallsReached?: boolean }).maxToolCallsReached).toBe(true);
  });

  it("单轮多个 call 超过剩余额度时按上限截断", async () => {
    const { progress } = await collect([{ toolCalls: 5 }, { content: "ok" }], 2);

    expect(progress).toHaveLength(1);
    expect(progress[0].toolCalls).toBe(2);
  });
});
