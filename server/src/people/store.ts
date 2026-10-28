import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import {
  EMPTY_DIGEST,
  EMPTY_PROFILE,
  namesFromProfile,
  profileHeadingsComplete,
  profileWithName,
  replaceUneditedName,
} from "./profile.js";

export type Person = {
  id: string;
  name: string;
  nicknames: string[];
  shortNames: string[];
  createdAt: string;
  updatedAt: string;
  organizedAt?: string;
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
  return path.join(getPaths(userDataDir).inputs, "people");
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
  const tmp = `${file}.${process.pid}.tmp`;
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
  return `${JSON.stringify(data, null, 2)}\n`;
}

async function readPerson(id: string, userDataDir?: string): Promise<Person> {
  try {
    const raw = JSON.parse(await readFile(path.join(personDir(id, userDataDir), "meta.json"), "utf-8")) as Person;
    return {
      id: raw.id,
      name: raw.name ?? "",
      nicknames: Array.isArray(raw.nicknames) ? raw.nicknames : [],
      shortNames: Array.isArray(raw.shortNames) ? raw.shortNames : [],
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(raw.organizedAt ? { organizedAt: raw.organizedAt } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PeopleError("文件不存在或已被删除", 404);
    throw error;
  }
}

async function savePerson(person: Person, userDataDir?: string): Promise<void> {
  await writeAtomic(path.join(personDir(person.id, userDataDir), "meta.json"), personFile(person));
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
  await writeAtomic(path.join(dir, "entries.jsonl"), "");
  return { person, created: true };
}

export async function getPersonRecord(id: string, userDataDir?: string): Promise<{ person: Person; profile: string; digest: string }> {
  const person = await readPerson(id, userDataDir);
  const dir = personDir(id, userDataDir);
  const [profile, digest] = await Promise.all([
    readFile(path.join(dir, "profile.md"), "utf-8"),
    readFile(path.join(dir, "digest.md"), "utf-8"),
  ]);
  return { person, profile, digest };
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

export async function saveProfileDocument(id: string, markdown: string, userDataDir?: string): Promise<Person> {
  if (!profileHeadingsComplete(markdown)) throw new PeopleError("档案标题不完整", 400);
  const names = namesFromProfile(markdown);
  if (!names.name) throw new PeopleError("称呼不能为空", 400);
  const person = await readPerson(id, userDataDir);
  await assertNamesFree(personLabels({ ...person, ...names }), id, userDataDir);
  await writeAtomic(path.join(personDir(id, userDataDir), "profile.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  const next = { ...person, name: names.name, nicknames: names.nicknames, shortNames: names.shortNames };
  await savePerson(next, userDataDir);
  return next;
}

export function personIdFromProfilePath(inputPath: string): string | undefined {
  const match = /^inputs\/people\/([A-Za-z0-9]+)\/profile\.md$/.exec(inputPath.replaceAll("\\", "/"));
  return match?.[1];
}

export async function appendDigest(id: string, paragraph: string, organizedAt: string, userDataDir?: string): Promise<void> {
  const person = await readPerson(id, userDataDir);
  const file = path.join(personDir(id, userDataDir), "digest.md");
  const current = await readFile(file, "utf-8");
  await writeAtomic(file, `${current.trimEnd()}\n\n${paragraph.trim()}\n`);
  await savePerson({ ...person, organizedAt }, userDataDir);
}

export async function writeProfileIfComplete(id: string, markdown: string, userDataDir?: string): Promise<boolean> {
  if (!profileHeadingsComplete(markdown)) return false;
  await saveProfileDocument(id, markdown, userDataDir);
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
