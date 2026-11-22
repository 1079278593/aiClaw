/**
 * 人物分析会话的折叠（plan_people_reply §7 阶段 3）。
 *
 * 要证明的四件事，都不能靠人工检查：
 * 1. 判据是 `session.fold`，不是「是不是心得那条」：人物会话同样折叠；
 * 2. 人物会话的折叠提示词多两句（否定过的回法进硬约束、排除过的进已定结论）；
 * 3. 折叠状态按会话 id 分开：另一条会话看不到这条的「当前有效」；
 * 4. 删人物会话连状态块一起删；心得会话删了仍保留状态（人的长期结论）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Session } from "../types/index.js";
import { ensureDirectories, getPaths } from "../config/paths.js";
import { createSession, loadSession, saveSession, setSessionFold } from "../session/index.js";
import { saveAppState } from "../app-state/index.js";
import {
  loadDialogueState,
  removeDialogueState,
  resetDialogueCursor,
  saveDialogueState,
} from "./dialogue-state.js";

let dir = "";
/** 每次调用模型时实际收到的消息，用于断言「发了什么」。 */
const captured: Message[][] = [];

const fakeProvider = {
  label: "fake",
  async complete(_key: string, messages: Message[]) {
    captured.push(messages);
    return { content: "好的", finish_reason: "stop" };
  },
  async *stream(_key: string, messages: Message[]) {
    captured.push(messages);
    yield { type: "content" as const, text: "好的" };
    return { finish_reason: "stop" };
  },
};

vi.mock("../llm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/index.js")>("../llm/index.js");
  return { ...actual, createProvider: () => fakeProvider };
});

const config = {
  providers: {
    zai: {
      apiKey: "k",
      baseUrl: "https://example.invalid",
      models: [{ id: "glm-4.5-air", label: "x", contextWindow: 200_000 }],
    },
  },
  defaultProvider: "zai",
  defaultModel: "glm-4.5-air",
  defaultThinkingEffort: "off",
  maxTokens: 4096,
  contextMaxTokens: 100_000,
  contextMaxMessages: 0,
  injectRootIndex: false,
  injectDistillMap: false,
  autoRefreshDistill: false,
  autoOrganize: false,
  autoOrganizeCadence: "message",
  autoOrganizeDebounceMs: 0,
  autoOrganizeMinUnits: 0,
  maxToolCalls: 10,
  server: { port: 3000, host: "127.0.0.1", accessToken: "", corsOrigins: [] },
  fs: { policy: { readable: [], writable: [], denied: [] }, allowedFiles: [] },
  tools: { tavily: { enabled: false }, trilium: { enabled: false } },
  compaction: { provider: "zai", model: "glm-4.5-air", thinkingEffort: "off", keepRecentRounds: 0 },
};

function msg(id: string, role: Message["role"], content: string): Message {
  return { id, role, content, timestamp: "2026-11-19T00:00:00.000Z" };
}

async function seedSession(session: Partial<Session> & { id: string; messages: Message[] }) {
  await saveSession({
    title: "分析",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...session,
  }, dir);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aiclaw-person-fold-"));
  process.env.AICLAW_DATA_DIR = dir;
  await ensureDirectories(getPaths(dir));
  captured.length = 0;
});

/** 把某一轮请求拼成一段文本，方便断言「某句话到底发没发」。 */
function payloadOf(index = 0): string {
  return (captured[index] ?? []).map((message) => String(message.content)).join("\n");
}

