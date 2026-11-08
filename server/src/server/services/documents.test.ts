/**
 * 文档浏览器与旧路径（plan §13.2 第 15、16、24 条）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../config/index.js";
import { DEFAULT_CONFIG } from "../../config/schema.js";
import { listDocBrowserEntries, readDocBrowserFile, writeDocBrowserFile } from "./documents.js";
import { readReflection } from "../../reflections/store.js";

let base = "";
let previous: string | undefined;

function config(): Config {
  return DEFAULT_CONFIG as unknown as Config;
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-docs-"));
  previous = process.env.AICLAW_DATA_DIR;
  process.env.AICLAW_DATA_DIR = base;
  for (const rel of ["knowledge_base/库", "reflections/inbox", "people/a1", "inputs/reflections", "distill/reflections"]) {
    await mkdir(path.join(base, rel), { recursive: true });
  }
  await writeFile(path.join(base, "knowledge_base", "库", "文档.md"), "内容", "utf-8");
  await writeFile(path.join(base, "knowledge_base", "库", "扫描.pdf"), "%PDF", "utf-8");
  await writeFile(path.join(base, "knowledge_base", "库", "_index.md"), "文档.md\n", "utf-8");
});

afterEach(async () => {
  if (previous === undefined) delete process.env.AICLAW_DATA_DIR;
  else process.env.AICLAW_DATA_DIR = previous;
  await rm(base, { recursive: true, force: true });
});

describe("16. 文档浏览器根集合", () => {
  it("服务 knowledge_base 与 distill；reflections 与 people 各有自己入口", async () => {
    for (const root of ["reflections", "people", "inputs/reflections", "agents"]) {
      await expect(listDocBrowserEntries(root, config())).rejects.toThrow(/not allowed/i);
    }
    const ok = await listDocBrowserEntries("knowledge_base", config());
    expect(ok.entries.map((entry) => entry.name)).toContain("库");
    // distill 是只读的派生物区，可浏览以便人工核对。
    await expect(listDocBrowserEntries("distill", config())).resolves.toBeTruthy();
  });
});

describe("15. 旧路径不静默回退", () => {
  it("inputs/reflections/... 返回 404 语义（路径不允许），不回退到新路径", async () => {
    // 即便磁盘上真的存在 inputs/reflections/x.md，reflections 解析也不认它。
    await writeFile(path.join(base, "inputs", "reflections", "x.md"), "旧", "utf-8");
    await expect(readReflection("inputs/reflections/x.md", base)).rejects.toBeTruthy();
  });

  it("文档浏览器也拒绝 inputs/ 路径", async () => {
    await expect(listDocBrowserEntries("inputs", config())).rejects.toThrow(/not allowed/i);
  });
});

describe("24. .pdf 不进索引但可出现在列表，打开是「暂不支持预览」", () => {
  it("列表条目数与索引行数不同是设计", async () => {
    const listing = await listDocBrowserEntries("knowledge_base/库", config());
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain("扫描.pdf");
    // _index.md 是系统元数据，不出现在浏览器列表里。
    expect(names).not.toContain("_index.md");

    const opened = await readDocBrowserFile("knowledge_base/库/扫描.pdf", config());
    expect(opened.supported).toBe(false);
    expect(opened.content).toBe("暂不支持预览");
  });

  it("文本文件可正常读取", async () => {
    const opened = await readDocBrowserFile("knowledge_base/库/文档.md", config());
    expect(opened).toMatchObject({ supported: true, kind: "text", content: "内容" });
  });
});

describe("蒸馏区可在浏览器内只读查看", () => {
  it("distill 的目录与文件都能列、能打开", async () => {
    await writeFile(path.join(base, "distill", "reflections", "技术.md"), "# 技术\n\n## 摘要\n\n正文\n", "utf-8");
    const listing = await listDocBrowserEntries("distill/reflections", config());
    expect(listing.entries.map((entry) => entry.name)).toContain("技术.md");
    const opened = await readDocBrowserFile("distill/reflections/技术.md", config());
    expect(opened).toMatchObject({ supported: true, kind: "text" });
    expect(opened.content).toContain("正文");
  });

  it("distill 拒绝写入：摘要是派生物，只能由 distill 工具重算", async () => {
    await writeFile(path.join(base, "distill", "reflections", "技术.md"), "# 技术\n", "utf-8");
    await expect(writeDocBrowserFile("distill/reflections/技术.md", "手改")).rejects.toThrow(/派生物/);
  });
});

describe("写入边界", () => {
  it("知识区可经文档浏览器写入（走 UI，不走 Agent 工具）", async () => {
    await writeDocBrowserFile("knowledge_base/库/文档.md", "改过");
    expect(await readDocBrowserFile("knowledge_base/库/文档.md", config())).toMatchObject({ content: "改过" });
  });

  it("不允许写知识区以外的路径", async () => {
    await expect(writeDocBrowserFile("reflections/inbox/a.md", "x")).rejects.toThrow(/not allowed/i);
    await expect(writeDocBrowserFile("../escape.md", "x")).rejects.toThrow(/not allowed/i);
  });
});
