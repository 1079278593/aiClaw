/**
 * 归档目录 90 天 TTL（plan §11）。
 *
 * 关键断言：**只删过期的，不碰新的**；三层目录都能被找到；
 * 时间戳不可解析时退回 mtime 而不是「当作 1970 立刻删」。
 */

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "./ttl.js";
import {
  ARCHIVE_TTL_DAYS,
  findArchiveDirs,
  shouldDeleteArchive,
  sweepArchiveDir,
  sweepArchiveTtl,
  timestampFromName,
} from "./archive-ttl.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-archive-ttl-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const NOW = new Date("2026-11-08T00:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** 造一个归档条目：文件名带时间戳，内容无所谓。 */
async function makeEntry(dir: string, name: string, ageDays: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, "归档内容", "utf-8");
  return target;
}

describe("时间戳解析", () => {
  it("从归档名里取出 ISO 时间", () => {
    const at = timestampFromName("2026-08-01T10:20:30.400Z-a1b2c3");
    expect(at?.toISOString()).toBe("2026-08-01T10:20:30.400Z");
  });

  it("不带时间戳的名字返回 null（退回 mtime）", () => {
    expect(timestampFromName("longterm.md")).toBeNull();
    expect(timestampFromName("2026-08-01")).toBeNull();
  });

  it("未来时间不认（时钟回拨保护）", () => {
    expect(timestampFromName(`${new Date(NOW.getTime() + 5 * DAY_MS).toISOString()}-x`, NOW)).toBeNull();
  });
});

describe("90 天判定", () => {
  it("89 天保留，90 天整删除", () => {
    expect(shouldDeleteArchive(daysAgo(ARCHIVE_TTL_DAYS - 1), NOW)).toBe(false);
    expect(shouldDeleteArchive(daysAgo(ARCHIVE_TTL_DAYS), NOW)).toBe(true);
    expect(shouldDeleteArchive(daysAgo(ARCHIVE_TTL_DAYS + 100), NOW)).toBe(true);
  });
});

describe("findArchiveDirs", () => {
  it("能在 agents / distill / people 的嵌套层级里找到 _archive", async () => {
    const layout = [
      "agents/main/memory/_archive",
      "distill/主题/_archive",
      "people/a1b2c3/_archive",
    ];
    for (const rel of layout) await mkdir(path.join(base, rel), { recursive: true });

    const found = await findArchiveDirs(base);
    const rels = found.map((dir) => path.relative(base, dir).replaceAll("\\", "/")).sort();
    expect(rels).toEqual(layout.slice().sort());
  });

  it("跳过 .assets 与隐藏目录（不白扫）", async () => {
    await mkdir(path.join(base, "reflections", "_archive"), { recursive: true });
    await mkdir(path.join(base, "reflections", "a.assets", "_archive"), { recursive: true });
    await mkdir(path.join(base, ".git", "_archive"), { recursive: true });

    const found = await findArchiveDirs(base);
    const rels = found.map((dir) => path.relative(base, dir).replaceAll("\\", "/"));
    expect(rels).toEqual(["reflections/_archive"]);
  });

  it("目录不存在时返回空数组而不抛", async () => {
    await expect(findArchiveDirs(path.join(base, "nope"))).resolves.toEqual([]);
  });
});

describe("sweepArchiveDir", () => {
  it("只删过期的条目，保留未过期的", async () => {
    const archive = path.join(base, "agents", "main", "memory", "_archive");
    const old = await makeEntry(archive, `${daysAgo(100).toISOString()}-old1`, 100);
    const fresh = await makeEntry(archive, `${daysAgo(3).toISOString()}-fresh`, 3);

    const report = await sweepArchiveDir(archive, { now: NOW, baseDir: base });
    const names = (await readdir(archive)).sort();
    expect(names).toEqual([path.basename(fresh)]);
    expect(report.deleted).toHaveLength(1);
    expect(report.deleted[0]).toContain("old1");
    expect(report.failed).toEqual([]);
    void old;
  });

  it("名字无时间戳时按 mtime 判定", async () => {
    const archive = path.join(base, "people", "p1", "_archive");
    const old = await makeEntry(archive, "profile.md", 0);
    const past = daysAgo(120);
    await utimes(old, past, past);
    const fresh = await makeEntry(archive, "focus.md", 100);

    const report = await sweepArchiveDir(archive, { now: NOW, baseDir: base });
    expect(report.deleted).toHaveLength(1);
    expect(await readdir(archive)).toEqual([path.basename(fresh)]);
  });

  it("归档目录不存在时安静返回", async () => {
    const report = await sweepArchiveDir(path.join(base, "missing", "_archive"), { now: NOW });
    expect(report).toEqual({ deleted: [], failed: [] });
  });
});

describe("sweepArchiveTtl（整租户）", () => {
  it("同时清理三类归档，返回相对路径", async () => {
    const layout: Array<[string, string]> = [
      ["agents/main/memory/_archive", "longterm.md"],
      ["distill/读书/_archive", "摘要.md"],
      ["people/a1/_archive", "profile.md"],
    ];
    for (const [rel, name] of layout) {
      const archive = path.join(base, rel);
      await makeEntry(archive, name, 0);
      const past = daysAgo(200);
      await utimes(path.join(archive, name), past, past);
    }

    const report = await sweepArchiveTtl({ userDataDir: base, now: NOW });
    expect(report.deleted.sort()).toEqual(
      [
        "agents/main/memory/_archive/longterm.md",
        "distill/读书/_archive/摘要.md",
        "people/a1/_archive/profile.md",
      ].sort(),
    );
    expect(report.failed).toEqual([]);
  });

  it("未过期的归档一个都不删（幂等）", async () => {
    const archive = path.join(base, "agents/main/memory/_archive");
    await makeEntry(archive, "focus.md", 0);
    const first = await sweepArchiveTtl({ userDataDir: base, now: NOW });
    expect(first.deleted).toEqual([]);
    expect(await readdir(archive)).toHaveLength(1);
  });
});
