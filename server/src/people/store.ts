import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import {
  CURRENT_CHAR_LIMIT,
  EMPTY_CURRENT,
  EMPTY_DIGEST,
  EMPTY_PROFILE,
  currentBody,
  namesFromProfile,
  profileHeadingsComplete,
  profileWithName,
  replaceUneditedName,
  shrinksByHalf,
  summaryAllowsCondense,
} from "./profile.js";

/** 一次整理的结局。`ok` 表示写进去了，`skipped` 表示模型没给出正文，`failed` 表示调用出错。 */
export type OrganizeStatus = "ok" | "skipped" | "failed";

/**
 * 「今天还要不要整理」的判据（plan_people_reply §4 成本）。
 *
 * 单独记这一份，而不是拿 `lastOrganize.at` 现算：
 * 1. 跳过（`skipped`）也算「今天跑过了」，但它的 `at` 是完成时刻，
 *    跨零点跑的那一趟会算到第二天去，用日期字段就没有这个歧义。
 * 2. 用户切到「每条消息都整理」再切回来，`daily` 仍应认得今天已经跑过。
 */
export type OrganizeWindow = {
  /** 北京时间日期（YYYY-MM-DD）。同一天只跑一轮自动整理。 */
  day: string;
};

/**
 * 最近一次整理的结果（自动与手动共用）。
 *
 * 为什么要留下这一份：自动整理跑在 `chatEnd` 之后，失败只进服务端日志，
 * 界面上表现成「当前判断一直不变」，人无从判断是还没跑完还是已经坏了。
 * `at` 是**完成这件事的时钟**，不是简报游标——游标可能因为今天没新原文而不动。
 */
export type OrganizeOutcome = {
  at: string;
  status: OrganizeStatus;
  /** 失败或跳过时的原因，界面直接显示。 */
  message?: string;
};

export type Person = {
  id: string;
  name: string;
  nicknames: string[];
  shortNames: string[];
  createdAt: string;
  updatedAt: string;
  organizedAt?: string;
  lastOrganize?: OrganizeOutcome;
  /** 最近一次自动整理算在哪一天。`daily` 节奏用它判断今天是否需要再跑。 */
  organizeWindow?: OrganizeWindow;
};

export type PersonEntry = {
  id: string;
  at: string;
  kind: "line" | "note";
  speaker?: "me" | "them";
  text: string;
};

export class PeopleError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

function peopleRoot(userDataDir?: string): string {
  return getPaths(userDataDir).people;
}

function personDir(id: string, userDataDir?: string): string {
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new PeopleError("文件不存在或已被删除", 404);
  const root = peopleRoot(userDataDir);
  const dir = path.join(root, id);
  if (!dir.startsWith(root + path.sep)) throw new PeopleError("文件不存在或已被删除", 404);
  return dir;
}

function newStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function newId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const byte of randomBytes(4)) suffix += alphabet[byte % alphabet.length];
  return newStamp() + suffix;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

function personFile(person: Person): string {
  const data: Record<string, unknown> = {
    id: person.id,
    name: person.name,
    nicknames: person.nicknames,
    shortNames: person.shortNames,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
  if (person.organizedAt) data.organizedAt = person.organizedAt;
  if (person.lastOrganize) data.lastOrganize = person.lastOrganize;
  if (person.organizeWindow) data.organizeWindow = person.organizeWindow;
  return `${JSON.stringify(data, null, 2)}\n`;
}

function readOutcome(raw: unknown): OrganizeOutcome | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const status = record.status;
  if (status !== "ok" && status !== "skipped" && status !== "failed") return undefined;
  if (typeof record.at !== "string") return undefined;
  return {
    at: record.at,
    status,
    ...(typeof record.message === "string" && record.message ? { message: record.message } : {}),
  };
}

function readWindow(raw: unknown): OrganizeWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const day = (raw as Record<string, unknown>).day;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return { day };
}

