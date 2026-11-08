/**
 * 蒸馏区（plan_distill）。
 *
 * 测试重点放在**缓存语义**上，而不是「能生成一段文本」：
 * 1. 头解析失败要退化，不能抛（否则读原文也会挂）；
 * 2. LLM 失败必须保留旧摘要，且不写任何文件；
 * 3. 体积上限是拒绝，不是截断；
 * 4. 无头文件（用户手写）永不被覆盖或归档；
 * 5. `_archive` 保留最近 3 份，且只按**同一份摘要**修剪。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OVERVIEW_ID,
  classifyStaleness,
  newDistillId,
  parseDistillDoc,
  parseDistillHead,
  parseSources,
  renderDistillDoc,
  sourcesOf,
} from "./format.js";
import {
  OVERVIEW_BYTE_MAX,
  archiveDir,
  distillFile,
  isDistillScope,
  overviewFile,
  readDistill,
  readOverview,
  rebuildOverview,
  removeDistill,
  renderOverview,
  writeDistill,
  DistillError,
} from "./store.js";
import { autoRefreshStaleDistill, generateDistill, scanStaleSummaries, shouldAutoRefresh } from "./generate.js";
import { buildDistillMapInjection, dropMemoryOverlap, sourceKey } from "./inject.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aiclaw-distill-"));
  await mkdir(path.join(dir, "reflections", "inbox"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-08T12:00:00.000Z");

describe("头解析与渲染", () => {
  it("解析出 id 与 refreshed", () => {
    const head = parseDistillHead("<!-- distill id:dst-abc refreshed:2026-11-08T12:00:00.000Z -->\n\n正文");
    expect(head).toEqual({ id: "dst-abc", refreshed: "2026-11-08T12:00:00.000Z" });
  });

  it("没有头时 id 为 null（用户手写笔记）", () => {
    expect(parseDistillHead("# 我的笔记\n\n内容").id).toBeNull();
    expect(parseDistillHead("").id).toBeNull();
  });

  it("时间不可解析时 id 保留、refreshed 归 null", () => {
    const head = parseDistillHead("<!-- distill id:dst-abc refreshed:not-a-date -->");
    expect(head.id).toBe("dst-abc");
    expect(head.refreshed).toBeNull();
  });

  it("正文里出现的同样形状注释不影响判定（只看第一行）", () => {
    const content = "# 标题\n\n<!-- distill id:内联 refreshed:2026-01-01T00:00:00.000Z -->";
    expect(parseDistillHead(content).id).toBeNull();
  });

  it("渲染后再解析能还原，且正文不带头", () => {
    const content = renderDistillDoc("dst-x", NOW, "# 标题\n\n内容");
    expect(content.startsWith("<!-- distill id:dst-x refreshed:2026-11-08T12:00:00.000Z -->")).toBe(true);
    const doc = parseDistillDoc(content);
    expect(doc.id).toBe("dst-x");
    expect(doc.body.trim()).toBe("# 标题\n\n内容");
  });

  it("id 带随机与时间后缀，连续生成不重复", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newDistillId(NOW)));
    expect(ids.size).toBe(50);
    expect([...ids][0].startsWith("dst-")).toBe(true);
  });
});

describe("来源解析", () => {
  it("只取 `## 来源` 下的列表项，遇到下一个标题即停", () => {
    const body = [
      "## 摘要",
      "- 这不是来源",
      "## 来源",
      "- reflections/a.md",
      "- `reflections/b.md`",
      "",
      "## 缺失来源",
      "- reflections/c.md",
    ].join("\n");
    expect(parseSources(body)).toEqual(["reflections/a.md", "reflections/b.md"]);
  });

  it("没有来源小节时返回空数组，不抛", () => {
    expect(parseSources("随便写点")).toEqual([]);
    expect(sourcesOf("<!-- distill id:x refreshed:2026-11-08T12:00:00.000Z -->\n\n# t")).toEqual([]);
  });
});

describe("过期判定", () => {
  const header = { id: "dst-x", refreshed: "2026-11-08T00:00:00.000Z" };

  it("无头文件归为 unowned（不参与自动刷新）", () => {
    expect(classifyStaleness({ header: { id: null, refreshed: null }, newestSourceMtime: null, missingSources: 0 }))
      .toBe("unowned");
  });

  it("时间解析不了归为 unknown，而不是 stale（不能自动覆盖）", () => {
    const result = classifyStaleness({
      header: { id: "dst-x", refreshed: null },
      newestSourceMtime: NOW,
      missingSources: 0,
    });
    expect(result).toBe("unknown");
  });

  it("来源比 refreshed 新 → stale", () => {
    expect(classifyStaleness({
      header,
      newestSourceMtime: new Date("2026-11-09T00:00:00.000Z"),
      missingSources: 0,
    })).toBe("stale");
  });

  it("来源都没改 → fresh", () => {
    expect(classifyStaleness({
      header,
      newestSourceMtime: new Date("2026-11-01T00:00:00.000Z"),
      missingSources: 0,
    })).toBe("fresh");
  });

  it("来源缺失 → stale", () => {
    expect(classifyStaleness({ header, newestSourceMtime: null, missingSources: 1 })).toBe("stale");
  });

  it("只有 stale 才允许自动刷新", () => {
    expect(shouldAutoRefresh("stale")).toBe(true);
    expect(shouldAutoRefresh("unknown")).toBe(false);
    expect(shouldAutoRefresh("fresh")).toBe(false);
  });
});

describe("存储：路径与安全", () => {
  it("scope 白名单", () => {
    expect(isDistillScope("reflections")).toBe(true);
    expect(isDistillScope("knowledge")).toBe(true);
    expect(isDistillScope("chat")).toBe(false);
  });

  it("拒绝越界与非法扩展名", () => {
    expect(() => distillFile("reflections", "../../etc/passwd.md", dir)).toThrow(DistillError);
    expect(() => distillFile("reflections", "a.txt", dir)).toThrow(/\.md/);
    expect(() => distillFile("reflections", "", dir)).toThrow(DistillError);
  });

  it("读不存在的摘要返回 null（缓存缺失不是错误）", async () => {
    expect(await readDistill("reflections", "nope.md", dir)).toBeNull();
  });
});

describe("存储：写入与归档", () => {
  it("写入后可读回，且地图由 rebuildOverview 显式生成", async () => {
    await writeDistill("reflections", "a.md", renderDistillDoc("dst-a", NOW, "# 主题 A\n\n## 摘要\n\n内容\n\n## 来源\n\n- reflections/inbox/x.md"), { userDataDir: dir });
    const doc = await readDistill("reflections", "a.md", dir);
    expect(doc?.id).toBe("dst-a");
    // writeDistill 不隐式重建地图：地图由 generate/refresh 明确触发。
    const map = await rebuildOverview({ userDataDir: dir, now: NOW });
    expect(map).toContain(OVERVIEW_ID);
    expect(map).toContain("a.md");
  });

  it("超上限拒绝写入（413），不静默截断", async () => {
    const huge = renderDistillDoc("dst-big", NOW, `# 大\n\n${"字".repeat(40_000)}`);
    await expect(writeDistill("reflections", "big.md", huge, { userDataDir: dir }))
      .rejects.toMatchObject({ statusCode: 413 });
  });

  it("覆盖时旧版本进 _archive，且只保留 3 份", async () => {
    const scope = "reflections" as const;
    for (let i = 0; i < 5; i += 1) {
      await writeDistill(scope, "loop.md", renderDistillDoc(`dst-${i}`, NOW, `# 版本 ${i}`), {
        userDataDir: dir,
        now: new Date(NOW.getTime() + i * 1000),
      });
    }
    const archives = await readdir(archiveDir(dir));
    expect(archives).toHaveLength(3);
    // 留下的应是最新的三份（版本 1、2、3 被归档）。
    const bodies = await Promise.all(archives.map((name) => readFile(path.join(archiveDir(dir), name), "utf-8")));
    expect(bodies.some((body) => body.includes("版本 1"))).toBe(true);
    expect(bodies.some((body) => body.includes("版本 0"))).toBe(false);
  });

  it("无头文件不被归档、不被覆盖（属于用户）", async () => {
    const file = distillFile("reflections", "mine.md", dir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# 我自己写的\n", "utf-8");

    // removeDistill 拒绝删除无头文件。
    await expect(removeDistill("reflections", "mine.md", { userDataDir: dir }))
      .rejects.toMatchObject({ statusCode: 409 });
    // 写入同路径时不做归档（它不是系统产物）。
    await writeDistill("reflections", "mine.md", renderDistillDoc("dst-new", NOW, "# 新"), { userDataDir: dir });
    const archives = await readdir(archiveDir(dir)).catch(() => [] as string[]);
    expect(archives.filter((name) => name.includes("mine"))).toHaveLength(0);
  });

  it("归档只修剪同一份摘要，不挤掉别的主题", async () => {
    for (let i = 0; i < 4; i += 1) {
      await writeDistill("reflections", "a.md", renderDistillDoc(`dst-a${i}`, NOW, `# A${i}`), { userDataDir: dir, now: NOW });
    }
    await writeDistill("reflections", "b.md", renderDistillDoc("dst-b0", NOW, "# B0"), { userDataDir: dir, now: NOW });
    await writeDistill("reflections", "b.md", renderDistillDoc("dst-b1", NOW, "# B1"), { userDataDir: dir, now: NOW });

    const archives = await readdir(archiveDir(dir));
    expect(archives.filter((name) => name.includes("__a.md"))).toHaveLength(3);
    expect(archives.filter((name) => name.includes("__b.md"))).toHaveLength(1);
  });
});

describe("地图", () => {
  it("只列有 id 的摘要，跳过无头文件与 _archive", async () => {
    await writeDistill("reflections", "owned.md", renderDistillDoc("dst-o", NOW, "# 有主\n\n## 来源\n\n- reflections/inbox/x.md"), { userDataDir: dir });
    const mine = distillFile("reflections", "mine.md", dir);
    await mkdir(path.dirname(mine), { recursive: true });
    await writeFile(mine, "# 手写\n", "utf-8");

    const map = await rebuildOverview({ userDataDir: dir, now: NOW });
    expect(map).toContain("owned.md");
    expect(map).not.toContain("mine.md");
  });

  it("超过 2 KB 时按行裁剪，而不是产生半行", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      file: `reflections/topic-${index}.md`,
      title: `主题 ${index}`,
      sourceCount: 2,
      refreshed: NOW.toISOString(),
      stale: false,
    }));
    const content = renderOverview(rows, NOW);
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThanOrEqual(OVERVIEW_BYTE_MAX);
    // 每一行表格都完整（以 | 结尾），没有半截行。
    const tableLines = content.split("\n").filter((line) => line.startsWith("|"));
    expect(tableLines.every((line) => line.trimEnd().endsWith("|"))).toBe(true);
  });

  it("renderOverview 的 stale 标记出现在行内", () => {
    const content = renderOverview([{
      file: "reflections/a.md",
      title: "A",
      sourceCount: 1,
      refreshed: NOW.toISOString(),
      stale: true,
    }], NOW);
    expect(content).toContain("⚠");
  });
});

describe("生成：失败必须保留旧摘要", () => {
  it("summarizer 抛错时不写任何文件，旧摘要原样保留", async () => {
    await writeFile(path.join(dir, "reflections", "inbox", "a.md"), "原文", "utf-8");
    const target = "reflections/keep.md";
    await writeDistill("reflections", target, renderDistillDoc("dst-old", NOW, "# 旧摘要\n\n旧内容"), {
      userDataDir: dir,
      now: NOW,
    });
    const before = await readFile(distillFile("reflections", target, dir), "utf-8");

    const result = await generateDistill({
      scope: "reflections",
      relative: target,
      sources: ["reflections/inbox/a.md"],
      userDataDir: dir,
    }, {
      summarizer: async () => {
        throw new Error("模型超时");
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("模型超时");
    // 文件一个字节都没变。
    expect(await readFile(distillFile("reflections", target, dir), "utf-8")).toBe(before);
    // 也没有产生归档。
    const archives = await readdir(archiveDir(dir)).catch(() => [] as string[]);
    expect(archives).toHaveLength(0);
  });

  it("来源一个都读不到时直接失败，不调模型", async () => {
    let called = 0;
    const result = await generateDistill({
      scope: "reflections",
      relative: "x.md",
      sources: ["reflections/inbox/missing.md"],
      userDataDir: dir,
    }, {
      summarizer: async () => {
        called += 1;
        return "不该被调用";
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("成功生成：写头、写来源、进地图", async () => {
    await writeFile(path.join(dir, "reflections", "inbox", "a.md"), "原文内容", "utf-8");
    const result = await generateDistill({
      scope: "reflections",
      relative: "topic.md",
      title: "主题",
      sources: ["reflections/inbox/a.md"],
      userDataDir: dir,
    }, {
      summarizer: async () => "这是摘要正文",
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, sources: 1 });
    const content = await readFile(distillFile("reflections", "topic.md", dir), "utf-8");
    expect(parseDistillDoc(content).id).toBeTruthy();
    expect(content).toContain("这是摘要正文");
    expect(content).toContain("reflections/inbox/a.md");
    expect(await readOverview(dir)).toContain("topic.md");
  });

  it("模型自己带了标题与「## 摘要」时，不与固定结构重复", async () => {
    await writeFile(path.join(dir, "reflections", "inbox", "a.md"), "原文内容", "utf-8");
    const result = await generateDistill({
      scope: "reflections",
      relative: "topic.md",
      title: "主题",
      sources: ["reflections/inbox/a.md"],
      userDataDir: dir,
    }, {
      // 真模型经常无视「不要标题」，照抄一份结构回来。
      summarizer: async () => "# 主题\n\n## 摘要\n\n真正的摘要正文\n\n## 小节\n\n保留下来的细节",
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true });
    const content = await readFile(distillFile("reflections", "topic.md", dir), "utf-8");
    const doc = parseDistillDoc(content);
    // 只出现一次标题、一次「## 摘要」。
    expect(doc.body.match(/^# 主题$/gm) ?? []).toHaveLength(1);
    expect(doc.body.match(/^## 摘要$/gm) ?? []).toHaveLength(1);
    expect(doc.body).toContain("真正的摘要正文");
    // 正文里后续的小节不被误删。
    expect(doc.body).toContain("## 小节");
    expect(doc.body).toContain("保留下来的细节");
  });

  it("来源为空数组时拒绝生成", async () => {
    const result = await generateDistill({
      scope: "reflections",
      relative: "x.md",
      sources: [],
      userDataDir: dir,
    });
    expect(result.ok).toBe(false);
  });
});

describe("启动自动重算（plan_distill §6）", () => {
  /** 造一份「来源已改动 → stale」的摘要。 */
  async function staleSummary(relative: string, refreshedDaysAgo: number): Promise<void> {
    const source = path.join(dir, "reflections", "inbox", "s.md");
    await writeFile(source, "原文", "utf-8");
    // 让来源比摘要新，构成 stale。
    const refreshed = new Date(NOW.getTime() - refreshedDaysAgo * 24 * 60 * 60 * 1000);
    const body = [
      `# ${relative}`,
      "",
      "## 摘要",
      "",
      "旧内容",
      "",
      "## 来源",
      "",
      "- reflections/inbox/s.md",
    ].join("\n");
    await writeDistill("reflections", relative, renderDistillDoc("dst-auto", refreshed, body), {
      userDataDir: dir,
      now: refreshed,
    });
    const future = new Date(NOW.getTime() + 60_000);
    await utimes(source, future, future);
  }

  it("只重算 stale 且近期刷新过的，并写回文件", async () => {
    await staleSummary("recent.md", 5);
    let calls = 0;
    const result = await autoRefreshStaleDistill({
      tenantDir: dir,
      now: NOW,
      summarizer: async () => {
        calls += 1;
        return "新摘要正文";
      },
    });
    expect(calls).toBe(1);
    expect(result.refreshed).toContain("reflections/recent.md");
    const content = await readFile(distillFile("reflections", "recent.md", dir), "utf-8");
    expect(content).toContain("新摘要正文");
  });

  it("刷新于 30 天前的 stale 摘要不自动重算", async () => {
    await staleSummary("old.md", 45);
    let calls = 0;
    const result = await autoRefreshStaleDistill({
      tenantDir: dir,
      now: NOW,
      summarizer: async () => {
        calls += 1;
        return "不该被写";
      },
    });
    expect(calls).toBe(0);
    expect(result.refreshed).toHaveLength(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("单轮最多重算 MAX_AUTO_ITEMS 篇", async () => {
    for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      await staleSummary(name, 2);
    }
    let calls = 0;
    const result = await autoRefreshStaleDistill({
      tenantDir: dir,
      now: NOW,
      maxItems: 2,
      summarizer: async () => {
        calls += 1;
        return "新内容";
      },
    });
    expect(calls).toBe(2);
    expect(result.refreshed).toHaveLength(2);
  });

  it("手写文件（无 id）永不被自动重算", async () => {
    await mkdir(path.join(dir, "distill", "reflections"), { recursive: true });
    await writeFile(path.join(dir, "distill", "reflections", "hand.md"), "# 手写\n\n内容\n", "utf-8");
    let calls = 0;
    await autoRefreshStaleDistill({
      tenantDir: dir,
      now: NOW,
      summarizer: async () => {
        calls += 1;
        return "x";
      },
    });
    expect(calls).toBe(0);
  });
});

