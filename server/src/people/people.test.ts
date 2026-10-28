import { describe, expect, it } from "vitest";
import { buildPersonContextSuffix, personIdFromThreadPath } from "./context.js";
import { splitOrganizeReply, visibleBeforeMarker, applyOrganizeResult } from "./organize.js";
import { profileHeadingsComplete } from "./profile.js";
import { parseRecognition } from "./recognize.js";
import {
  appendEntry,
  createPerson,
  deleteEntry,
  entriesAfter,
  getPersonRecord,
  pageEntries,
  patchEntry,
  readEntries,
  saveProfileDocument,
  updatePersonNames,
} from "./store.js";
import { setupTestDir } from "../test-utils.js";

describe("people", () => {
  it("opens an existing person when the label matches", async () => {
    const dir = await setupTestDir("people-dedupe");
    const created = await createPerson(" 阿宁 ", dir);
    const again = await createPerson("阿宁", dir);
    expect(created.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.person.id).toBe(created.person.id);
    const record = await getPersonRecord(created.person.id, dir);
    expect(record.profile).toContain("- 称呼：阿宁");
    expect(record.digest).toContain("schemaVersion: 1");
    expect(record.person.organizedAt).toBeUndefined();
  });

  it("keeps the briefing cursor when an already written line changes", async () => {
    const dir = await setupTestDir("people-cursor");
    const { person } = await createPerson("阿宁", dir);
    const first = await appendEntry(person.id, { kind: "line", speaker: "them", text: "周五见" }, dir);
    await applyOrganizeResult(person.id, "约定周五见面。", first.entry.at, dir);
    const second = await appendEntry(person.id, { kind: "note", text: "我有点犹豫" }, dir);
    await patchEntry(person.id, first.entry.id, { text: "周五不见" }, dir);
    await deleteEntry(person.id, second.entry.id, dir);
    const record = await getPersonRecord(person.id, dir);
    expect(record.digest).toContain("约定周五见面。");
    expect(record.person.organizedAt).toBe(first.entry.at);
    const fresh = entriesAfter(await readEntries(person.id, dir), record.person.organizedAt);
    expect(fresh).toEqual([]);
    const third = await appendEntry(person.id, { kind: "line", speaker: "me", text: "改到周六" }, dir);
    expect(entriesAfter(await readEntries(person.id, dir), record.person.organizedAt).map((entry) => entry.id)).toEqual([third.entry.id]);
  });

  it("appends a briefing and pages the raw log", async () => {
    const dir = await setupTestDir("people-page");
    const { person } = await createPerson("阿宁", dir);
    const saved = [];
    for (let index = 0; index < 3; index += 1) {
      saved.push(await appendEntry(person.id, { kind: "line", speaker: "them", text: `第${index}句` }, dir));
    }
    const page = pageEntries(await readEntries(person.id, dir), saved[2].entry.id, 1);
    expect(page.entries.map((entry) => entry.text)).toEqual(["第1句"]);
    expect(page.hasMore).toBe(true);
    await applyOrganizeResult(person.id, "前三句。\n<<<档案>>>\n不是档案", saved[2].entry.at, dir);
    const record = await getPersonRecord(person.id, dir);
    expect(record.digest.endsWith("前三句。\n")).toBe(true);
    expect(record.profile).toContain("- 称呼：阿宁");
    expect(record.person.organizedAt).toBe(saved[2].entry.at);
  });

  it("rejects a profile that drops a heading, and syncs names", async () => {
    const dir = await setupTestDir("people-profile");
    const { person } = await createPerson("阿宁", dir);
    const record = await getPersonRecord(person.id, dir);
    await expect(saveProfileDocument(person.id, "只有一句", dir)).rejects.toThrow("档案标题不完整");
    const edited = record.profile
      .replace("- 称呼：阿宁", "- 称呼：小林")
      .replace("- 昵称：", "- 昵称：宁宁、小宁");
    const saved = await saveProfileDocument(person.id, edited, dir);
    expect(saved.name).toBe("小林");
    expect(saved.nicknames).toEqual(["宁宁", "小宁"]);
    const renamed = await updatePersonNames(person.id, { name: "小林" }, dir);
    expect(renamed.name).toBe("小林");
    await expect(createPerson("小宁", dir)).resolves.toMatchObject({ created: false, person: { id: person.id } });
  });

  it("splits the archive marker without sending a partial marker", () => {
    expect(visibleBeforeMarker("你好<<<档案")).toBe("你好");
    expect(visibleBeforeMarker("你好<<<档案>>>档案正文")).toBe("你好");
    expect(splitOrganizeReply("  新的一段  \n<<<档案>>>\n## 基本信息")).toEqual({
      brief: "新的一段",
      profile: "## 基本信息",
    });
    expect(personIdFromThreadPath("inputs/people/abc123")).toBe("abc123");
    expect(profileHeadingsComplete("无")).toBe(false);
    expect(parseRecognition('{"error":"group"}')).toEqual({ error: "group" });
    expect(parseRecognition('{"lines":[{"speaker":"me","text":"在"}]}')).toEqual({ lines: [{ speaker: "me", text: "在" }] });
    const suffix = buildPersonContextSuffix({ id: "abc123", profile: "档案" });
    expect(suffix).toContain("历史简报路径：inputs/people/abc123/digest.md");
    expect(suffix).not.toContain("不一定与当前对话直接相关");
  });
});
