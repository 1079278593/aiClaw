import { afterEach, describe, expect, it, vi } from "vitest";
import { DashScopeProvider } from "./dashscope.js";
import { DeepSeekProvider } from "./deepseek.js";
import { ZaiProvider } from "./zai.js";

const message = [{ id: "message", role: "user" as const, content: "hello", timestamp: "2026-01-01T00:00:00.000Z" }];

function mockSuccessResponse() {
  return new Response(JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  }), { status: 200 });
}

async function requestBody(provider: ZaiProvider | DashScopeProvider | DeepSeekProvider, thinkingParams: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue(mockSuccessResponse());
  vi.stubGlobal("fetch", fetchMock);
  await provider.complete("test-key", message, { baseUrl: "https://example.test", thinkingParams });
  return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider thinking parameters", () => {
  it("sends provider-specific explicit disable parameters for none", async () => {
    await expect(requestBody(new ZaiProvider(), { thinking: { type: "disabled" } })).resolves.toMatchObject({ thinking: { type: "disabled" } });
    await expect(requestBody(new DashScopeProvider(), { enable_thinking: false })).resolves.toMatchObject({ enable_thinking: false });
    await expect(requestBody(new DeepSeekProvider(), { thinking: { type: "disabled" } })).resolves.toMatchObject({ thinking: { type: "disabled" } });
  });

  it("passes model-configured native thinking values without a shared mapping", async () => {
    await expect(requestBody(new ZaiProvider(), { thinking: { type: "enabled" } })).resolves.toMatchObject({ thinking: { type: "enabled" } });
    await expect(requestBody(new DashScopeProvider(), { enable_thinking: true, thinking_budget: 4096 })).resolves.toMatchObject({ enable_thinking: true, thinking_budget: 4096 });
    await expect(requestBody(new DeepSeekProvider(), { thinking: { type: "enabled" }, reasoning_effort: "max" })).resolves.toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });
});
