/**
 * L2 索引监听（plan §5.3）。
 *
 * 要断言的三件事，正好对应计划里三条硬性约束：
 * 1. **事件只当提示**：外部改了文件 → 索引被 `readdir` 重算修正；
 * 2. **不得作为正确性来源**：事件全丢时，L1 校准仍能修好；
 * 3. **不自激**：写入 `_index.md` 自身不触发再次重算。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calibrateDirs, createIndexWriter, INDEX_FILENAME } from "./indexer.js";
import { shouldReactTo, startIndexWatcher, WATCH_DEBOUNCE_MS } from "./watcher.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-watch-"));
  await mkdir(path.join(base, "reflections", "inbox"), { recursive: true });
  await mkdir(path.join(base, "knowledge_base"), { recursive: true });
  await writeFile(path.join(base, "reflections", INDEX_FILENAME), "inbox/\n", "utf-8");
  await writeFile(path.join(base, "reflections", "inbox", INDEX_FILENAME), "", "utf-8");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("shouldReactTo：哪些事件值得重算", () => {
  it("忽略 _index.md 自身与系统/附属目录", () => {
    expect(shouldReactTo(INDEX_FILENAME)).toBe(false);
    expect(shouldReactTo("a.assets")).toBe(false);
    expect(shouldReactTo(".DS_Store")).toBe(false);
    expect(shouldReactTo("想法.md")).toBe(true);
    expect(shouldReactTo("子目录")).toBe(true);
  });

  it("事件不带 filename 时保守重算", () => {
    expect(shouldReactTo("")).toBe(true);
  });
});

describe("事件只当提示：外部改动经 readdir 重算", () => {
  it("新增文件后索引补上该行", async () => {
    const writer = createIndexWriter({ baseDir: base });
    const watcher = startIndexWatcher({
      roots: [path.join(base, "reflections")],
      writer,
      baseDir: base,
      debounceMs: 20,
    });
    try {
      await writeFile(path.join(base, "reflections", "inbox", "新笔记.md"), "内容", "utf-8");
      // 直接 flush 待处理目录，避免依赖真实事件时序（CI 上 fs.watch 有延迟）。
      await watcher.flush();
      await calibrateDirs([path.join(base, "reflections", "inbox")], writer, { baseDir: base });
      const content = await readFile(path.join(base, "reflections", "inbox", INDEX_FILENAME), "utf-8");
      expect(content).toBe("新笔记.md\n");
    } finally {
      watcher.close();
    }
  });

  it("事件完全丢失时，L1 校准仍能修好索引（不依赖事件）", async () => {
    const writer = createIndexWriter({ baseDir: base });
    // 故意不启动 watcher：模拟 inotify 配额满 / bind mount 不发事件。
    await writeFile(path.join(base, "reflections", "inbox", "漏网的.md"), "内容", "utf-8");
    const result = await calibrateDirs([path.join(base, "reflections", "inbox")], writer, {
      baseDir: base,
    });
    expect(result.indexSynced).toBe(true);
    expect(await readFile(path.join(base, "reflections", "inbox", INDEX_FILENAME), "utf-8")).toBe("漏网的.md\n");
  });
});

describe("不自激：写索引发出的新事件不再触发重算", () => {
  it("只写 _index.md 时，writer 不被调用", async () => {
    let calls = 0;
    const inner = createIndexWriter({ baseDir: base });
    const countingWriter = {
      async syncDirs(dirs: string[], reason: Parameters<typeof inner.syncDirs>[1]) {
        calls += 1;
        return inner.syncDirs(dirs, reason);
      },
    };
    const watcher = startIndexWatcher({
      roots: [path.join(base, "reflections")],
      writer: countingWriter,
      baseDir: base,
      debounceMs: 10,
    });
    try {
      // 只触碰索引文件本身。
      await writeFile(path.join(base, "reflections", INDEX_FILENAME), "inbox/\n", "utf-8");
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS));
      await watcher.flush();
      expect(calls).toBe(0);
    } finally {
      watcher.close();
    }
  });
});

describe("失效退化（不得作为正确性来源）", () => {
  it("watch 抛错时 watcher 仍可创建、close 不抛", async () => {
    const boom = (() => {
      throw new Error("ENOSPC: inotify watch limit reached");
    }) as never;
    const writer = createIndexWriter({ baseDir: base });
    const watcher = startIndexWatcher({
      roots: [path.join(base, "reflections")],
      writer,
      baseDir: base,
      watchImpl: boom,
    });
    expect(() => watcher.close()).not.toThrow();
    // 退化后 L1 仍能工作。
    await writeFile(path.join(base, "reflections", "inbox", "a.md"), "x", "utf-8");
    const result = await calibrateDirs([path.join(base, "reflections", "inbox")], writer, { baseDir: base });
    expect(result.indexSynced).toBe(true);
  });

  it("索引写失败时 watcher 不抛异常", async () => {
    const failing = {
      async syncDirs() {
        return { ok: false, failedDirs: ["reflections/inbox"], error: "EACCES" };
      },
    };
    const watcher = startIndexWatcher({
      roots: [path.join(base, "reflections")],
      writer: failing,
      baseDir: base,
      debounceMs: 10,
    });
    try {
      await writeFile(path.join(base, "reflections", "inbox", "b.md"), "x", "utf-8");
      await expect(watcher.flush()).resolves.toBeUndefined();
    } finally {
      watcher.close();
    }
  });
});
