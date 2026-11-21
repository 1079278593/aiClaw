/**
 * 心得会话的对话状态与折叠（context_governance_plan §2 / §3）。
 *
 * 这些断言对应 plan 里的硬规则，不能靠人工检查：
 * 1. 状态按会话 id 分开，删会话不删文件，新会话不带旧块；
 * 2. 游标之后的原文进窗口，游标之前的不进；
 * 3. 8000 只是触发阈值，不到就继续用原文；
 * 4. 失败不挪游标、不换「当前有效」；
 * 5. 折叠成功之后才缩短大工具结果，且只缩游标覆盖范围内的。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../logger/index.js";
import type { Message } from "../types/index.js";
import {
  DIALOGUE_STATE_TOKEN_MAX,
  loadAllDialogueStates,
  loadCurrentDialogueBlock,
  loadDialogueState,
  parseDialogueStates,
  renderDialogueStates,
  saveDialogueState,
} from "./dialogue-state.js";
import {
  FOLD_TRIGGER_TOKENS,
  historyAfterCursor,
  pendingRange,
  protectedTailStart,
  segmentTurns,
  TOOL_STUB_BYTES,
  trimStubbedToolResults,
} from "./dialogue-fold.js";
import { ensureDirectories, getPaths } from "../config/paths.js";
import { saveSession } from "../session/index.js";

let dir = "";

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aiclaw-dialogue-"));
  process.env.AICLAW_DATA_DIR = dir;
  await ensureDirectories(getPaths(dir));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function msg(
  id: string,
  role: Message["role"],
  content: Message["content"],
  extra: Partial<Message> = {},
): Message {
  return { id, role, content, timestamp: "2026-11-19T00:00:00.000Z", ...extra };
}

describe("状态文件", () => {
  it("按会话 id 分开，渲染与解析往返稳定", () => {
    const raw = renderDialogueStates(new Map([
      ["s1", { foldedThrough: "m3", current: "## 硬约束\n必须用 pnpm", history: [{ at: "2026-11-01T00:00:00.000Z", text: "旧块" }], updatedAt: "2026-11-02T00:00:00.000Z" }],
      ["s2", { current: "## 硬约束\n无", history: [] }],
    ]));
    const parsed = parseDialogueStates(raw);
    expect(parsed.get("s1")?.foldedThrough).toBe("m3");
    expect(parsed.get("s1")?.current).toContain("必须用 pnpm");
    expect(parsed.get("s1")?.history).toHaveLength(1);
    expect(parsed.get("s2")?.current).toContain("## 硬约束");
    expect(parsed.get("s2")?.foldedThrough).toBeUndefined();
  });

  it("删会话不影响状态文件，新会话 id 也拿不到旧块", async () => {
    await saveDialogueState("old-session", { current: "旧会话的结论", history: [] }, dir);
    // 模拟删除会话文件：状态文件本来就不在 conversations/ 下。
    await rm(path.join(getPaths(dir).conversations, "old-session.jsonl"), { force: true });

    const states = await loadAllDialogueStates(dir);
    expect(states.get("old-session")?.current).toBe("旧会话的结论");

    const fresh = await loadCurrentDialogueBlock("new-session", dir);
    expect(fresh.text).toBe("");
    expect(fresh.skipped).toBe("empty");
  });

  it("写入一个会话不会覆盖另一个会话", async () => {
    await saveDialogueState("s1", { current: "第一块", history: [] }, dir);
    await saveDialogueState("s2", { current: "第二块", history: [] }, dir);
    await saveDialogueState("s1", { current: "第一块更新", history: [] }, dir);

    const states = await loadAllDialogueStates(dir);
    expect(states.get("s1")?.current).toBe("第一块更新");
    expect(states.get("s2")?.current).toBe("第二块");
  });

  it("「当前有效」超过 2000 token 时整块不注入，并给出原因", async () => {
    await saveDialogueState("s1", { current: "长".repeat(DIALOGUE_STATE_TOKEN_MAX * 2), history: [] }, dir);
    const block = await loadCurrentDialogueBlock("s1", dir);
    expect(block.text).toBe("");
    expect(block.skipped).toBe("too-large");
  });

  it("空状态不注入空块", async () => {
    await saveDialogueState("s1", { current: "   ", history: [] }, dir);
    const state = await loadDialogueState("s1", dir);
    expect(state.current.trim()).toBe("");
    expect((await loadCurrentDialogueBlock("s1", dir)).text).toBe("");
  });
});

describe("游标与窗口", () => {
  const messages: Message[] = [
    msg("u1", "user", "第一问"),
    msg("a1", "assistant", "第一答"),
    msg("u2", "user", "第二问"),
    msg("a2", "assistant", "第二答"),
    msg("u3", "user", "第三问"),
    msg("a3", "assistant", "第三答"),
    msg("u4", "user", "第四问"),
    msg("a4", "assistant", "第四答"),
  ];

  it("保护区是最后 2 轮，起点是第 3 个用户消息", () => {
    expect(protectedTailStart(messages, 2)).toBe(4); // index of u3
    expect(protectedTailStart(messages, 0)).toBe(messages.length);
  });

  it("没有游标时，待处理区间从开头到保护区之前", () => {
    expect(pendingRange(messages, undefined, 2)).toEqual({ start: 0, end: 4 });
  });

  it("有待处理原文时，游标之后的都进窗口（含保护区）", () => {
    // 游标在 a1：窗口应带 u2..a4（全部未折叠原文），而不是只剩最近 2 轮。
    const history = historyAfterCursor(messages, "a1");
    expect(history.map((message) => message.id)).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"]);
  });

  it("游标不存在时不猜，返回原样历史（等价于「窗口仍带现有原文」）", () => {
    const history = historyAfterCursor(messages, "不存在的-id");
    expect(history).toHaveLength(messages.length);
    expect(pendingRange(messages, "不存在的-id", 2)).toBeNull();
  });

  it("折叠完成后，游标之前的原文退出窗口", () => {
    const history = historyAfterCursor(messages, "a2");
    expect(history.map((message) => message.id)).toEqual(["u3", "a3", "u4", "a4"]);
  });

  it("待处理区间不会把保护区算进去", () => {
    // 游标在 a1：待处理从 a1 之后开始，到保护区之前结束（不含 u3/u4 两轮）。
    expect(pendingRange(messages, "a1", 2)).toEqual({ start: 2, end: 4 });
  });
});

describe("分段", () => {
  it("按轮切分，一段一个 turn，不切断工具链", () => {
    const messages: Message[] = [
      msg("u1", "user", "问一"),
      msg("a1", "assistant", null, {
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.md\"}" } }],
      }),
      msg("t1", "tool", "内容一", { tool_call_id: "c1" }),
      msg("a1b", "assistant", "答一"),
      msg("u2", "user", "问二"),
      msg("a2", "assistant", "答二"),
    ];
    const segments = segmentTurns(messages, 1); // 每段只装得下一个 turn
    expect(segments).toHaveLength(2);
    expect(segments[0].map((message) => message.id)).toEqual(["u1", "a1", "t1", "a1b"]);
    expect(segments[1].map((message) => message.id)).toEqual(["u2", "a2"]);
  });
});

describe("大工具结果缩短（§3）", () => {
  it("只缩短游标覆盖范围内、超过 4KB 的 tool 消息", async () => {
    const big = "长".repeat(1600); // ~4.8 KB
    const sessionId = "s1";
    await saveSession({
      id: sessionId,
      title: "t",
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      messages: [
        msg("u1", "user", "读文件"),
        msg("a1", "assistant", null, {
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"reflections/a.md\"}" } }],
        }),
        msg("t1", "tool", big, { tool_call_id: "c1" }),
        msg("a1b", "assistant", "读完了"),
        msg("u2", "user", "再问"),
        msg("a2", "assistant", null, {
          tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{\"path\":\"reflections/b.md\"}" } }],
        }),
        msg("t2", "tool", big, { tool_call_id: "c2" }),
        msg("a2b", "assistant", "又读完了"),
      ],
    }, dir);

    const changed = await trimStubbedToolResults(sessionId, "a1b", silentLogger);
    expect(changed).toBe(1);

    const raw = await readFile(path.join(getPaths(dir).conversations, `${sessionId}.jsonl`), "utf-8");
    const messages = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Message);
    const t1 = messages.find((message) => message.id === "t1");
    const t2 = messages.find((message) => message.id === "t2");
    // 游标覆盖范围内的被缩短，并保留工具名、路径、原字节数。
    expect(String(t1?.content)).toContain("[工具结果已归档]");
    expect(String(t1?.content)).toContain("read");
    expect(String(t1?.content)).toContain("reflections/a.md");
    // 游标之后的保持全文（当轮推理还要用）。
    expect(t2?.content).toBe(big);
  });

  it("4KB 以内保持原文", async () => {
    const small = "短".repeat(100);
    const sessionId = "s2";
    await saveSession({
      id: sessionId,
      title: "t",
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      messages: [
        msg("u1", "user", "读"),
        msg("a1", "assistant", null, {
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
        }),
        msg("t1", "tool", small, { tool_call_id: "c1" }),
        msg("a1b", "assistant", "好"),
      ],
    }, dir);

    expect(Buffer.byteLength(small, "utf-8")).toBeLessThan(TOOL_STUB_BYTES);
    expect(await trimStubbedToolResults(sessionId, "a1b", silentLogger)).toBe(0);
  });
});

describe("阈值", () => {
  it("8000 只是触发阈值，不是输出上限", () => {
    expect(FOLD_TRIGGER_TOKENS).toBe(8000);
    // 状态块的上限单列，远小于触发阈值：注入的永远是一块，不是整批。
    expect(DIALOGUE_STATE_TOKEN_MAX).toBeLessThan(FOLD_TRIGGER_TOKENS);
  });
});

describe("折叠失败不破坏旧状态", () => {
  it("模型返回空时不保存、不挪游标", async () => {
    const { foldDialogueState } = await import("./dialogue-fold.js");
    await saveDialogueState("s1", { current: "旧结论", history: [], foldedThrough: "a1" }, dir);
    await saveSession({
      id: "s1",
      title: "t",
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      messages: [
        msg("u1", "user", "问"),
        msg("a1", "assistant", "答"),
        msg("u2", "user", "再问".repeat(5000)),
        msg("a2", "assistant", "再答"),
        msg("u3", "user", "第三问"),
        msg("a3", "assistant", "第三答"),
        msg("u4", "user", "第四问"),
        msg("a4", "assistant", "第四答"),
      ],
    }, dir);

    // 空返回：不空跑网络，直接给一个假 provider。
    const fakeProvider = { complete: async () => ({ content: "   " }) };
    const result = await foldDialogueState("s1", {
      compaction: { provider: "zai", model: "glm-4.5-air", keepRecentRounds: 0, thinkingEffort: "off" },
      providers: { zai: { apiKey: "k", baseUrl: "https://example.invalid", models: [{ id: "glm-4.5-air", label: "x" }] } },
      contextMaxTokens: 100_000,
    } as never, silentLogger, { force: true, provider: fakeProvider as never });

    expect(result.outcome).toBe("failed");
    const state = await loadDialogueState("s1", dir);
    expect(state.current).toBe("旧结论");
    expect(state.foldedThrough).toBe("a1");
  });
});

describe("折叠成功", () => {
  it("推进游标、旧块进入沿革、新块成为当前有效", async () => {
    const { foldDialogueState } = await import("./dialogue-fold.js");
    const fakeProvider = {
      complete: async () => ({
        content: "## 硬约束\n必须用 pnpm\n\n## 已定结论\n通知走 WebSocket\n\n## 未决问题\n无\n\n## 重要事实\n无",
        usage: { inputTokens: 100, outputTokens: 50, billingOutputTokens: 50 },
      }),
    };

    await saveDialogueState("s1", { current: "旧的当前有效", history: [], foldedThrough: "a1" }, dir);
    await saveSession({
      id: "s1",
      title: "t",
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      messages: [
        msg("u1", "user", "问"),
        msg("a1", "assistant", "答"),
        msg("u2", "user", `再问${"细节".repeat(3000)}`),
        msg("a2", "assistant", "再答"),
        msg("u3", "user", "第三问"),
        msg("a3", "assistant", "第三答"),
        msg("u4", "user", "第四问"),
        msg("a4", "assistant", "第四答"),
      ],
    }, dir);

    const result = await foldDialogueState("s1", {
      compaction: { provider: "zai", model: "glm-4.5-air", keepRecentRounds: 0, thinkingEffort: "off" },
      providers: { zai: { apiKey: "k", baseUrl: "https://example.invalid", models: [{ id: "glm-4.5-air", label: "x" }] } },
      contextMaxTokens: 100_000,
    } as never, silentLogger, { force: true, provider: fakeProvider as never });

    expect(result.outcome).toBe("folded");
    const state = await loadDialogueState("s1", dir);
    expect(state.current).toContain("必须用 pnpm");
    // 旧块整块进入沿革，正文不改。
    expect(state.history.at(-1)?.text).toBe("旧的当前有效");
    // 游标推进到这一批的最后一条，且没有越过保护区。
    expect(state.foldedThrough).toBe("a2");
  });
});