describe("过期扫描", () => {
  it("来源改动后报 stale；无头文件不报", async () => {
    const source = path.join(dir, "reflections", "inbox", "s.md");
    await writeFile(source, "原文", "utf-8");

    await writeDistill("reflections", "a.md", renderDistillDoc("dst-a", new Date("2026-11-01T00:00:00.000Z"), [
      "# A",
      "",
      "## 摘要",
      "",
      "内容",
      "",
      "## 来源",
      "",
      "- reflections/inbox/s.md",
    ].join("\n")), { userDataDir: dir, now: new Date("2026-11-01T00:00:00.000Z") });

    // 把来源改新。
    const later = new Date("2026-11-09T00:00:00.000Z");
    await utimes(source, later, later);

    const stale = await scanStaleSummaries({ userDataDir: dir, now: NOW });
    expect(stale.map((item) => item.file)).toEqual(["reflections/a.md"]);
    expect(stale[0].staleness).toBe("stale");
  });

  it("来源缺失时报 stale 并说明原因", async () => {
    await writeDistill("reflections", "b.md", renderDistillDoc("dst-b", NOW, [
      "# B", "", "## 来源", "", "- reflections/inbox/gone.md",
    ].join("\n")), { userDataDir: dir, now: NOW });

    const stale = await scanStaleSummaries({ userDataDir: dir, now: NOW });
    expect(stale[0].reason).toContain("已不存在");
  });
});

