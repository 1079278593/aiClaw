import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPersonContextSuffix, personIdFromThreadPath } from "./context.js";
import { splitOrganizeReply, visibleBeforeMarker, applyOrganizeResult } from "./organize.js";
import { CURRENT_CHAR_LIMIT, profileHeadingsComplete } from "./profile.js";
import { parseRecognition } from "./recognize.js";
import {
  appendDigest,
  appendEntry,
  createPerson,
  deleteEntry,
  entriesAfter,
  getPersonRecord,
  markOrganizeDay,
  pageEntries,
  patchEntry,
  personIdFromCurrentPath,
  readEntries,
  recordOrganizeOutcome,
  replaceCurrent,
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

  it("13. 空 digest 追加是 no-op；25. 档案砍半被拒绝，summary 含「精简」时放行", async () => {
    const dir = await setupTestDir("people-guards");
    const { person } = await createPerson("阿宁", dir);
    const before = await getPersonRecord(person.id, dir);

    // 空/纯空白追加不写盘。
    await appendDigest(person.id, "   \n  ", new Date().toISOString(), dir);
    expect((await getPersonRecord(person.id, dir)).digest).toBe(before.digest);

    // 构造一个长档案（40 个条目），再砍到只有标题骨架。
    const longProfile = before.profile.replace(
      "## 个人资料\n\n无",
      `## 个人资料\n\n${Array.from({ length: 40 }, (_, i) => `- 事实${i}`).join("\n")}`,
    );
    await saveProfileDocument(person.id, longProfile, dir);
    const shrunk = longProfile.replace(/\n- 事实\d+/g, "");
    await expect(saveProfileDocument(person.id, shrunk, dir)).rejects.toThrow(/精简/);
    // 没写进去。
    expect((await getPersonRecord(person.id, dir)).profile).toContain("事实19");

    // summary 显式写「精简」时放行。
    await saveProfileDocument(person.id, shrunk, dir, { summary: "用户要求精简档案" });
    expect((await getPersonRecord(person.id, dir)).profile).not.toContain("事实19");
  });

  it("splits the archive marker without sending a partial marker", () => {    expect(visibleBeforeMarker("你好<<<档案")).toBe("你好");
    expect(visibleBeforeMarker("你好<<<档案>>>档案正文")).toBe("你好");    expect(splitOrganizeReply("  新的一段  \n<<<档案>>>\n## 基本信息")).toEqual({
      brief: "新的一段",
      profile: "## 基本信息",
    });
    expect(personIdFromThreadPath("people/abc123")).toBe("abc123");
    expect(profileHeadingsComplete("无")).toBe(false);
    expect(parseRecognition('{"error":"group"}')).toEqual({ error: "group" });
    expect(parseRecognition('{"lines":[{"speaker":"me","text":"在"}]}')).toEqual({ lines: [{ speaker: "me", text: "在" }] });
    const suffix = buildPersonContextSuffix({ id: "abc123", profile: "档案" });
    expect(suffix).toContain("历史简报路径：people/abc123/digest.md");
    expect(suffix).not.toContain("不一定与当前对话直接相关");
  });

  it("creates current.md empty and injects it whole when present", async () => {
    const dir = await setupTestDir("people-current");
    const { person } = await createPerson("阿宁", dir);
    // 新建时就有这一份文件，与 digest.md 一样只有版本头。
    const created = await getPersonRecord(person.id, dir);
    expect(created.current).toContain("schemaVersion: 1");

    // 为空时整段不注入，不占窗口。
    const emptySuffix = buildPersonContextSuffix({ id: person.id, profile: created.profile, current: created.current });
    expect(emptySuffix).not.toContain("当前判断（整篇");
    expect(emptySuffix).not.toContain("以当前判断为准");

    const written = await replaceCurrent(person.id, "先别追问搬家的事。\n只有她自己提再问。", dir);
    expect(written).toEqual({ written: true, length: "先别追问搬家的事。\n只有她自己提再问。".length });

    const record = await getPersonRecord(person.id, dir);
    expect(record.current).toContain("先别追问搬家的事。");
    // 整篇注入，而不是给路径。
    const suffix = buildPersonContextSuffix({ id: person.id, profile: record.profile, current: record.current });
    expect(suffix).toContain("先别追问搬家的事。");
    expect(suffix).toContain("当前判断与历史简报不一致时，以当前判断为准。");
  });

  it("refuses a current.md over the limit and keeps the previous one", async () => {
    const dir = await setupTestDir("people-current-limit");
    const { person } = await createPerson("阿宁", dir);
    await replaceCurrent(person.id, "短的旧判断。", dir);

    const tooLong = "长".repeat(CURRENT_CHAR_LIMIT + 1);
    const result = await replaceCurrent(person.id, tooLong, dir);
    expect(result).toEqual({ written: false, length: CURRENT_CHAR_LIMIT + 1 });
    expect((await getPersonRecord(person.id, dir)).current).toContain("短的旧判断。");

    // 恰好等于上限时放行（上限是「不超过」）。
    const exact = "长".repeat(CURRENT_CHAR_LIMIT);
    expect((await replaceCurrent(person.id, exact, dir)).written).toBe(true);
  });

  it("maps current.md paths and ignores the version header when measuring", async () => {
    expect(personIdFromCurrentPath("people/abc123/current.md")).toBe("abc123");
    expect(personIdFromCurrentPath("people/abc123/digest.md")).toBeUndefined();
    const dir = await setupTestDir("people-current-header");
    const { person } = await createPerson("阿宁", dir);
    // 1500 字上限只算正文，版本头不算。
    const body = "短".repeat(CURRENT_CHAR_LIMIT);
    expect((await replaceCurrent(person.id, body, dir)).written).toBe(true);
  });

  it("never moves organizedAt backwards when an older organize finishes last", async () => {
    const dir = await setupTestDir("people-cursor-monotonic");
    const { person } = await createPerson("阿宁", dir);
    const first = await appendEntry(person.id, { kind: "line", speaker: "them", text: "第一句" }, dir);
    const second = await appendEntry(person.id, { kind: "line", speaker: "them", text: "第二句" }, dir);

    // 模拟「自动整理读的是第一个游标、跑得久；这期间手动整理把游标推到了第二句」。
    // 慢的那一份回来时只能停在更远的位置，不能把游标拉回第一句。
    await appendDigest(person.id, "手动整理的段。", second.entry.at, dir);
    await appendDigest(person.id, "慢的自动整理。", first.entry.at, dir);
    const record = await getPersonRecord(person.id, dir);
    expect(record.person.organizedAt).toBe(second.entry.at);
    expect(record.digest).toContain("手动整理的段。");
    expect(record.digest).toContain("慢的自动整理。");
    // 游标没有回退，第二句不会被再整理一次。
    expect(entriesAfter(await readEntries(person.id, dir), record.person.organizedAt)).toEqual([]);
  });

  it("keeps both paragraphs when two organizes write at the same time", async () => {
    const dir = await setupTestDir("people-concurrent-digest");
    const { person } = await createPerson("阿宁", dir);
    const first = await appendEntry(person.id, { kind: "line", speaker: "them", text: "第一句" }, dir);
    const second = await appendEntry(person.id, { kind: "line", speaker: "them", text: "第二句" }, dir);

    // 两条路径（自动 + 手动）同时进来：没有按人串行时，
    // 「整篇读出→拼接→写回」会互相覆盖，丢掉一段。
    await Promise.all([
      appendDigest(person.id, "A 段。", first.entry.at, dir),
      appendDigest(person.id, "B 段。", second.entry.at, dir),
    ]);

    const record = await getPersonRecord(person.id, dir);
    expect(record.digest).toContain("A 段。");
    expect(record.digest).toContain("B 段。");
    expect(record.person.organizedAt).toBe(second.entry.at);
  });

  it("remembers the outcome of the last organize and tolerates a missing field", async () => {
    const dir = await setupTestDir("people-last-organize");
    const { person } = await createPerson("阿宁", dir);
    // 老目录没有这个字段：读出来就是没有，不报错。
    expect((await getPersonRecord(person.id, dir)).person.lastOrganize).toBeUndefined();

    await recordOrganizeOutcome(person.id, {
      at: "2026-05-01T10:00:00.000Z",
      status: "failed",
      message: "整理用的模型没有配置",
    }, dir);
    expect((await getPersonRecord(person.id, dir)).person.lastOrganize).toEqual({
      at: "2026-05-01T10:00:00.000Z",
      status: "failed",
      message: "整理用的模型没有配置",
    });

    // 结局不影响游标：游标只由简报那次写入决定。
    expect((await getPersonRecord(person.id, dir)).person.organizedAt).toBeUndefined();
  });

  it("remembers which day auto organize last ran, and ignores a malformed value", async () => {
    const dir = await setupTestDir("people-organize-window");
    const { person } = await createPerson("阿宁", dir);
    // 老目录没这个字段：说明「今天还没跑过」，不报错。
    expect((await getPersonRecord(person.id, dir)).person.organizeWindow).toBeUndefined();

    await markOrganizeDay(person.id, "2026-05-01", dir);
    expect((await getPersonRecord(person.id, dir)).person.organizeWindow).toEqual({ day: "2026-05-01" });

    // 手写坏的日期不该被当成有效值，否则「每天一轮」会静默失效。
    const file = path.join(dir, "people", person.id, "meta.json");
    const raw = JSON.parse(await fs.readFile(file, "utf-8"));
    raw.organizeWindow = { day: "昨天" };
    await fs.writeFile(file, JSON.stringify(raw), "utf-8");
    expect((await getPersonRecord(person.id, dir)).person.organizeWindow).toBeUndefined();
  });
});
