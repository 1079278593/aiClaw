import { describe, expect, it } from "vitest";
import { consumeRateLimit, resetRateLimits } from "./rate-limit.js";

describe("rate limit", () => {
  it("allows a burst up to the limit and then asks the caller to wait", () => {
    resetRateLimits();
    const now = 1_000_000;
    expect(consumeRateLimit("http:ming", 2, now).allowed).toBe(true);
    expect(consumeRateLimit("http:ming", 2, now + 10).allowed).toBe(true);
    const blocked = consumeRateLimit("http:ming", 2, now + 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(consumeRateLimit("http:other", 2, now + 20).allowed).toBe(true);
    expect(consumeRateLimit("http:ming", 2, now + 60_000).allowed).toBe(true);
  });
});
