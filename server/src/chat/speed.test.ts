import { describe, it, expect } from "vitest";
import { TokenSpeedTracker, SPEED_WINDOW_MS, SPEED_EMIT_INTERVAL_MS, SPEED_MIN_DT_MS } from "./speed.js";

describe("TokenSpeedTracker", () => {
  it("returns null snapshot before any token", () => {
    const t = new TokenSpeedTracker();
    expect(t.snapshot(1000)).toBeNull();
    expect(t.shouldEmit(1000)).toBe(false);
  });

  it("estimates tokens as ceil(chars / SPEED_CHARS_PER_TOKEN)", () => {
    const t = new TokenSpeedTracker();
    t.addText("a".repeat(7), 1000); // ceil(7/4) = 2
    expect(t.snapshot(1000)?.totalTokens).toBe(2);
    t.addText(undefined, 1000); // 空文本忽略
    t.addText("", 1000);
    expect(t.snapshot(1000)?.totalTokens).toBe(2);
  });

  it("reports steady stream speed close to the real rate", () => {
    const t = new TokenSpeedTracker();
    // 每 100ms 30 token，持续 2s → 约 300 tok/s
    for (let i = 0; i < 20; i++) {
      t.addTokens(30, 1000 + i * 100);
    }
    const snap = t.snapshot(1000 + 20 * 100)!;
    expect(snap.tokensPerSecond).toBeGreaterThan(280);
    expect(snap.tokensPerSecond).toBeLessThan(320);
    expect(snap.totalTokens).toBe(600);
    expect(snap.elapsedMs).toBe(2000);
  });

  it("prunes samples outside the window after a gap", () => {
    const t = new TokenSpeedTracker();
    t.addTokens(1000, 0); // 早已滑出窗口
    // 长间隔后新突发：窗口只剩新样本，dt 被 SPEED_MIN_DT_MS 兜底
    t.addTokens(30, SPEED_WINDOW_MS + SPEED_MIN_DT_MS + 500);
    const snap = t.snapshot(SPEED_WINDOW_MS + SPEED_MIN_DT_MS + 500)!;
    expect(snap.totalTokens).toBe(1030);
    // 速率只按窗口内 30 token / 1s 计算
    expect(snap.tokensPerSecond).toBe(30);
  });

  it("throttles emits and always allows the first one", () => {
    const t = new TokenSpeedTracker();
    const base = 1_000_000_000; // 真实纪元量级，首个快照必发
    t.addText("hello", base);
    expect(t.maybeSnapshot(base + 1)).not.toBeNull();
    t.addText("world", base + 100);
    expect(t.maybeSnapshot(base + SPEED_EMIT_INTERVAL_MS)).toBeNull();
    const snap = t.maybeSnapshot(base + 100 + SPEED_EMIT_INTERVAL_MS);
    expect(snap).not.toBeNull();
  });

  it("attaches real outputTokens on the final snapshot", () => {
    const t = new TokenSpeedTracker();
    t.addText("hello", 0);
    const snap = t.snapshot(10, 812)!;
    expect(snap.outputTokens).toBe(812);
    expect(t.snapshot(10)?.outputTokens).toBeUndefined();
  });
});
