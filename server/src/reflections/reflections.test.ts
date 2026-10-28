import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAND_SLUG } from "../brand.js";
import { parseOccurredLine, parseReflectionPaste } from "./parse.js";
import {
  createReflection,
  deleteReflection,
  importReflections,
  listReflectionTree,
  listReflections,
  mkdirReflection,
  moveReflection,
  organizeReflectionByDate,
  readReflection,
  resolveReflectionPath,
  updateReflection,
} from "./store.js";

describe("parseReflectionPaste", () => {
  it("parses title, chinese datetime+context, and body", () => {
    const items = parseReflectionPaste(
      ["想法的 时刻 独占性", "2026年10月28日11:28:28 于大沙河散步时，姆巴佩事件", "", "xxx正文xxx"].join("\n"),
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("想法的 时刻 独占性");
    expect(items[0].occurredAt).toBe("2026-10-28T11:28:28+08:00");
    expect(items[0].context).toBe("于大沙河散步时，姆巴佩事件");
    expect(items[0].body).toContain("xxx正文xxx");
  });

  it("splits multiple notes by blank lines", () => {
    const items = parseReflectionPaste(
      ["一", "2026年1月1日10:00:00 A地", "正文1", "", "二", "2026年1月2日10:00:00 B地", "正文2"].join("\n"),
    );
    expect(items.map((item) => item.title)).toEqual(["一", "二"]);
  });
});

describe("parseOccurredLine", () => {
  it("keeps non-datetime remainder as context", () => {
    expect(parseOccurredLine("2026年10月28日11:28:28 于大沙河散步时").context).toBe("于大沙河散步时");
  });
});

describe("reflections store", () => {
  let testDir = "";

  afterEach(async () => {
    if (!testDir) return;
    const { rm } = await import("node:fs/promises");
    await rm(testDir, { recursive: true, force: true });
    testDir = "";
  });

  async function setup() {
    testDir = await mkdtemp(path.join(tmpdir(), `${BRAND_SLUG}-reflections-`));
    await mkdir(path.join(testDir, "inputs"), { recursive: true });
    return testDir;
  }

  it("creates into inbox, lists by occurredAt, updates and deletes", async () => {
    const dir = await setup();
    const created = await createReflection({
      title: "想法的 时刻 独占性",
      occurredAt: "2026-10-28T11:28:28+08:00",
      context: "于大沙河散步时，姆巴佩事件",
      body: "xxx正文xxx",
      userDataDir: dir,
    });
    expect(created.path).toBe("inputs/reflections/inbox/想法的 时刻 独占性.md");
    expect(created.folder).toBe("inbox");

    const listed = await listReflections({ userDataDir: dir });
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("想法的 时刻 独占性");

    const updated = await updateReflection({
      path: created.path,
      body: "改过的正文",
      userDataDir: dir,
    });
    expect(updated.body).toContain("改过的正文");

    await deleteReflection(created.path, dir);
    expect(await listReflections({ userDataDir: dir })).toHaveLength(0);
  });

  it("lists dragged files without front matter", async () => {
    const dir = await setup();
    const folder = path.join(dir, "inputs", "reflections", "从记事本");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "旧笔记.txt"), "只有正文\n第二行", "utf-8");
    const listed = await listReflections({ userDataDir: dir });
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("旧笔记");
    expect(listed[0].path).toBe("inputs/reflections/从记事本/旧笔记.txt");
    const doc = await readReflection(listed[0].path, dir);
    expect(doc.body).toContain("只有正文");
  });

  it("rejects path escape", () => {
    expect(() => resolveReflectionPath("../config.json", "/tmp/x")).toThrow(/路径不允许/);
  });

  it("converts txt to md on first save", async () => {
    const dir = await setup();
    const folder = path.join(dir, "inputs", "reflections", "inbox");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "草稿.txt"), "正文", "utf-8");
    const updated = await updateReflection({
      path: "inputs/reflections/inbox/草稿.txt",
      title: "草稿",
      body: "新正文",
      userDataDir: dir,
    });
    expect(updated.path).toBe("inputs/reflections/inbox/草稿.md");
    expect(updated.body).toContain("新正文");
  });

  it("moves, organizes by date, imports batch, and builds tree", async () => {
    const dir = await setup();
    await mkdirReflection("主题A", dir);
    const created = await createReflection({
      title: "散步",
      occurredAt: "2026-10-28T11:28:28+08:00",
      context: "大沙河",
      body: "正文",
      folder: "inbox",
      userDataDir: dir,
    });
    const moved = await moveReflection({ from: created.path, toFolder: "主题A", userDataDir: dir });
    expect(moved.path).toBe("inputs/reflections/主题A/散步.md");

    const organized = await organizeReflectionByDate(moved.path, dir);
    expect(organized.path).toBe("inputs/reflections/2026/10/散步.md");

    const batch = await importReflections({
      text: ["甲", "2026年1月1日08:00:00 公园", "文1", "", "乙", "2026年1月2日09:00:00 家", "文2"].join("\n"),
      folder: "inbox",
      userDataDir: dir,
    });
    expect(batch.reflections).toHaveLength(2);

    const tree = await listReflectionTree(dir);
    const names = tree.map((node) => node.name);
    expect(names).toContain("2026");
    expect(names).toContain("inbox");
  });
});
