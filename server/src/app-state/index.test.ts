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
});
