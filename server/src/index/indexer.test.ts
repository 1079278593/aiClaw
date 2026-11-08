/**
 * 索引核心测试（plan §13.2 第 8、9、19、20、23、28、29 条）。
 *
 * 第 28/29 条刻意使用**真实文件系统 + 注入的 stub IndexWriter**，不 mock `node:fs`：
 * 只有真实落盘才能区分「文件写成功但索引没写」这个组合状态。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReflection, createReflectionsStore } from "../reflections/store.js";
import { createProposal } from "../pending/store.js";
import { applyProposal } from "../pending/apply.js";
import {
  INDEX_FILENAME,
  calibrateDirs,
  compareNameZh,
  createIndexWriter,
  ensureIndexRoots,
  listChildEntries,
  renderIndex,
  type IndexSyncResult,
  type IndexWriter,
} from "./indexer.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-index-"));
  await mkdir(path.join(base, "reflections", "inbox"), { recursive: true });
  await mkdir(path.join(base, "knowledge_base"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 记录「索引真的被重写」的 writer：按内容变化计数，而不是按调用次数。 */
function createCountingWriter(inner: IndexWriter) {
  const writes: string[] = [];
  const writer: IndexWriter = {
    async syncDirs(dirs, reason): Promise<IndexSyncResult> {
      const failedDirs: string[] = [];
      for (const dir of dirs) {
        const file = path.join(dir, INDEX_FILENAME);
        const before = await readFile(file, "utf-8").catch(() => null);
        const result = await inner.syncDirs([dir], reason);
        if (!result.ok) failedDirs.push(...result.failedDirs);
        const after = await readFile(file, "utf-8").catch(() => null);
        if (before !== after) writes.push(path.relative(base, dir).replaceAll("\\", "/"));
      }
      return failedDirs.length === 0 ? { ok: true, failedDirs: [] } : { ok: false, failedDirs };
    },
  };
  return { writer, writes };
}

/** 永远失败的 writer：模拟 `_index.md` 写不进去（EACCES）。 */
function createFailingWriter(failedDirs: string[]): IndexWriter {
  return {
    async syncDirs(): Promise<IndexSyncResult> {
      return { ok: false, failedDirs, error: "EACCES" };
    },
  };
}

describe("listChildEntries 过滤规则", () => {
  it("跳过点开头、黑名单、非 md/txt、*.assets/ 与 _index.md 自身", async () => {
    const dir = path.join(base, "reflections", "inbox");
    await writeFile(path.join(dir, "笔记.md"), "a", "utf-8");
    await writeFile(path.join(dir, "临时.txt"), "b", "utf-8");
    await writeFile(path.join(dir, "图片.png"), "c", "utf-8");
    await writeFile(path.join(dir, ".hidden.md"), "d", "utf-8");
    await writeFile(path.join(dir, "Thumbs.db"), "e", "utf-8");
    await writeFile(path.join(dir, INDEX_FILENAME), "笔记.md", "utf-8");
    await mkdir(path.join(dir, "某篇.assets"), { recursive: true });
    await mkdir(path.join(dir, "子目录"), { recursive: true });

    const names = (await listChildEntries(dir)).map((entry) => entry.name).sort();
    expect(names).toEqual(["临时.txt", "子目录", "笔记.md"]);
  });

  it("目录排在文件前、中文按拼音序、名字大小写原样保留", () => {
    const rendered = renderIndex([
      { name: "b.md", isDir: false },
      { name: "A.md", isDir: false },
      { name: "第二章", isDir: true },
      { name: "第一章", isDir: true },
    ]);
    // zh-CN 排序按拼音：二(er) 在 一(yi) 之前。
    expect(rendered.split("\n").filter(Boolean)).toEqual(["第二章/", "第一章/", "A.md", "b.md"]);
    expect(compareNameZh("A.md", "a.md")).toBe(0);
  });

  it("索引自身不含 _index.md，空目录渲染为空字符串", async () => {
    const dir = path.join(base, "reflections", "inbox");
    await writeFile(path.join(dir, "a.md"), "x", "utf-8");
    await writeFile(path.join(dir, INDEX_FILENAME), "", "utf-8");
    const content = renderIndex(await listChildEntries(dir));
    expect(content).toBe("a.md\n");
    expect(content).not.toContain(INDEX_FILENAME);

    const empty = path.join(base, "reflections", "空");
    await mkdir(empty, { recursive: true });
    expect(renderIndex(await listChildEntries(empty))).toBe("");
  });
});

