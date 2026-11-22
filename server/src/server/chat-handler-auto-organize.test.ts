import { afterEach, describe, expect, it, vi } from "vitest";
import { createPerson, readEntries } from "../people/store.js";
import { recordPersonInput } from "../people/input.js";
import { setOrganizeCompleter, waitForAutoOrganize } from "../people/auto-organize.js";
import { setupTestDir } from "../test-utils.js";
import type { Config } from "../config/index.js";

const sent: Array<Record<string, unknown>> = [];
let chatStreamFinished = false;

vi.mock("./send.js", () => ({
  sendToClient: (_client: unknown, message: Record<string, unknown>) => {
    sent.push(message);
  },
}));

vi.mock("./services/usage-store.js", () => ({
  appendUsageRecord: async () => undefined,
}));

vi.mock("./services/chat-content.js", () => ({
  // 正文原样交给会话；`contextSuffix` 由 chat-handler 自己拼，测试里不验它。
  buildAugmentedUserContent: (content: string) => ({
    llmUserContent: content,
    persistedUserContent: content,
  }),
}));

vi.mock("../chat/index.js", () => ({
  chatStream: async function* () {
    yield { done: false, chunk: "好" };
    chatStreamFinished = true;
    yield { done: true };
  },
}));

vi.mock("../session/index.js", () => ({
  loadSession: async () => ({ id: "s1", title: "分析", messages: [] }),
  replaceLastAssistantContent: async () => undefined,
}));

/** 只填这条路径读到的字段。 */
function configWith(autoOrganize: boolean): Config {
  return {
    autoOrganize,
    // 这条测试验的是「chatEnd 之后启动」，不是节奏；节奏另有专门用例。
    autoOrganizeCadence: "message",
    autoOrganizeDebounceMs: 0,
    autoOrganizeMinUnits: 0,
    maxTokens: 1024,
    fs: { confirm: "session", policy: { readable: [], writable: [] } },
    compaction: { provider: "zai", model: "glm-4.5-air", thinkingEffort: "off", keepRecentRounds: 0 },
    providers: {},
  } as unknown as Config;
}

afterEach(() => {
  sent.length = 0;
  chatStreamFinished = false;
  setOrganizeCompleter(undefined);
});

describe("processChatMessage auto organize hook", () => {
  it("runs after chatEnd and never delays the reply", async () => {
    const dir = await setupTestDir("chat-handler-auto-organize");
    const { person } = await createPerson("阿宁", dir);

    let organizeStartedAfterReply = false;
    let replyResolved = false;
    setOrganizeCompleter(async () => {
      organizeStartedAfterReply = replyResolved;
      return { raw: "她提到周五搬家。\n<<<当前>>>\n先别追问搬家的事。" };
    });

    const { processChatMessage } = await import("./chat-handler.js");
    const client = { ws: {} as never, isAlive: true, writePermOpen: false };

    await processChatMessage({
      client,
      sessionId: "s1",
      content: "她说周五要搬家",
      provider: "zai",
      model: "GLM-4.7",
      threadPath: `people/${person.id}`,
      pendingPermissions: new Map(),
      config: configWith(true),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
    });
    replyResolved = true;

    // 回复先推送完。
    expect(chatStreamFinished).toBe(true);
    expect(sent.some((event) => event.type === "chatEnd")).toBe(true);
    // 原文在回复之前就已经落盘。
    expect((await readEntries(person.id, dir)).map((entry) => entry.text)).toEqual(["她说周五要搬家"]);

    // 自动整理是后台任务，此刻可能仍在跑；等它收尾。
    await waitForAutoOrganize(person.id);
    expect(organizeStartedAfterReply).toBe(true);

    const { getPersonRecord } = await import("../people/store.js");
    const after = await getPersonRecord(person.id, dir);
    expect(after.digest).toContain("她提到周五搬家。");
    expect(after.current).toContain("先别追问搬家的事。");
  });

  it("does not organize when the switch is off", async () => {
    const dir = await setupTestDir("chat-handler-auto-organize-off");
    const { person } = await createPerson("阿宁", dir);
    let called = 0;
    setOrganizeCompleter(async () => {
      called += 1;
      return { raw: "简报。" };
    });

    const { processChatMessage } = await import("./chat-handler.js");
    await processChatMessage({
      client: { ws: {} as never, isAlive: true, writePermOpen: false },
      sessionId: "s1",
      content: "有内容",
      provider: "zai",
      model: "GLM-4.7",
      threadPath: `people/${person.id}`,
      pendingPermissions: new Map(),
      config: configWith(false),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
    });
    await waitForAutoOrganize(person.id);

    expect(called).toBe(0);
    const { getPersonRecord } = await import("../people/store.js");
    const record = await getPersonRecord(person.id, dir);
    expect(record.digest).not.toContain("简报。");
  });
});

describe("auto organize raw input precondition", () => {
  it("keeps the raw text on disk even when the model fails", async () => {
    const dir = await setupTestDir("chat-handler-auto-organize-fail");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "原话还在", dir);
    setOrganizeCompleter(async () => {
      throw new Error("模型挂了");
    });
    const { scheduleAutoOrganize } = await import("../people/auto-organize.js");
    const result = await scheduleAutoOrganize(
      person.id,
      configWith(true),
      { info: () => undefined, warn: () => undefined },
    );
    expect(result).toEqual({ status: "skipped", reason: "error" });
    // 失败不影响已经落盘的原文，也不写简报。
    expect((await readEntries(person.id, dir)).map((entry) => entry.text)).toEqual(["原话还在"]);
    const { getPersonRecord } = await import("../people/store.js");
    expect((await getPersonRecord(person.id, dir)).digest).not.toContain("原话还在");
  });
});
