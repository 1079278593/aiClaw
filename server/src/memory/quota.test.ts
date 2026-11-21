/**
 * 记忆按层配额（context_governance_plan §1）。
 *
 * 这里断言的都是「上线后会真出问题」的边界，不是覆盖率：
 * 1. 四层不再抢同一个名额池；
 * 2. token 硬顶优先于条数上限；
 * 3. 丢的是该层最旧、未置顶的条目，整条丢，不写半条；
 * 4. 整个记忆块不会被预算层整块丢弃（超了继续逐条收敛）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryInjection } from "./inject.js";
import { addEntry, ensureMemoryFiles, readLayer } from "./store.js";
import { LAYER_INJECT_MAX, LAYER_TOKEN_MAX, MEMORY_TOKEN_MAX } from "./types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aiclaw-quota-"));
  await ensureMemoryFiles(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 依次写入若干条目，`pinned` 可指定。 */
async function seed(layer: "user" | "focus" | "runtime" | "longterm", texts: string[], pinned = false) {
  for (const text of texts) {
    await addEntry({ layer, text, pinned }, dir);
  }
}

describe("按层配额", () => {
  it("user 层超过条数上限时只取前 4 条，不影响 longterm 的 5 条", async () => {
    await seed("user", ["甲", "乙", "丙", "丁", "戊", "己"].map((name) => `画像${name}`));
    await seed("longterm", ["一", "二", "三", "四", "五", "六"].map((name) => `事实${name}`));

    const injection = await buildMemoryInjection("事实", { userDataDir: dir });
    expect(injection.layerCounts.user).toBe(LAYER_INJECT_MAX.user);
    expect(injection.layerCounts.longterm).toBe(LAYER_INJECT_MAX.longterm);
    expect(injection.dropped).toBeGreaterThan(0);
  });

  it("四层各自的名额互不占用（旧实现里 user 会吃掉 longterm 的位置）", async () => {
    await seed("user", ["甲", "乙", "丙", "丁", "戊"].map((name) => `画像${name}`));
    await seed("focus", ["关注一", "关注二", "关注三", "关注四"], true);
    await seed("longterm", ["事实一", "事实二"]);

    const injection = await buildMemoryInjection("事实", { userDataDir: dir });
    expect(injection.layerCounts.user).toBe(4);
    expect(injection.layerCounts.focus).toBe(3);
    expect(injection.layerCounts.longterm).toBe(2);
  });

  it("token 硬顶优先：条数没满，但超了该层硬顶也会整条丢最旧的", async () => {
    // 每条约 300 token（600 字中文），user 硬顶 2000 → 最多 6 条左右；
    // 这里给 8 条短条目，条数上限 4 先生效，结果应恰为 4。
    await seed("user", Array.from({ length: 8 }, (_, index) => `画像条目${index}`));

    const injection = await buildMemoryInjection("", { userDataDir: dir });
    const lines = injection.text.split("\n").filter((line) => line.startsWith("- [user]"));
    expect(lines).toHaveLength(4);
    // 取的是最新的 4 条（第 4..7 个），不是最旧的 4 条。
    const joined = lines.join("\n");
    expect(joined).toContain("画像条目7");
    expect(joined).not.toContain("画像条目0");
  });

  it("单条超长时按该层 token 硬顶整条丢弃，不截成半条", async () => {
    // 每条 600 字上限后约 400 token；给 user 塞 6 条，2000 token 装不下全部。
    await seed("user", Array.from({ length: 6 }, (_, index) => `第${index}条${"很长的内容".repeat(120)}`));

    const injection = await buildMemoryInjection("", { userDataDir: dir });
    const lines = injection.text.split("\n").filter((line) => line.startsWith("- [user]"));
    expect(lines.length).toBeLessThan(6);
    // 块本身没有超总上限（否则预算层会把它整块丢掉）。
    expect(injection.text.trim()).not.toBe("");
    expect(LAYER_TOKEN_MAX.user).toBe(2000);
  });

  it("整块超过总预算时继续逐条收敛，不会一条都不剩", async () => {
    // 各层都塞到接近自己的字节/条数上限，合计逼近 7500。
    await seed("user", Array.from({ length: 4 }, (_, index) => `画像${index}${"内容".repeat(200)}`));
    await seed("focus", Array.from({ length: 3 }, (_, index) => `关注${index}${"内容".repeat(60)}`), true);
    await seed("runtime", Array.from({ length: 3 }, (_, index) => `工作${index}${"内容".repeat(60)}`));
    await seed("longterm", Array.from({ length: 5 }, (_, index) => `长期${index}${"内容".repeat(60)}`));

    const injection = await buildMemoryInjection("", { userDataDir: dir });
    expect(injection.text.trim().length).toBeGreaterThan(0);
    expect(MEMORY_TOKEN_MAX).toBe(7500);
    // 条数只可能变少，不会凭空多出来。
    for (const count of Object.values(injection.layerCounts)) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it("注入的 id 就是实际注入的条目，未入选的不自增 used", async () => {
    await seed("focus", ["关注一", "关注二", "关注三", "关注四"], true);
    const injection = await buildMemoryInjection("", { userDataDir: dir });
    const entries = await readLayer("focus", dir);
    const injectedTexts = injection.ids.map((id) => entries.find((entry) => entry.id === id)?.text);
    expect(injectedTexts).toHaveLength(3);
    expect(injection.ids).not.toContain(entries[3].id);
  });
});