function systemOf(index = 0): string {
  return (captured[index] ?? [])
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n");
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("会话元数据", () => {
  it("人物会话建出来就带 fold:true，普通聊天不带", async () => {
    const person = await createSession(undefined, dir, "personA");
    expect(person.fold).toBe(true);
    expect((await loadSession(person.id, dir)).fold).toBe(true);

    const chat = await createSession("普通", dir);
    expect(chat.fold).toBeUndefined();
    expect((await loadSession(chat.id, dir)).fold).toBeUndefined();
  });

  it("心得会话绑定之后补写 fold，且同值不重写", async () => {
    const session = await createSession("心得", dir);
    const before = (await loadSession(session.id, dir)).updatedAt;
    await setSessionFold(session.id, true, dir);
    const after = await loadSession(session.id, dir);
    expect(after.fold).toBe(true);
    expect(after.updatedAt).not.toBe(before);
    // 同值再写一次不刷新 updatedAt（避免每轮装配都把会话写脏）。
    await setSessionFold(session.id, true, dir);
    expect((await loadSession(session.id, dir)).updatedAt).toBe(after.updatedAt);
  });
});

describe("窗口装配", () => {
  it("人物会话的折叠状态只注入自己那条，另一条看不到", async () => {
    const { chatStream } = await import("./index.js");
    await saveAppState({ recentModels: [] }, dir);

    const a = await createSession(undefined, dir, "personA");
    const b = await createSession(undefined, dir, "personA");
    await saveDialogueState(a.id, {
      current: "## 硬约束\n不要直接否定他",
      history: [],
      foldedThrough: "a2",
    }, dir);
    await seedSession({
      id: a.id,
      personId: "personA",
      fold: true,
      messages: [
        msg("u1", "user", "第一问的独特标记"),
        msg("a1", "assistant", "第一答"),
        msg("u2", "user", "第二问的独特标记"),
        msg("a2", "assistant", "第二答"),
        msg("u3", "user", "第三问"),
        msg("a3", "assistant", "第三答"),
        msg("u4", "user", "第四问"),
        msg("a4", "assistant", "第四答"),
      ],
    });

    for await (const _chunk of chatStream(a.id, "第五问", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }
    const systemText = systemOf(0);
    const payload = payloadOf(0);
    expect(systemText).toContain("不要直接否定他");
    // 游标之前的原文不再发送。
    expect(payload).not.toContain("第一问的独特标记");

    // 另一条同一个人物的会话：没有自己的状态，也就不注入那条「不要直接否定他」。
    captured.length = 0;
    await seedSession({
      id: b.id,
      personId: "personA",
      fold: true,
      messages: [msg("u1", "user", "另一条会话的独有标记")],
    });
    for await (const _chunk of chatStream(b.id, "继续", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }
    expect(systemOf(0)).not.toContain("不要直接否定他");
    // 这条会话自己的原文在窗口里。
    expect(payloadOf(0)).toContain("另一条会话的独有标记");
  });

  it("普通聊天不折叠：旧原文照常全部发送，也不注入对话状态", async () => {
    const { chatStream } = await import("./index.js");
    const chat = await createSession("普通", dir);
    await saveDialogueState(chat.id, { current: "不该注入", history: [], foldedThrough: "a1" }, dir);
    await seedSession({
      id: chat.id,
      messages: [
        msg("u1", "user", "普通会话第一问"),
        msg("a1", "assistant", "第一答"),
        msg("u2", "user", "普通会话第二问"),
        msg("a2", "assistant", "第二答"),
      ],
    });

    for await (const _chunk of chatStream(chat.id, "第三问", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }
    expect(systemOf(0)).not.toContain("不该注入");
    // 没有游标可依据：历史里的原文照常全部发送。
    expect(payloadOf(0)).toContain("普通会话第一问");
  });
});

describe("人物会话的折叠提示词", () => {
  it("人物会话加那两句；心得会话不加", async () => {
    const { foldDialogueState } = await import("./dialogue-fold.js");
    /** 折叠模型只关心 system 提示词，这里单独收一份，与窗口装配的捕获分开。 */
    const foldPrompts: string[] = [];
    const fake = {
      complete: async (_key: string, messages: Message[]) => {
        foldPrompts.push(messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"));
        return {
          content: "## 硬约束\n不要直接否定\n\n## 已定结论\n无\n\n## 未决问题\n无\n\n## 重要事实\n无",
          usage: { inputTokens: 10, outputTokens: 10, billingOutputTokens: 10 },
        };
      },
    };
    const long = `细节${"内容".repeat(8000)}`;
    await seedSession({
      id: "p1",
      personId: "personA",
      fold: true,
      messages: [
        msg("u1", "user", long),
        msg("a1", "assistant", "答"),
        msg("u2", "user", "再问"),
        msg("a2", "assistant", "再答"),
        msg("u3", "user", "第三问"),
        msg("a3", "assistant", "第三答"),
      ],
    });

    const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never;

    await foldDialogueState("p1", config as never, silent, { domain: "person", provider: fake as never });
    expect(foldPrompts[0]).toContain("帮我回复某个人");
    expect(foldPrompts[0]).toContain("为什么不要");

    // 硬断言：折叠之后那句原话确实落在「硬约束」里，并且下一轮装配会带上它。
    const state = await loadDialogueState("p1", dir);
    expect(state.current).toContain("不要直接否定");
    expect(state.foldedThrough).toBeTruthy();

    captured.length = 0;
    for await (const _chunk of (await import("./index.js")).chatStream("p1", "再帮我看看这段", config as never, {
      provider: "zai", model: "glm-4.5-air",
    })) {
      // 消费完即可
    }
    expect(systemOf(0)).toContain("不要直接否定");
  });

  it("被否定的回法原话在下一轮仍逐字在硬约束里", async () => {
    const { foldDialogueState } = await import("./dialogue-fold.js");
    // 模拟模型按提示词做事：把用户原话抄进硬约束。
    const original = "不要直接否定他，别说「你想多了」";
    const fake = {
      complete: async () => ({
        content: `## 硬约束\n${original}\n\n## 已定结论\n直接反问 + 会让他觉得被审判\n\n## 未决问题\n无\n\n## 重要事实\n无`,
      }),
    };
    await seedSession({
      id: "p2",
      personId: "personB",
      fold: true,
      messages: [
        msg("u1", "user", `情境${"描述".repeat(8000)}`),
        msg("a1", "assistant", "建议 A"),
        msg("u2", "user", "这样不行"),
        msg("a2", "assistant", "换成建议 B"),
        msg("u3", "user", "第三问"),
        msg("a3", "assistant", "第三答"),
      ],
    });
    const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never;
    await foldDialogueState("p2", config as never, silent, { domain: "person", provider: fake as never });

    const state = await loadDialogueState("p2", dir);
    expect(state.current).toContain(original);
    // 被排除的回法留下的是「回法 + 为什么不要」。
    expect(state.current).toContain("会让他觉得被审判");
  });
});

describe("状态块的生命周期", () => {
  it("删人物会话连状态一起删；心得会话的状态保留", async () => {
    await saveDialogueState("person-1", { current: "人物结论", history: [] }, dir);
    await saveDialogueState("reflect-1", { current: "心得结论", history: [] }, dir);

    expect(await removeDialogueState("person-1", dir)).toBe(true);
    expect((await loadDialogueState("person-1", dir)).current).toBe("");
    // 别人的块不受影响。
    expect((await loadDialogueState("reflect-1", dir)).current).toBe("心得结论");
    // 已经删过再删一次：不报错，返回 false。
    expect(await removeDialogueState("person-1", dir)).toBe(false);
  });

  it("截断之后游标归零，结论保留，下一次还能折叠", async () => {
    await saveDialogueState("s1", {
      current: "## 硬约束\n必须用 pnpm",
      history: [{ at: "2026-11-01T00:00:00.000Z", text: "旧块" }],
      foldedThrough: "a2",
    }, dir);

    expect(await resetDialogueCursor("s1", dir)).toBe(true);
    const state = await loadDialogueState("s1", dir);
    expect(state.foldedThrough).toBeUndefined();
    expect(state.current).toContain("必须用 pnpm");
    expect(state.history).toHaveLength(1);

    // 没有游标的会话再重置一次：无事可做。
    expect(await resetDialogueCursor("s1", dir)).toBe(false);
  });
});
