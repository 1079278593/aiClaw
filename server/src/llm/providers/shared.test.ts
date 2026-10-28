import { describe, expect, it } from "vitest";
import type { Message } from "../../types/index.js";
import { mapMessage } from "./shared.js";

function message(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    role: "user",
    content: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mapMessage", () => {
  it("passes plain string content through unchanged", () => {
    expect(mapMessage(message({ role: "user", content: "hello" }))).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("strips internal path from image_url parts in user messages", () => {
    const m = message({
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA", path: "clipboard:image.png" } },
      ],
    });
    expect(mapMessage(m).content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });

  it("strips path from image parts in tool result messages and keeps tool_call_id", () => {
    const m = message({
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "text", text: "已加载图片" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB", path: "inputs/photo.png" } },
      ],
    });
    expect(mapMessage(m)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "text", text: "已加载图片" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
      ],
    });
  });

  it("strips path from image parts in assistant tool_calls messages and keeps tool_calls", () => {
    const toolCalls = [{ id: "call_2", type: "function" as const, function: { name: "read", arguments: "{}" } }];
    const m = message({
      role: "assistant",
      tool_calls: toolCalls,
      content: [{ type: "image_url", image_url: { url: "data:image/webp;base64,CCC", path: "clipboard:x.webp" } }],
    });
    expect(mapMessage(m)).toEqual({
      role: "assistant",
      tool_calls: toolCalls,
      content: [{ type: "image_url", image_url: { url: "data:image/webp;base64,CCC" } }],
    });
  });

  it("does not mutate the original message", () => {
    const m = message({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA", path: "clipboard:image.png" } }],
    });
    mapMessage(m);
    expect(m.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AAA", path: "clipboard:image.png" } }]);
  });
});
