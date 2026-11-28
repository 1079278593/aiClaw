/**
 * 领域（专家）注入：plan_experts §3 / §5 阶段 1 的契约。
 *
 * 断言的重点不是「拼出来的字符串长什么样」，而是四条会真正改变模型行为的边界：
 * 1. 没勾选时与现在一模一样（不多一个块、不多一行提示）；
 * 2. 勾上后带规则、带目录、带 `knowledge_base/<领域>/` 前缀，但**不带正文**；
 * 3. 超限整段不带，绝不截断——`index.md` 写长只丢目录，不连带丢规则；
 * 4. 路径越界（`../people`）与整理调用都不注入。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../chat/context-budget.js";
import { buildSystemBlocks } from "../chat/index.js";
import {
  EXPERTS_MAX,
  EXPERTS_TOKEN_MAX,
  EXPERT_INDEX_TOKEN_MAX,
  buildExpertsBlock,
  isValidExpertId,
  normalizeExpertIds,
  readExpertDomain,
} from "./index.js";
import { saveSession, createSession, loadSession } from "../session/index.js";
import { collectContextSources } from "../context/sources.js";
import { runWithTenant } from "../tenant/store.js";

let base = "";

async function writeDomain(id: string, rules: string, index?: string): Promise<void> {
  const dir = path.join(base, "knowledge_base", id);
  await mkdir(dir, { recursive: true });
  if (rules !== "") await writeFile(path.join(dir, "rules.md"), rules, "utf-8");
  if (index !== undefined) await writeFile(path.join(dir, "index.md"), index, "utf-8");
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-experts-"));
  await mkdir(path.join(base, "knowledge_base"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("isValidExpertId", () => {
  it("接受单一路径段", () => {
    expect(isValidExpertId("情感")).toBe(true);
    expect(isValidExpertId("finance-2026")).toBe(true);
  });

  it("拒绝空串、分隔符、上跳与控制字符", () => {
    for (const bad of ["", ".", "..", "../people", "a/b", "a\\b", "a\u0000b", "x".repeat(200)]) {
      expect(isValidExpertId(bad)).toBe(false);
    }
    expect(isValidExpertId(undefined)).toBe(false);
    expect(isValidExpertId(42)).toBe(false);
  });
});

describe("normalizeExpertIds", () => {
  it("去掉非法项与重复项，并按上限收敛", () => {
    expect(normalizeExpertIds(["情感", "../people", "情感", "理财", "运动"])).toEqual(["情感", "理财"]);
    expect(normalizeExpertIds([])).toBeUndefined();
    expect(normalizeExpertIds("情感")).toBeUndefined();
    expect(normalizeExpertIds(["情感"])).toHaveLength(1);
  });

  it("上限就是 2 个（接口层拒绝第三个，这里只保证不把整轮搞坏）", () => {
    expect(EXPERTS_MAX).toBe(2);
  });
});

describe("readExpertDomain", () => {
  it("规则为空或不存在时跳过这一段", async () => {
    await writeDomain("空规则", "");
    await writeDomain("没规则", "", "| 文件 | 说明 |\n|---|---|\n");
    expect((await readExpertDomain("空规则", base)).skipped).toBe("no-rules");
    expect((await readExpertDomain("没规则", base)).skipped).toBe("no-rules");
    expect((await readExpertDomain("不存在", base)).skipped).toBe("no-rules");
  });

  it("../ 这类输入解析到 knowledge_base 之外时拒绝", async () => {
    // 在 base 根上放一份「人」目录，确认不会被当成领域读到。
    await mkdir(path.join(base, "people"), { recursive: true });
    await writeFile(path.join(base, "people", "rules.md"), "不该被读到", "utf-8");
    const domain = await readExpertDomain("../people", base);
    expect(domain.skipped).toBe("unsafe");
    expect(domain.rules).toBe("");
  });

  it("没有 index.md 时 index 为空串，交给装配层写「这个领域没有目录」", async () => {
    await writeDomain("情感", "先澄清情绪，不急着给建议。");
    const domain = await readExpertDomain("情感", base);
    expect(domain.skipped).toBeUndefined();
    expect(domain.index).toBe("");
  });
});

describe("buildExpertsBlock", () => {
  it("带规则、带目录、带 knowledge_base/<领域>/ 前缀，不带正文", async () => {
    await writeDomain(
      "情感",
      "先澄清情绪，不急着给建议。",
      "| 文件 | 说明 |\n|---|---|\n| 依恋.md | 安全型与回避型 |\n",
    );
    await writeFile(path.join(base, "knowledge_base", "情感", "依恋.md"), "正文不该出现在注入里", "utf-8");

    const block = await buildExpertsBlock(["情感"], { userDataDir: base });
    expect(block.skipped).toBeUndefined();
    expect(block.text).toContain('<专家 领域="情感">');
    expect(block.text).toContain("先澄清情绪，不急着给建议。");
    expect(block.text).toContain("目录：");
    expect(block.text).toContain("依恋.md");
    // 路径由服务端拼：目录里是相对链接，read 只认完整相对路径。
    expect(block.text).toContain("knowledge_base/情感/<文件名>");
    // 正文不带：模型要用 read 自己打开。
    expect(block.text).not.toContain("正文不该出现在注入里");
    expect(block.tokens).toBe(estimateTokens(block.text));
  });

  it("没有 index.md 时写「这个领域没有目录」", async () => {
    await writeDomain("理财", "不报具体买卖。");
    const block = await buildExpertsBlock(["理财"], { userDataDir: base });
    expect(block.text).toContain("这个领域没有目录");
  });

  it("两个领域按勾选顺序拼接", async () => {
    await writeDomain("情感", "情感规则");
    await writeDomain("理财", "理财规则");
    const block = await buildExpertsBlock(["理财", "情感"], { userDataDir: base });
    expect(block.text.indexOf('<专家 领域="理财">')).toBeLessThan(block.text.indexOf('<专家 领域="情感">'));
  });

  it("规则超 1200 token 时这一段消失，另一段仍在", async () => {
    // 中文按 0.7 token/字估算，1800 字约 1260 token，已过单篇 1200 上限。
    await writeDomain("长规则", "规".repeat(1800));
    await writeDomain("情感", "先澄清情绪。");

    const block = await buildExpertsBlock(["长规则", "情感"], { userDataDir: base });
    expect(block.text).not.toContain("长规则");
    expect(block.text).toContain("先澄清情绪。");
    expect(block.domains.map((domain) => domain.id)).toEqual(["情感"]);
  });

  it("目录超 800 token 时规则仍在，目录换成一行提示", async () => {
    await writeDomain("情感", "先澄清情绪。", "| 文件 | 说明 |\n".repeat(EXPERT_INDEX_TOKEN_MAX));
    const block = await buildExpertsBlock(["情感"], { userDataDir: base });
    expect(block.text).toContain("先澄清情绪。");
    expect(block.text).toContain("目录超限，未注入");
    expect(block.domains[0].indexDropped).toBe(true);
  });

  it("两块合计超 2000 token 时整块不带，不截成半段", async () => {
    // 每段规则都在单篇 1200 以内（1500 字约 1050 token），两块合计已过 2000。
    const rules = "规".repeat(1500);
    await writeDomain("甲", rules);
    await writeDomain("乙", rules);
    const block = await buildExpertsBlock(["甲", "乙"], { userDataDir: base });
    expect(block.skipped).toBe("too-large");
    expect(block.text).toBe("");
    expect(block.tokens).toBe(0);
    expect(block.domains).toEqual([]);
  });

  it("没勾选、全是非法 id、目录已删时不注入", async () => {
    expect((await buildExpertsBlock([], { userDataDir: base })).text).toBe("");
    expect((await buildExpertsBlock(["../people"], { userDataDir: base })).text).toBe("");
    expect((await buildExpertsBlock(undefined, { userDataDir: base })).text).toBe("");
    // 勾过但文件被删：跳过这一段，不抛。
    expect((await buildExpertsBlock(["已删"], { userDataDir: base })).text).toBe("");
  });
});

describe("buildSystemBlocks 里的 experts 块", () => {
  it("不传领域文本时与现在一致：只有 policy", () => {
    expect(buildSystemBlocks("策略", null).map((block) => block.name)).toEqual(["policy"]);
  });

  it("带上领域块时排在对话状态之前、policy 之后", () => {
    const blocks = buildSystemBlocks("策略", null, null, null, "状态", "领域正文");
    expect(blocks.map((block) => block.name)).toEqual(["experts", "dialogueState", "policy"]);
    expect(blocks.find((block) => block.name === "experts")?.max).toBe(EXPERTS_TOKEN_MAX);
  });

  it("领域块为空串时不占块位", () => {
    expect(buildSystemBlocks("策略", null, null, null, null, "").map((block) => block.name)).toEqual(["policy"]);
  });
});

describe("会话持久化", () => {
  it("experts 写进 metadata 再读出来，换一条会话不跟着走", async () => {
    const withExperts = await createSession("带领域", base);
    withExperts.experts = ["情感"];
    await saveSession(withExperts, base);

    const other = await createSession("不带领域", base);

    expect((await loadSession(withExperts.id, base)).experts).toEqual(["情感"]);
    expect((await loadSession(other.id, base)).experts).toBeUndefined();
  });

  it("非法字段不会把整条会话读坏", async () => {
    const session = await createSession("脏数据", base);
    await writeFile(
      path.join(base, "conversations", `${session.id}.jsonl`),
      `${JSON.stringify({
        id: "meta",
        role: "system",
        content: "",
        timestamp: session.createdAt,
        metadata: { title: "脏数据", sessionId: session.id, experts: ["情感", 42, "../people"] },
      })}\n`,
      "utf-8",
    );
    const loaded = await loadSession(session.id, base);
    // 读路径与写路径用同一条收敛规则：非法项丢掉，剩下合法的照常读到。
    expect(loaded.experts).toEqual(["情感"]);
  });
});

describe("上下文来源", () => {
  const switches = { injectRootIndex: false, injectDistillMap: false };

  it("不传会话时不列领域块", async () => {
    await writeDomain("情感", "先澄清情绪。");
    const overview = await runWithTenant({ id: "t", base }, () => collectContextSources(switches));
    expect(overview.sources.some((item) => item.id === "experts")).toBe(false);
  });

  it("传了会话但没勾选时也不列", async () => {
    const session = await createSession("普通", base);
    const overview = await runWithTenant({ id: "t", base }, () =>
      collectContextSources({ ...switches, sessionId: session.id }));
    expect(overview.sources.some((item) => item.id === "experts")).toBe(false);
  });

  it("勾选后列出这一块，标上实际 token 与 2000 上限", async () => {
    await writeDomain("情感", "先澄清情绪，不急着给建议。", "| 文件 | 说明 |\n|---|---|\n| 依恋.md | 类型 |\n");
    const session = await createSession("勾了情感", base);
    session.experts = ["情感"];
    await saveSession(session, base);

    const overview = await runWithTenant({ id: "t", base }, () =>
      collectContextSources({ ...switches, sessionId: session.id }));
    const experts = overview.sources.find((item) => item.id === "experts");

    expect(experts).toBeDefined();
    expect(experts?.max).toBe(EXPERTS_TOKEN_MAX);
    expect(experts?.tokens).toBeGreaterThan(0);
    expect(experts?.tokens).toBe(estimateTokens(experts?.content ?? ""));
    expect(experts?.overLimit).toBe(false);
    // 内容以文件为准，不在这个页面编辑。
    expect(experts?.editable).toBe(false);
    expect(experts?.label).toContain("情感");
  });
});