describe("注入：预算与去重", () => {
  async function seedMap(rows: Array<[string, string]>) {
    for (const [file, title] of rows) {
      await writeDistill("reflections", file, renderDistillDoc(newDistillId(NOW), NOW, `# ${title}`), {
        userDataDir: dir,
        now: NOW,
      });
    }
    await rebuildOverview({ userDataDir: dir, now: NOW });
  }

  it("默认关闭时不注入", async () => {
    await seedMap([["a.md", "A"]]);
    const result = await buildDistillMapInjection({ enabled: false, userDataDir: dir });
    expect(result.text).toBe("");
    expect(result.skipped).toBe("disabled");
  });

  it("地图为空时不注入", async () => {
    const result = await buildDistillMapInjection({ enabled: true, userDataDir: dir });
    expect(result.skipped).toBe("empty");
  });

  it("超过 2 KB 整块丢弃，不截断", async () => {
    await seedMap([["a.md", "A"]]);
    // 手动把地图写超限。
    const file = overviewFile(dir);
    await writeFile(file, `${await readFile(file, "utf-8")}${"x".repeat(OVERVIEW_BYTE_MAX)}`, "utf-8");
    const result = await buildDistillMapInjection({ enabled: true, userDataDir: dir });
    expect(result.text).toBe("");
    expect(result.skipped).toBe("too-large");
  });

  it("预算不足时丢掉地图（记忆优先）", async () => {
    await seedMap([["a.md", "A"]]);
    const result = await buildDistillMapInjection({
      enabled: true,
      userDataDir: dir,
      memoryTokensUsed: 1490,
      budget: 1500,
    });
    expect(result.text).toBe("");
    expect(result.skipped).toBe("budget");
  });

  it("去掉与记忆重叠的来源行，但保留表头", () => {
    const map = [
      "| 主题 | 文件 | 来源数 | 刷新于 |",
      "|------|------|--------|--------|",
      "| A | reflections/a.md | 1 | 2026-11-08 |",
      "| B | reflections/b.md | 1 | 2026-11-08 |",
    ].join("\n");
    const result = dropMemoryOverlap(map, ["reflections/a.md"]);
    expect(result).not.toContain("reflections/a.md");
    expect(result).toContain("reflections/b.md");
    expect(result).toContain("| 主题 |");
    expect(result).toContain("|---");
  });

  it("sourceKey 去掉目录与扩展名", () => {
    expect(sourceKey("reflections/inbox/记忆.md")).toBe("记忆");
    expect(sourceKey("a\\b\\c.txt")).toBe("c");
  });

  it("正常情况原样注入地图内容", async () => {
    await seedMap([["a.md", "A"]]);
    const result = await buildDistillMapInjection({ enabled: true, userDataDir: dir });
    expect(result.text).toContain("a.md");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.skipped).toBeUndefined();
  });
});

