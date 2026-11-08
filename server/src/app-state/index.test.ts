import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { getTestDir } from "../config/paths.js";
import { loadAppState, recordRecentModel, setLastActiveSession } from "./index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let testDir: string;

describe("app state", () => {
  beforeEach(() => {
    testDir = getTestDir();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("preserves app state when changing the active session", async () => {
    await setLastActiveSession("session-1", testDir);

    expect(await loadAppState(testDir)).toEqual({
      lastActiveSessionId: "session-1",
      recentModels: [],
    });
  });

  it("setLastActiveSession does not rewrite the file when session is unchanged", async () => {
    await setLastActiveSession("session-1", testDir);

    const { writeFile } = await import("node:fs/promises");
    const writeMock = vi.mocked(writeFile);
    writeMock.mockClear();

    await setLastActiveSession("session-1", testDir);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("records recent models, dedupes and keeps newest first", async () => {
    await recordRecentModel("zai", "glm-4.7", testDir);
    await recordRecentModel("deepseek", "deepseek-r1", testDir);
    await recordRecentModel("zai", "glm-4.7", testDir);
    await recordRecentModel("zai", "glm-4.6", testDir);
    await recordRecentModel("deepseek", "deepseek-v3", testDir);
    await recordRecentModel("openai", "gpt-4o", testDir);

    expect((await loadAppState(testDir)).recentModels).toEqual([
      { provider: "openai", model: "gpt-4o" },
      { provider: "deepseek", model: "deepseek-v3" },
      { provider: "zai", model: "glm-4.6" },
      { provider: "zai", model: "glm-4.7" },
      { provider: "deepseek", model: "deepseek-r1" },
    ]);
  });

  it("drops invalid recent model entries when loading", async () => {
    const { saveAppState } = await import("./index.js");
    await saveAppState({ recentModels: [{ provider: "zai", model: "" }] }, testDir);

    expect((await loadAppState(testDir)).recentModels).toEqual([]);
  });

  it("14. reflectionsSessionId 跨天保持、不影响 lastActiveSessionId、同值不重写", async () => {
    const { setReflectionsSession, isReflectionsSession, clearReflectionsSession } = await import("./index.js");
    await setLastActiveSession("chat-1", testDir);
    await setReflectionsSession("reflections-1", testDir);

    // 「跨天」：重新从磁盘加载，两个字段都在。
    const state = await loadAppState(testDir);
    expect(state.lastActiveSessionId).toBe("chat-1");
    expect(state.reflectionsSessionId).toBe("reflections-1");
    expect(isReflectionsSession(state, "reflections-1")).toBe(true);
    expect(isReflectionsSession(state, "chat-1")).toBe(false);

    // 幂等：同值不写盘。
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockClear();
    await setReflectionsSession("reflections-1", testDir);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();

    await clearReflectionsSession(testDir);
    const cleared = await loadAppState(testDir);
    expect(cleared.reflectionsSessionId).toBeUndefined();
    expect(cleared.lastActiveSessionId).toBe("chat-1");
  });
});
