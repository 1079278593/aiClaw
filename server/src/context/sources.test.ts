/**
 * 上下文来源：清单统计与「确认后落盘」的契约。
 *
 * 重点断言三件事，都是「页面数字会被当真」的前提：
 * 1. token 口径与预算报表一致（同一 `estimateTokens`）；
 * 2. 不注入的块（开关关闭、旧装兜底）**不计入**固定成本；
 * 3. 超上限的内容**拒绝写入**，而不是写进去再被预算静默丢弃。
 *
 * 所有读写都在 `runWithTenant` 里跑：`sources` 用 `getUserDataDir()` 定位数据根，
 * 不在租户上下文里会落到安装根，测出来的东西跟断言无关。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../chat/context-budget.js";
import { MEMORY_TOKEN_MAX, POLICY_TOKEN_MAX } from "../chat/index.js";
import {
  ContextSourceError,
  collectContextSources,
  writeContextSource,
  writeContextSources,
} from "./sources.js";
import { runWithTenant } from "../tenant/store.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-context-"));
  await mkdir(path.join(base, "agents", "main", "memory"), { recursive: true });
  await mkdir(path.join(base, "reflections"), { recursive: true });
  await mkdir(path.join(base, "distill", "meta"), { recursive: true });
  await mkdir(path.join(base, "files", "prompts"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const switches = { injectRootIndex: false, injectDistillMap: false };

function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenant({ id: "t", base }, fn);
}

describe("collectContextSources", () => {
  it("宪法存在时取自 AGENT.md，旧装兜底文件不计入成本", async () => {
    await writeFile(path.join(base, "agents", "main", "AGENT.md"), "# 宪法\n\n你是助手。\n");
    await writeFile(path.join(base, "files", "prompts", "agent_system_prompt.txt"), "旧提示词");

    const overview = await asTenant(() => collectContextSources(switches));
    const constitution = overview.sources.find((item) => item.id === "constitution");
    const fallback = overview.sources.find((item) => item.id === "constitutionFallback");

    expect(constitution?.file).toBe("agents/main/AGENT.md");
    expect(constitution?.tokens).toBe(estimateTokens("# 宪法\n\n你是助手。\n"));
    // 兜底文件此刻不注入：列出来是为了让用户看到它，但成本必须是 0。
    expect(fallback?.tokens).toBe(0);
    expect(fallback?.always).toBe(false);
  });

  it("AGENT.md 缺失时回退到旧文件，且该块计入固定成本", async () => {
    await writeFile(path.join(base, "files", "prompts", "agent_system_prompt.txt"), "旧提示词");
    const overview = await asTenant(() => collectContextSources(switches));
    const constitution = overview.sources.find((item) => item.id === "constitution");

    expect(constitution?.file).toBe("files/prompts/agent_system_prompt.txt");
    expect(constitution?.tokens).toBe(estimateTokens("旧提示词"));
    expect(overview.sources.some((item) => item.id === "constitutionFallback")).toBe(false);
  });

  it("根索引与蒸馏地图默认关闭时不计入每轮成本，开启后计入", async () => {
    await writeFile(path.join(base, "reflections", "_index.md"), "- a.md\n");
    await writeFile(path.join(base, "distill", "meta", "overview.md"), "| 主题 | 文件 |\n");

    const off = await asTenant(() => collectContextSources(switches));
    expect(off.sources.find((item) => item.id === "rootIndex")?.always).toBe(false);
    expect(off.sources.find((item) => item.id === "rootIndex")?.tokens).toBeGreaterThan(0);
    expect(off.sources.find((item) => item.id === "distillMap")?.always).toBe(false);

    const on = await asTenant(() => collectContextSources({ injectRootIndex: true, injectDistillMap: true }));
    expect(on.sources.find((item) => item.id === "rootIndex")?.always).toBe(true);
    expect(on.sources.find((item) => item.id === "distillMap")?.always).toBe(true);
    // 同一份内容，开关只改「是否计入」，不该改单块 token。
    expect(on.sources.find((item) => item.id === "rootIndex")?.tokens)
      .toBe(off.sources.find((item) => item.id === "rootIndex")?.tokens);
    expect(on.totalTokens).toBeGreaterThan(off.totalTokens);
  });

  it("记忆四层共用同一个预算上限，超限时四层一起标记", async () => {
    // 塞满 focus，让记忆整块超限。
    const body = Array.from({ length: 60 }, (_, index) => `## 条目${index}\n\n${"内容".repeat(120)}`).join("\n\n");
    await writeFile(path.join(base, "agents", "main", "memory", "focus.md"), body, "utf-8");

    const overview = await asTenant(() => collectContextSources(switches));
    const focus = overview.sources.find((item) => item.id === "focus");
    const user = overview.sources.find((item) => item.id === "user");

    expect(focus?.max).toBe(MEMORY_TOKEN_MAX);
    expect(user?.max).toBe(MEMORY_TOKEN_MAX);
    expect(focus?.overLimit).toBe(true);
    // 共享预算：focus 撑爆后，同属记忆块的 user 也标记为超限，避免误导成「user 还安全」。
    expect(user?.overLimit).toBe(true);
  });

  it("记忆层的展示内容是注入形态，但编辑文本是磁盘原文（避免写回时套娃）", async () => {
    await writeFile(path.join(base, "agents", "main", "memory", "focus.md"), "## 关注点\n\n原文内容", "utf-8");

    const overview = await asTenant(() => collectContextSources(switches));
    const focus = overview.sources.find((item) => item.id === "focus");

    // content 用于展示「模型实际看到什么」，带包装。
    expect(focus?.content).toContain('<memory source="agent"');
    // editText 是磁盘原文，不能带包装，否则保存一次就嵌套一层。
    expect(focus?.editText).toBe("## 关注点\n\n原文内容");
    expect(focus?.editText).not.toContain("<memory");
  });

  it("把 editText 原样保存后，磁盘内容不变（幂等，不会累积包装）", async () => {
    const original = "## 关注点\n\n原文内容";
    const file = path.join(base, "agents", "main", "memory", "focus.md");
    await writeFile(file, original, "utf-8");

    const overview = await asTenant(() => collectContextSources(switches));
    const focus = overview.sources.find((item) => item.id === "focus");
    await asTenant(() => writeContextSource("focus", focus?.editText ?? ""));

    expect(await readFile(file, "utf-8")).toBe(original);
  });

  it("合计只累加 always 的块", async () => {
    await writeFile(path.join(base, "agents", "main", "AGENT.md"), "宪法内容");
    await writeFile(path.join(base, "agents", "main", "memory", "user.md"), "## 画像\n\n喜欢简洁");
    const overview = await asTenant(() => collectContextSources(switches));

    const expected = overview.sources
      .filter((item) => item.always)
      .reduce((sum, item) => sum + item.tokens, 0);
    expect(overview.totalTokens).toBe(expected);
    expect(overview.totalTokens).toBeGreaterThan(0);
  });
});

describe("writeContextSource", () => {
  it("写入宪法后能在原文件读到内容（原子替换生效）", async () => {
    await asTenant(() => writeContextSource("constitution", "# 新宪法\n\n规则。"));
    const text = await readFile(path.join(base, "agents", "main", "AGENT.md"), "utf-8");
    expect(text).toBe("# 新宪法\n\n规则。");
  });

  it("超出该块 token 上限时拒绝写入，原文件保持不变", async () => {
    const original = "原始内容";
    await writeFile(path.join(base, "agents", "main", "AGENT.md"), original, "utf-8");

    // 构造明显超过 POLICY_TOKEN_MAX 的内容。
    const huge = "字".repeat(POLICY_TOKEN_MAX * 2 + 200);
    await expect(asTenant(() => writeContextSource("constitution", huge)))
      .rejects.toBeInstanceOf(ContextSourceError);

    const text = await readFile(path.join(base, "agents", "main", "AGENT.md"), "utf-8");
    expect(text).toBe(original);
  });

  it("拒绝编辑白名单之外的来源", async () => {
    await expect(asTenant(() => writeContextSource("rootIndex", "x")))
      .rejects.toBeInstanceOf(ContextSourceError);
  });

  it("用户画像可手改（user 不再只允许 Agent 写）", async () => {
    await asTenant(() => writeContextSource("user", "## 画像\n\n我自己写的内容"));
    const text = await readFile(path.join(base, "agents", "main", "user.md"), "utf-8");
    expect(text).toBe("## 画像\n\n我自己写的内容");

    const overview = await asTenant(() => collectContextSources(switches));
    const user = overview.sources.find((item) => item.id === "user");
    expect(user?.editable).toBe(true);
    expect(user?.content).toContain("我自己写的内容");
    expect(user?.entries).toBe(1);
  });

  it("覆盖记忆层后旧元数据被清除，正文不丢", async () => {
    const memoryDir = path.join(base, "agents", "main", "memory");
    await writeFile(path.join(memoryDir, "index.jsonl"), `${JSON.stringify({
      id: "old-1",
      layer: "focus",
      importance: "high",
      created: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      used: 9,
      pinned: true,
      writtenBy: "agent",
    })}\n`, "utf-8");

    await asTenant(() => writeContextSource("focus", "## 新关注点\n\n手写内容"));

    const index = await readFile(path.join(memoryDir, "index.jsonl"), "utf-8").catch(() => "");
    expect(index).toBe("");
    // 正文保留：readLayer 会给无 id 的块派生 id，不会让内容凭空消失。
    const overview = await asTenant(() => collectContextSources(switches));
    const focus = overview.sources.find((item) => item.id === "focus");
    expect(focus?.entries).toBe(1);
    expect(focus?.content).toContain("手写内容");
  });

  it("批量写入逐条独立：一条失败不影响另一条", async () => {
    const result = await asTenant(() => writeContextSources([
      { id: "constitution", content: "新宪法" },
      { id: "rootIndex", content: "不允许" },
    ]));
    expect(result.saved).toEqual(["constitution"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe("rootIndex");
  });
});

describe("租户隔离", () => {
  it("不同租户读到各自目录下的文件", async () => {
    await writeFile(path.join(base, "agents", "main", "AGENT.md"), "租户宪法", "utf-8");
    const overview = await asTenant(() => collectContextSources(switches));
    const constitution = overview.sources.find((item) => item.id === "constitution");
    expect(constitution?.tokens).toBe(estimateTokens("租户宪法"));
  });
});