async function readPerson(id: string, userDataDir?: string): Promise<Person> {
  try {
    const raw = JSON.parse(await readFile(path.join(personDir(id, userDataDir), "meta.json"), "utf-8")) as Person & {
      lastOrganize?: unknown;
    };
    const lastOrganize = readOutcome(raw.lastOrganize);
    const organizeWindow = readWindow(raw.organizeWindow);
    return {
      id: raw.id,
      name: raw.name ?? "",
      nicknames: Array.isArray(raw.nicknames) ? raw.nicknames : [],
      shortNames: Array.isArray(raw.shortNames) ? raw.shortNames : [],
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(raw.organizedAt ? { organizedAt: raw.organizedAt } : {}),
      ...(lastOrganize ? { lastOrganize } : {}),
      ...(organizeWindow ? { organizeWindow } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PeopleError("文件不存在或已被删除", 404);
    throw error;
  }
}

async function savePerson(person: Person, userDataDir?: string): Promise<void> {
  await writeAtomic(path.join(personDir(person.id, userDataDir), "meta.json"), personFile(person));
}

/**
 * 同一个人的资料写盘串行。
 *
 * `digest.md` 是「整篇读出 → 拼接 → 原子写回」，两条整理路径（自动与手动）同时进来
 * 必然丢一段；`meta.json` 的 `organizedAt` 也是这样被回退的。自动整理那边的
 * `inFlight` 只管得住自动侧，管不住手动「整理」，所以锁要放在 store 这一层。
 */
const personWriteChains = new Map<string, Promise<void>>();

export function withPersonLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = personWriteChains.get(id) ?? Promise.resolve();
  // 前一个写失败不能挡住后一个。
  const run = previous.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  personWriteChains.set(id, tail);
  void tail.then(() => {
    // 队尾跑完就摘掉，别让长驻进程按人累积。
    if (personWriteChains.get(id) === tail) personWriteChains.delete(id);
  });
  return run;
}

/** 游标只前进：整理跑得久，期间别处可能已经推进过更远的位置。 */
function laterStamp(a: string | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function personLabels(person: Pick<Person, "name" | "nicknames" | "shortNames">): string[] {
  return [person.name, ...person.nicknames, ...person.shortNames].map((item) => item.trim()).filter(Boolean);
}

async function assertNamesFree(labels: string[], selfId: string | undefined, userDataDir?: string): Promise<void> {
  const wanted = new Set(labels.map((item) => item.trim()).filter(Boolean));
  if (wanted.size === 0) return;
  for (const person of await listPeople(userDataDir)) {
    if (person.id === selfId) continue;
    if (personLabels(person).some((label) => wanted.has(label))) {
      throw new PeopleError("已经有这个人", 400);
    }
  }
}

export async function listPeople(userDataDir?: string): Promise<Person[]> {
  let names: string[] = [];
  try {
    names = await readdir(peopleRoot(userDataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const people: Person[] = [];
  for (const name of names) {
    try {
      people.push(await readPerson(name, userDataDir));
    } catch (error) {
      if (!(error instanceof PeopleError)) throw error;
    }
  }
  return people;
}

export async function findPersonByLabel(label: string, userDataDir?: string): Promise<Person | undefined> {
  const wanted = label.trim();
  if (!wanted) return undefined;
  return (await listPeople(userDataDir)).find((person) => personLabels(person).includes(wanted));
}

export async function createPerson(name: string, userDataDir?: string): Promise<{ person: Person; created: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) throw new PeopleError("称呼不能为空", 400);
  const existing = await findPersonByLabel(trimmed, userDataDir);
  if (existing) return { person: existing, created: false };

  const now = new Date().toISOString();
  const person: Person = {
    id: newId(),
    name: trimmed,
    nicknames: [],
    shortNames: [],
    createdAt: now,
    updatedAt: now,
  };
  const dir = personDir(person.id, userDataDir);
  await mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, "meta.json"), personFile(person));
  await writeAtomic(path.join(dir, "profile.md"), profileWithName(EMPTY_PROFILE, trimmed));
  await writeAtomic(path.join(dir, "digest.md"), EMPTY_DIGEST);
  await writeAtomic(path.join(dir, "current.md"), EMPTY_CURRENT);
  await writeAtomic(path.join(dir, "entries.jsonl"), "");
  return { person, created: true };
}

export async function getPersonRecord(id: string, userDataDir?: string): Promise<{ person: Person; profile: string; digest: string; current: string }> {
  const person = await readPerson(id, userDataDir);
  const dir = personDir(id, userDataDir);
  const [profile, digest, current] = await Promise.all([
    readFile(path.join(dir, "profile.md"), "utf-8"),
    readFile(path.join(dir, "digest.md"), "utf-8"),
    // 阶段 4 之前建的目录没有 current.md，缺失按空判断处理，不让人打不开。
    readFile(path.join(dir, "current.md"), "utf-8").catch(() => ""),
  ]);
  return { person, profile, digest, current };
}

export async function updatePersonNames(
  id: string,
  patch: { name?: string; nicknames?: string[]; shortNames?: string[] },
  userDataDir?: string,
): Promise<Person> {
  const person = await readPerson(id, userDataDir);
  const next: Person = {
    ...person,
    name: patch.name !== undefined ? patch.name.trim() : person.name,
    nicknames: patch.nicknames !== undefined ? cleanList(patch.nicknames) : person.nicknames,
    shortNames: patch.shortNames !== undefined ? cleanList(patch.shortNames) : person.shortNames,
  };
  if (!next.name) throw new PeopleError("称呼不能为空", 400);
  await assertNamesFree(personLabels(next), id, userDataDir);
  if (next.name !== person.name) {
    const profilePath = path.join(personDir(id, userDataDir), "profile.md");
    const profile = await readFile(profilePath, "utf-8");
    await writeAtomic(profilePath, replaceUneditedName(profile, person.name, next.name));
  }
  await savePerson(next, userDataDir);
  return next;
}

export async function deletePerson(id: string, userDataDir?: string): Promise<void> {
  await readPerson(id, userDataDir);
  await rm(personDir(id, userDataDir), { recursive: true, force: true });
}

export async function readEntries(id: string, userDataDir?: string): Promise<PersonEntry[]> {
  await readPerson(id, userDataDir);
  let raw = "";
  try {
    raw = await readFile(path.join(personDir(id, userDataDir), "entries.jsonl"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: PersonEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line) as PersonEntry);
  }
  return entries;
}

export function pageEntries(entries: PersonEntry[], before: string | undefined, limit: number): { entries: PersonEntry[]; hasMore: boolean } {
  let pool = entries;
  if (before) {
    const index = entries.findIndex((entry) => entry.id === before);
    pool = index === -1 ? entries.filter((entry) => entry.at < before) : entries.slice(0, index);
  }
  const hasMore = pool.length > limit;
  return { entries: pool.slice(Math.max(0, pool.length - limit)), hasMore };
}

export function entriesAfter(entries: PersonEntry[], organizedAt?: string): PersonEntry[] {
  if (!organizedAt) return entries;
  const cursor = Date.parse(organizedAt);
  return entries.filter((entry) => Date.parse(entry.at) > cursor);
}

export async function appendEntry(
  id: string,
  input: { kind: "line" | "note"; speaker?: "me" | "them"; text: string },
  userDataDir?: string,
): Promise<{ person: Person; entry: PersonEntry }> {
  const text = input.text ?? "";
  if (!text.trim()) throw new PeopleError("文字不能为空", 400);
  if (input.kind !== "line" && input.kind !== "note") throw new PeopleError("kind 只能是 line 或 note", 400);
  if (input.kind === "line" && input.speaker !== "me" && input.speaker !== "them") {
    throw new PeopleError("speaker 只能是 me 或 them", 400);
  }
  if (input.kind === "note" && input.speaker) throw new PeopleError("自述不要带 speaker", 400);

  const person = await readPerson(id, userDataDir);
  const entries = await readEntries(id, userDataDir);
  const entry: PersonEntry = {
    id: newId(),
    at: nextAt(entries.at(-1)?.at),
    kind: input.kind,
    text,
    ...(input.kind === "line" ? { speaker: input.speaker } : {}),
  };
  await writeAtomic(path.join(personDir(id, userDataDir), "entries.jsonl"), `${entries.map((item) => JSON.stringify(item)).concat(JSON.stringify(entry)).join("\n")}\n`);
  const updated = { ...person, updatedAt: entry.at };
  await savePerson(updated, userDataDir);
  return { person: updated, entry };
}

export async function patchEntry(
  id: string,
  entryId: string,
  patch: { text?: string; speaker?: "me" | "them" },
  userDataDir?: string,
): Promise<PersonEntry> {
  const entries = await readEntries(id, userDataDir);
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) throw new PeopleError("文件不存在或已被删除", 404);
  if (patch.text !== undefined) {
    if (!patch.text.trim()) throw new PeopleError("文字不能为空", 400);
    entry.text = patch.text;
  }
  if (patch.speaker !== undefined) {
    if (entry.kind !== "line") throw new PeopleError("自述不能改说话人", 400);
    if (patch.speaker !== "me" && patch.speaker !== "them") throw new PeopleError("speaker 只能是 me 或 them", 400);
    entry.speaker = patch.speaker;
  }
  await writeAtomic(path.join(personDir(id, userDataDir), "entries.jsonl"), `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const person = await readPerson(id, userDataDir);
  await savePerson({ ...person, updatedAt: new Date().toISOString() }, userDataDir);
  return entry;
}

export async function deleteEntry(id: string, entryId: string, userDataDir?: string): Promise<void> {
  const entries = await readEntries(id, userDataDir);
  if (!entries.some((item) => item.id === entryId)) throw new PeopleError("文件不存在或已被删除", 404);
  const next = entries.filter((item) => item.id !== entryId);
  const body = next.length ? `${next.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
  await writeAtomic(path.join(personDir(id, userDataDir), "entries.jsonl"), body);
  const person = await readPerson(id, userDataDir);
  await savePerson({ ...person, updatedAt: new Date().toISOString() }, userDataDir);
}

export async function saveProfileDocument(
  id: string,
  markdown: string,
  userDataDir?: string,
  options: { summary?: string } = {},
): Promise<Person> {
  if (!profileHeadingsComplete(markdown)) throw new PeopleError("档案标题不完整", 400);
  const names = namesFromProfile(markdown);
  if (!names.name) throw new PeopleError("称呼不能为空", 400);
  const person = await readPerson(id, userDataDir);
  await assertNamesFree(personLabels({ ...person, ...names }), id, userDataDir);
  const file = path.join(personDir(id, userDataDir), "profile.md");
  // 砍半保护：用户要求压缩（summary 含「精简」）时放行（plan §3.3）。
  if (!summaryAllowsCondense(options.summary)) {
    const previous = await readFile(file, "utf-8").catch(() => "");
    if (shrinksByHalf(previous, markdown)) {
      throw new PeopleError("新档案行数不足原来的一半；确需压缩请在提案 summary 中写明「精简」", 400);
    }
  }
  await writeAtomic(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  const next = { ...person, name: names.name, nicknames: names.nicknames, shortNames: names.shortNames };
  await savePerson(next, userDataDir);
  return next;
}

export function personIdFromProfilePath(inputPath: string): string | undefined {
  const match = /^people\/([A-Za-z0-9]+)\/profile\.md$/.exec(inputPath.replaceAll("\\", "/"));
  return match?.[1];
}

export function personIdFromCurrentPath(inputPath: string): string | undefined {
  const match = /^people\/([A-Za-z0-9]+)\/current\.md$/.exec(inputPath.replaceAll("\\", "/"));
  return match?.[1];
}

/**
 * 整篇替换 `current.md`（plan_people_reply §4：「同一次整理替换 current.md」）。
 *
 * 与 `digest.md` 相反，这里**不追加**：当前判断只保留最新一份，
 * 否则每轮都多一段，很快又要截断。超过 1500 字时返回 `written: false`，
 * 文件保持原样——这次不替换，而不是写进一份长文。
 *
 * 不碰 `organizedAt`：游标由 `appendDigest` 推进，两个文件各管各的。
 */
export async function replaceCurrent(
  id: string,
  markdown: string,
  userDataDir?: string,
): Promise<{ written: boolean; length: number }> {
  const body = currentBody(markdown);
  if (!body) return { written: false, length: 0 };
  if (body.length > CURRENT_CHAR_LIMIT) return { written: false, length: body.length };
  const file = path.join(personDir(id, userDataDir), "current.md");
  await writeAtomic(file, `---\nschemaVersion: 1\n---\n\n${body}\n`);
  return { written: true, length: body.length };
}

export async function appendDigest(id: string, paragraph: string, organizedAt: string, userDataDir?: string): Promise<void> {
  // 空内容 → no-op，不写盘（plan §3.3）。
  if (!paragraph.trim()) return;
  await withPersonLock(id, async () => {
    const person = await readPerson(id, userDataDir);
    const file = path.join(personDir(id, userDataDir), "digest.md");
    const current = await readFile(file, "utf-8");
    await writeAtomic(file, `${current.trimEnd()}\n\n${paragraph.trim()}\n`);
    await savePerson({ ...person, organizedAt: laterStamp(person.organizedAt, organizedAt) }, userDataDir);
  });
}

/** 记一次整理的结局。只在 `meta.json` 上写这一小块，不与简报正文混在一起。 */
export async function recordOrganizeOutcome(
  id: string,
  outcome: OrganizeOutcome,
  userDataDir?: string,
): Promise<void> {
  await withPersonLock(id, async () => {
    const person = await readPerson(id, userDataDir);
    await savePerson({ ...person, lastOrganize: outcome }, userDataDir);
  });
}

/**
 * 记下「自动整理今天已经跑过」。
 *
 * 成功、跳过、失败都写：失败也算跑过，否则模型挂了的时候每条消息都会重试一次，
 * 一天烧几十次同样的错误。真挂了要看 `lastOrganize.message`，不是靠重试。
 */
export async function markOrganizeDay(
  id: string,
  day: string,
  userDataDir?: string,
): Promise<void> {
  await withPersonLock(id, async () => {
    const person = await readPerson(id, userDataDir);
    await savePerson({ ...person, organizeWindow: { day } }, userDataDir);
  });
}

export async function writeProfileIfComplete(
  id: string,
  markdown: string,
  userDataDir?: string,
  options: { summary?: string } = {},
): Promise<boolean> {
  if (!profileHeadingsComplete(markdown)) return false;
  await saveProfileDocument(id, markdown, userDataDir, options);
  return true;
}

export function lastEntryPreview(entries: PersonEntry[]): string {
  const text = entries.at(-1)?.text.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "空";
  return text.length > 80 ? text.slice(0, 80) : text;
}

function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function nextAt(previous?: string): string {
  let ms = Date.now();
  if (previous) {
    const prev = Date.parse(previous);
    if (Number.isFinite(prev) && ms <= prev) ms = prev + 1;
  }
  return new Date(ms).toISOString();
}