describe("IndexWriter 作用范围", () => {
  it("只给 reflections / knowledge_base 写 _index.md；people、distill 从不生成", async () => {
    const dirs = ["reflections", "knowledge_base", "people/a1", "distill/knowledge"];
    for (const rel of dirs) await mkdir(path.join(base, rel), { recursive: true });
    await writeFile(path.join(base, "reflections", "a.md"), "x", "utf-8");
    await writeFile(path.join(base, "knowledge_base", "说明.txt"), "x", "utf-8");
    await writeFile(path.join(base, "people", "a1", "profile.md"), "x", "utf-8");

    const writer = createIndexWriter({ baseDir: base });
    const result = await writer.syncDirs(dirs.map((rel) => path.join(base, rel)), "create");
    expect(result.ok).toBe(true);

    expect(await readFile(path.join(base, "reflections", INDEX_FILENAME), "utf-8")).toBe("inbox/\na.md\n");
    // .txt 笔记也要进索引。
    expect(await readFile(path.join(base, "knowledge_base", INDEX_FILENAME), "utf-8")).toBe("说明.txt\n");
    await expect(stat(path.join(base, "people", "a1", INDEX_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(base, "distill", "knowledge", INDEX_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("索引文件初始化（plan §2.3）", () => {
  it("为 reflections / reflections/inbox / knowledge_base 建空 _index.md，people 不建", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "aiclaw-index-init-"));
    try {
      await ensureIndexRoots(fresh);
      for (const rel of ["reflections", path.join("reflections", "inbox"), "knowledge_base"]) {
        expect(await readFile(path.join(fresh, rel, INDEX_FILENAME), "utf-8")).toBe("");
      }
      await expect(stat(path.join(fresh, "people", INDEX_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("已存在的索引不被覆盖（启动不写盘）", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "aiclaw-index-init-"));
    try {
      const dir = path.join(fresh, "reflections");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, INDEX_FILENAME), "保留.md\n", "utf-8");
      const before = await stat(path.join(dir, INDEX_FILENAME));
      await ensureIndexRoots(fresh);
      expect(await readFile(path.join(dir, INDEX_FILENAME), "utf-8")).toBe("保留.md\n");
      expect((await stat(path.join(dir, INDEX_FILENAME))).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("L1 校准", () => {
  it("索引落后时重写一次，第二次无差异不再写盘", async () => {
    const dir = path.join(base, "reflections", "inbox");
    await writeFile(path.join(dir, "a.md"), "x", "utf-8");
    await writeFile(path.join(dir, "b.md"), "x", "utf-8");
    // 磁盘上缺一行（模拟 L0 写失败留下的落后状态）。
    await writeFile(path.join(dir, INDEX_FILENAME), "a.md\n", "utf-8");

    const { writer, writes } = createCountingWriter(createIndexWriter({ baseDir: base }));
    const first = await calibrateDirs([dir], writer, { baseDir: base });
    expect(first.indexSynced).toBe(true);
    expect(first.rewritten).toEqual(["reflections/inbox"]);
    expect(await readFile(path.join(dir, INDEX_FILENAME), "utf-8")).toBe("a.md\nb.md\n");
    expect(writes).toEqual(["reflections/inbox"]);

    // 第二次：无差异 → 不重写（防「校准变成每次都写」的退化）。
    const second = await calibrateDirs([dir], writer, { baseDir: base });
    expect(second.rewritten).toEqual([]);
    expect(second.clean).toEqual(["reflections/inbox"]);
    expect(writes).toEqual(["reflections/inbox"]);
  });

  it("校准不读写正文文件", async () => {
    const dir = path.join(base, "reflections", "inbox");
    const note = path.join(dir, "a.md");
    await writeFile(note, "正文内容\n", "utf-8");
    await writeFile(path.join(dir, INDEX_FILENAME), "旧的.md\n", "utf-8");
    const before = await stat(note);

    const writer = createIndexWriter({ baseDir: base });
    await calibrateDirs([dir], writer, { baseDir: base });

    const after = await stat(note);
    expect(await readFile(note, "utf-8")).toBe("正文内容\n");
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("批量写入只重写一次", () => {
  it("import 同目录多条后，该层索引只被有效重写一次", async () => {
    const { writer, writes } = createCountingWriter(createIndexWriter({ baseDir: base }));
    const store = createReflectionsStore({ indexWriter: writer, userDataDir: base });
    const text = ["甲", "2026年1月1日08:00:00 公园", "文1", "", "乙", "2026年1月2日09:00:00 家", "文2", "", "丙", "2026年1月3日09:00:00 路上", "文3"].join("\n");
    const batch = await store.importReflections({ text, folder: "inbox" });
    expect(batch.reflections).toHaveLength(3);
    expect(writes.filter((dir) => dir === "reflections/inbox")).toHaveLength(1);
  });
});

describe("索引失败分支（真实文件系统 + stub writer）", () => {
  it("28. 索引写失败：文件不回滚 + indexSynced:false + 提案照常 applied", async () => {
    const store = createReflectionsStore({ indexWriter: createIndexWriter({ baseDir: base }), userDataDir: base });
    const created = await store.createReflection({ title: "旧标题", body: "旧正文", folder: "inbox", userDataDir: base });
    const inbox = path.join(base, "reflections", "inbox");
    // 索引当前是正确的旧状态。
    expect(await readFile(path.join(inbox, INDEX_FILENAME), "utf-8")).toBe("旧标题.md\n");

    const meta = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "换过的正文",
      fields: { title: "新标题" },
      summary: "改标题并补正文",
      userDataDir: base,
    });

    const failing = createFailingWriter(["reflections/inbox"]);
    const result = await applyProposal(meta.id, { indexWriter: failing, userDataDir: base });

    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "applied") throw new Error("apply 应当成功");
    expect(result.indexSynced).toBe(false);

    // ① 文件是新的（原子写已生效，未回滚）。
    const renamed = path.join(inbox, "新标题.md");
    const fileContent = await readFile(renamed, "utf-8");
    expect(fileContent).toContain("换过的正文");
    await expect(stat(path.join(inbox, "旧标题.md"))).rejects.toMatchObject({ code: "ENOENT" });

    // ⑤ 索引仍是旧的 —— 与①合起来才是这条测试的价值。
    expect(await readFile(path.join(inbox, INDEX_FILENAME), "utf-8")).toBe("旧标题.md\n");

    // ③④ 提案照常归档（已移入 _archive），并记下诊断标记。
    const archivedMeta = JSON.parse(
      await readFile(path.join(base, "pending", "_archive", meta.id, "meta.json"), "utf-8"),
    );
    expect(archivedMeta.status).toBe("applied");
    expect(archivedMeta.needsIndexSync).toBe(true);
  });

  it("29. L1 校准把落后状态修好，且第二次不再写盘", async () => {
    const store = createReflectionsStore({ indexWriter: createIndexWriter({ baseDir: base }), userDataDir: base });
    const created = await store.createReflection({ title: "旧标题", body: "旧正文", folder: "inbox", userDataDir: base });
    const inbox = path.join(base, "reflections", "inbox");
    const meta = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "换过的正文",
      fields: { title: "新标题" },
      summary: "改标题",
      userDataDir: base,
    });
    const applied = await applyProposal(meta.id, { indexWriter: createFailingWriter(["reflections/inbox"]), userDataDir: base });
    expect(applied.ok && applied.status === "applied" && applied.indexSynced).toBe(false);

    const notePath = path.join(inbox, "新标题.md");
    const bodyBefore = await readFile(notePath, "utf-8");

    // ② 磁盘上确实缺一行。
    expect(await readFile(path.join(inbox, INDEX_FILENAME), "utf-8")).toBe("旧标题.md\n");

    const { writer, writes } = createCountingWriter(createIndexWriter({ baseDir: base }));
    const first = await calibrateDirs([inbox], writer, { baseDir: base });
    expect(first.indexSynced).toBe(true);
    expect(await readFile(path.join(inbox, INDEX_FILENAME), "utf-8")).toBe("新标题.md\n");

    const second = await calibrateDirs([inbox], writer, { baseDir: base });
    expect(second.rewritten).toEqual([]);
    // writer 调用次数不增：断言「无差异就不重写」。
    expect(writes).toHaveLength(1);

    // ③ 正文未被校准改动。
    expect(await readFile(notePath, "utf-8")).toBe(bodyBefore);
  });
});

describe("L1 校准的接线（打开心得首页 / 重建索引）", () => {
  /** 起一个只挂了 reflections 与 pending 路由的最小 HTTP 服务。 */
  async function startRouteServer() {
    const { createServer } = await import("node:http");
    const { handleReflectionsRoutes } = await import("../server/routes/reflections.js");
    const { handlePendingRoutes } = await import("../server/routes/pending.js");
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void (async () => {
        const handled = await handleReflectionsRoutes({ req, res, url } as never).catch(() => false);
        if (!handled) await handlePendingRoutes({ req, res, url } as never).catch(() => false);
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, port };
  }

  it("打开心得首页（view=tree）会校准根层，把外部改动补进 _index.md", async () => {
    const previous = process.env.AICLAW_DATA_DIR;
    process.env.AICLAW_DATA_DIR = base;
    // 根层索引落后于磁盘：磁盘上有"外部新增.md"，索引里没有。
    await writeFile(path.join(base, "reflections", INDEX_FILENAME), "inbox/\n", "utf-8");
    await writeFile(path.join(base, "reflections", "外部新增.md"), "x", "utf-8");

    const { server, port } = await startRouteServer();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/reflections?view=tree`);
      expect(response.ok).toBe(true);
      const tree = await response.json() as { tree: unknown[]; indexFile: string };
      expect(tree.indexFile).toBe(INDEX_FILENAME);
      // 首页返回的是真实树，且索引已被 L1 补齐。
      const index = await readFile(path.join(base, "reflections", INDEX_FILENAME), "utf-8");
      expect(index).toContain("外部新增.md");
      expect(index).toContain("inbox/");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.AICLAW_DATA_DIR;
      else process.env.AICLAW_DATA_DIR = previous;
    }
  });

  it("重建索引一次性动作：递归补齐 reflections 与 knowledge_base 各层", async () => {
    const previous = process.env.AICLAW_DATA_DIR;
    process.env.AICLAW_DATA_DIR = base;
    // 迁移后的现场：目录里有内容，但一个 _index.md 都没有。
    await mkdir(path.join(base, "reflections", "主题A", "子层"), { recursive: true });
    await writeFile(path.join(base, "reflections", "主题A", "第一篇.md"), "x", "utf-8");
    await writeFile(path.join(base, "reflections", "主题A", "子层", "第二篇.md"), "x", "utf-8");
    await mkdir(path.join(base, "knowledge_base", "库"), { recursive: true });
    await writeFile(path.join(base, "knowledge_base", "库", "文档.md"), "x", "utf-8");

    const { server, port } = await startRouteServer();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/reflections/index/rebuild`, { method: "POST" });
      expect(response.ok).toBe(true);
      const result = await response.json() as { ok: boolean; scanned: number; rewritten: number; reason: string };
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("calibrate-all");
      expect(result.scanned).toBeGreaterThanOrEqual(5);

      // 每一层都补上了正确内容。
      expect(await readFile(path.join(base, "reflections", INDEX_FILENAME), "utf-8")).toContain("主题A/");
      expect(await readFile(path.join(base, "reflections", "主题A", INDEX_FILENAME), "utf-8"))
        .toBe("子层/\n第一篇.md\n");
      expect(await readFile(path.join(base, "reflections", "主题A", "子层", INDEX_FILENAME), "utf-8"))
        .toBe("第二篇.md\n");
      expect(await readFile(path.join(base, "knowledge_base", INDEX_FILENAME), "utf-8")).toContain("库/");
      expect(await readFile(path.join(base, "knowledge_base", "库", INDEX_FILENAME), "utf-8")).toBe("文档.md\n");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.AICLAW_DATA_DIR;
      else process.env.AICLAW_DATA_DIR = previous;
    }
  });

  it("重建索引第二次是幂等的：没有差异就不重写", async () => {
    const previous = process.env.AICLAW_DATA_DIR;
    process.env.AICLAW_DATA_DIR = base;
    await writeFile(path.join(base, "reflections", "主题A.md"), "x", "utf-8");

    const { server, port } = await startRouteServer();
    try {
      const first = await (await fetch(`http://127.0.0.1:${port}/api/reflections/index/rebuild`, { method: "POST" })).json() as { rewritten: number };
      const second = await (await fetch(`http://127.0.0.1:${port}/api/reflections/index/rebuild`, { method: "POST" })).json() as { rewritten: number };
      expect(first.rewritten).toBeGreaterThan(0);
      expect(second.rewritten).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.AICLAW_DATA_DIR;
      else process.env.AICLAW_DATA_DIR = previous;
    }
  });
});

describe("Agent read 不触发索引写入", () => {
  it("23. read 一份过期 _index.md 不改它的内容与 mtime", async () => {
    const inbox = path.join(base, "reflections", "inbox");
    await writeFile(path.join(inbox, "a.md"), "x", "utf-8");
    await writeFile(path.join(inbox, INDEX_FILENAME), "过期的.md\n", "utf-8");
    const before = await stat(path.join(inbox, INDEX_FILENAME));

    // 该测试只验证「读不写」；工具的路径解析依赖 AICLAW_DATA_DIR。
    const { createFileTools } = await import("../tools/file-tools.js");
    const previous = process.env.AICLAW_DATA_DIR;
    process.env.AICLAW_DATA_DIR = base;
    try {
      const tools = createFileTools(
        { readable: ["reflections"], writable: [], denied: [] },
        [],
      );
      const read = tools.find((tool) => tool.name === "read")!;
      const result = await read.execute({ path: "reflections/inbox/_index.md" });
      expect(result.content).toBe("过期的.md\n");
    } finally {
      if (previous === undefined) delete process.env.AICLAW_DATA_DIR;
      else process.env.AICLAW_DATA_DIR = previous;
    }

    const after = await stat(path.join(inbox, INDEX_FILENAME));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(inbox, INDEX_FILENAME), "utf-8")).toBe("过期的.md\n");
  });
});
