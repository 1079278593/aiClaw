import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDCODE_DEFAULT_MODEL, CommandCodeProvider } from "./commandcode.js";
import type { Message } from "../../types/index.js";

const messages: Message[] = [{ id: "message", role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" }];

function mockChatResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("CommandCodeProvider", () => {
  it("maps raw usage to normalized usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockChatResponse({
        choices: [
          {
            message: { role: "assistant", content: "2", reasoning_content: "先算 1+1=2" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 60,
          total_tokens: 160,
          prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CommandCodeProvider().complete("test-key", messages);

    expect(result.content).toBe("2");
    expect(result.reasoning_content).toBe("先算 1+1=2");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      billingOutputTokens: 60,
      thinkingTokens: 40,
      cachedReadTokens: 20,
      cachedWriteTokens: 5,
    });
  });

  it("sends default endpoint/model and thinkingParams with the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockChatResponse({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new CommandCodeProvider().complete("test-key", messages, {
      thinkingParams: { reasoning_effort: "off" },
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.model).toBe(COMMANDCODE_DEFAULT_MODEL);
    expect(body.stream).toBe(false);
    expect(body.reasoning_effort).toBe("off");
  });

  it("keeps reasoning_content in outbound assistant messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockChatResponse({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const history: Message[] = [
      { id: "a", role: "user", content: "帮我算 17*23", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        id: "b",
        role: "assistant",
        content: "我来计算。",
        timestamp: "2026-01-01T00:00:01.000Z",
        reasoning_content: "17*23 = 391",
      },
      { id: "c", role: "user", content: "结果是多少？", timestamp: "2026-01-01T00:00:02.000Z" },
    ];
    await new CommandCodeProvider().complete("test-key", history);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{ role: string; content: unknown; reasoning_content?: string }>;
    };
    expect(body.messages[1].reasoning_content).toBe("17*23 = 391");
  });
});