describe("目录形状", () => {
  it("初始化时不创建 distill/chat（已决定不做）", async () => {
    await stat(path.join(dir, "distill", "chat")).then(
      () => { throw new Error("不应该创建 distill/chat"); },
      () => { /* 不存在才正确 */ },
    );
  });
});

describe("工具与路由的配置传递（冒烟测试发现的缺陷）", () => {
  it("distill 工具未拿到 config 时明确报错，而不是伪装成「没有来源」", async () => {
    const { createDistillTool } = await import("../tools/distill.js");
    const tool = createDistillTool({ readable: [], writable: [], denied: [] });
    const result = await tool.execute({
      scope: "reflections",
      path: "x.md",
      sources: ["reflections/inbox/a.md"],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("配置");
  });

  it("distill 工具拿到 config 后会走到模型调用（失败信息来自 provider 而非缺配置）", async () => {
    const { createDistillTool } = await import("../tools/distill.js");
    await writeFile(path.join(dir, "reflections", "inbox", "a.md"), "原文", "utf-8");
    const tool = createDistillTool(
      { readable: [], writable: [], denied: [] },
      // 最小可用 config：provider/model 都有，但 key 是假的 → 会在网络层失败。
      {
        compaction: { provider: "deepseek", model: "deepseek-chat", thinkingEffort: "off" },
        providers: { deepseek: { apiKey: "sk-fake", models: [], baseUrl: "http://127.0.0.1:1" } },
      } as never,
    );
    const result = await tool.execute({
      scope: "reflections",
      path: "x.md",
      sources: ["reflections/inbox/a.md"],
    });
    expect(result.isError).toBe(true);
    // 关键：不是「未提供配置」，说明 config 确实透传进去了。
    expect(result.content).not.toContain("未提供配置");
  });
});
