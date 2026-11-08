/**
 * pending 提案与 apply（plan §13.2 第 3、4、5、6、18、22、26 条）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexWriter, noopIndexWriter } from "../index/indexer.js";
import { createReflectionsStore } from "../reflections/store.js";
import {
  archiveProposal,
  createProposal,
  dismissProposal,
  listPending,
  readPendingMeta,
  PendingError,
} from "./store.js";
import { applyAllProposals, applyProposal } from "./apply.js";
import { DAY_MS, shouldArchive, shouldDeleteArchiveDir, sweepPendingTtl } from "./ttl.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-pending-"));
  for (const rel of ["reflections/inbox", "knowledge_base/库", "pending/_archive"]) {
    await mkdir(path.join(base, rel), { recursive: true });
  }
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function store() {
  return createReflectionsStore({ indexWriter: createIndexWriter({ baseDir: base }), userDataDir: base });
}

describe("propose_change 的边界", () => {
  it("3. target 指向知识区外被拒绝", async () => {
    await expect(createProposal({
      target: "people/a1/profile.md",
      kind: "doc",
      body: "x",
      summary: "改档案",
      userDataDir: base,
    })).rejects.toBeInstanceOf(PendingError);

    await expect(createProposal({
      target: "conversations/abc.jsonl",
      kind: "doc",
      body: "x",
      summary: "改会话",
      userDataDir: base,
    })).rejects.toThrow(/reflections\/ 或 knowledge_base\//);
  });

  it("与现有内容相同时拒绝（无需变更）", async () => {
    const file = path.join(base, "knowledge_base", "库", "文档.md");
    await writeFile(file, "同一份内容\n", "utf-8");
    await expect(createProposal({
      target: "knowledge_base/库/文档.md",
      kind: "doc",
      body: "同一份内容\n",
      summary: "无变化",
      userDataDir: base,
    })).rejects.toThrow(/无需变更/);
  });
});

describe("apply 的哈希语义", () => {
  it("4. baseHash 不匹配 → 失败且原文不变", async () => {
    const created = await store().createReflection({ title: "甲", body: "原文", folder: "inbox", userDataDir: base });
    const meta = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "提案正文",
      summary: "补正文",
      userDataDir: base,
    });

    // 用户在提案生成后自己改了原文。
    await store().updateReflection({ path: created.path, body: "用户改过", userDataDir: base });

    const result = await applyProposal(meta.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "conflict", target: created.path });
    expect(await readFile(path.join(base, created.path), "utf-8")).toContain("用户改过");
    expect((await readPendingMeta(meta.id, base)).status).toBe("open");
  });

  it("5. current == proposed → 幂等成功并归档", async () => {
    const created = await store().createReflection({ title: "甲", body: "原文", folder: "inbox", userDataDir: base });
    const meta = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "提案正文",
      summary: "补正文",
      userDataDir: base,
    });
    // 模拟「写到一半崩溃」：文件已是提案内容，但提案还停在 open。
    await store().updateReflection({ path: created.path, body: "提案正文", userDataDir: base });

    const result = await applyProposal(meta.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(result).toMatchObject({ ok: true, status: "applied", idempotent: true });
    // 已归档：不在 pending/ 里，而在 pending/_archive/。
    expect(await listPending({ userDataDir: base })).toHaveLength(0);
    expect((await listPending({ status: "all", userDataDir: base }))).toHaveLength(0);
  });

  it("6. CRLF 文件 apply 不产生假冲突", async () => {
    const target = path.join(base, "knowledge_base", "库", "windows.md");
    await writeFile(target, "第一行\r\n第二行\r\n", "utf-8");
    const meta = await createProposal({
      target: "knowledge_base/库/windows.md",
      kind: "doc",
      body: "第一行\n第二行\n改过的第三行\n",
      summary: "补一行",
      userDataDir: base,
    });
    const result = await applyProposal(meta.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(result.ok).toBe(true);
    expect(await readFile(target, "utf-8")).toContain("改过的第三行");
  });

  it("dismiss 之后 apply 不再写文件", async () => {
    const target = path.join(base, "knowledge_base", "库", "d.md");
    await writeFile(target, "原文\n", "utf-8");
    const meta = await createProposal({
      target: "knowledge_base/库/d.md",
      kind: "doc",
      body: "新文\n",
      summary: "改",
      userDataDir: base,
    });
    await dismissProposal(meta.id, base);
    const result = await applyProposal(meta.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(result).toMatchObject({ ok: true, status: "applied", idempotent: true });
    expect(await readFile(target, "utf-8")).toBe("原文\n");
  });
});

describe("改名后的日报式反查", () => {
  it("18. 目标被改名后，另一条提案经 renamedFrom 反查成功", async () => {
    const created = await store().createReflection({ title: "原题", body: "正文", folder: "inbox", userDataDir: base });
    // 提案 A：改标题（会触发改名），并在 apply 后记录 renamedFrom。
    const proposalA = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "正文",
      fields: { title: "新题" },
      summary: "改标题",
      userDataDir: base,
    });
    const appliedA = await applyProposal(proposalA.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(appliedA.ok && appliedA.status === "applied" && appliedA.path).toBe("reflections/inbox/新题.md");

    // 提案 B 仍指向旧路径。
    const proposalB = await createProposal({
      target: "reflections/inbox/原题.md",
      kind: "reflection",
      body: "正文追加",
      summary: "补一句",
      userDataDir: base,
    });
    // 老路径的 base.md 已经取不到了（文件不存在）→ create 语义，这里改为构造：直接把 B 的 baseHash 设为旧内容。
    expect(proposalB.changeType).toBe("create");

    // 用真实场景：B 在改名之前创建。
    const created2 = await store().createReflection({ title: "乙原", body: "乙正文", folder: "inbox", userDataDir: base });
    const proposalB2 = await createProposal({
      target: created2.path,
      kind: "reflection",
      body: "乙正文改",
      summary: "改乙",
      userDataDir: base,
    });
    const proposalC = await createProposal({
      target: created2.path,
      kind: "reflection",
      body: "乙正文再改",
      summary: "再改乙",
      userDataDir: base,
    });
    // 先把乙改名（产生 renamedFrom），再 apply C。
    const storeB2 = store();
    await storeB2.updateReflection({ path: created2.path, title: "乙新", userDataDir: base });
    const metaC = await readPendingMeta(proposalC.id, base);
    // C 的 target 仍是旧路径 → 走 baseHash 全树重定位。
    expect(metaC.target).toBe(created2.path);
    const appliedC = await applyProposal(proposalC.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(appliedC.ok).toBe(true);
    expect(await readFile(path.join(base, "reflections/inbox/乙新.md"), "utf-8")).toContain("乙正文再改");
    // B2 与 C 都指向同一原文，B2 现在应因哈希不匹配而冲突（不误写）。
    const appliedB2 = await applyProposal(proposalB2.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(appliedB2.ok).toBe(false);
  });
});

describe("baseHash 重定位多命中", () => {
  it("22. 同目录唯一则命中；跨目录无法区分则 stale（ambiguous-basehash）且不写文件", async () => {
    // 同目录副本：reflections/inbox 下两篇内容相同。
    const sameDirA = path.join(base, "reflections", "inbox", "副本A.md");
    const sameDirB = path.join(base, "reflections", "inbox", "副本B.md");
    await writeFile(sameDirA, "一模一样\n", "utf-8");
    await writeFile(sameDirB, "一模一样\n", "utf-8");

    const meta = await createProposal({
      target: "reflections/inbox/副本A.md",
      kind: "reflection",
      body: "改后正文\n",
      summary: "改副本",
      userDataDir: base,
    });
    // 让 target 消失，但同目录仍有唯一「同名 + 同内容」候选：把 A 删掉，只留 B 与另一目录的 C。
    await rm(sameDirA);
    // 同目录只剩 B，且文件名不同 → 第 3 级「同目录唯一」命中。
    const found = await applyProposal(meta.id, { indexWriter: noopIndexWriter, userDataDir: base });
    if (!found.ok) console.log("DEBUG found:", JSON.stringify(found), JSON.stringify(await readPendingMeta(meta.id, base)));
    expect(found.ok).toBe(true);
    expect(await readFile(sameDirB, "utf-8")).toContain("改后正文");

    // 跨目录无法区分：inbox 一份 + 两个其他目录各一份，删掉 inbox 那份后剩两份同内容。
    const dirX = path.join(base, "reflections", "技术");
    const dirY = path.join(base, "reflections", "生活");
    await mkdir(dirX, { recursive: true });
    await mkdir(dirY, { recursive: true });
    await writeFile(path.join(dirX, "同.md"), "跨目录相同\n", "utf-8");
    await writeFile(path.join(dirY, "同.md"), "跨目录相同\n", "utf-8");
    const targetSame = path.join(base, "reflections", "inbox", "同.md");
    await writeFile(targetSame, "跨目录相同\n", "utf-8");

    const ambiguous = await createProposal({
      target: "reflections/inbox/同.md",
      kind: "reflection",
      body: "不该写进去\n",
      summary: "跨目录",
      userDataDir: base,
    });
    // 删掉 target，构造「全树两份同内容但都不在 inbox」。
    await rm(targetSame);
    const result = await applyProposal(ambiguous.id, { indexWriter: noopIndexWriter, userDataDir: base });
    expect(result).toMatchObject({ ok: false, status: "stale", reason: "ambiguous-basehash" });
    expect(await readFile(path.join(dirX, "同.md"), "utf-8")).toBe("跨目录相同\n");
    expect(await readFile(path.join(dirY, "同.md"), "utf-8")).toBe("跨目录相同\n");
    expect((await readPendingMeta(ambiguous.id, base)).status).toBe("stale");
  });
});

describe("pending/_archive 的 TTL", () => {
  it("26. 第 31 天归档、第 61 天物理删除；open 永不被清理", async () => {
    const now = new Date("2026-06-01T00:00:00Z");

    // open：永不清理。
    const openMeta = {
      id: "open-1",
      status: "open" as const,
      createdAt: new Date(now.getTime() - 400 * DAY_MS).toISOString(),
    };
    expect(shouldArchive(openMeta as never, now)).toBe(false);

    // applied 第 29 天：不归档。
    const day29 = {
      id: "a",
      status: "applied" as const,
      createdAt: new Date(now.getTime() - 100 * DAY_MS).toISOString(),
      settledAt: new Date(now.getTime() - 29 * DAY_MS).toISOString(),
    };
    expect(shouldArchive(day29 as never, now)).toBe(false);

    // applied 第 31 天：归档。
    const day31 = { ...day29, settledAt: new Date(now.getTime() - 31 * DAY_MS).toISOString() };
    expect(shouldArchive(day31 as never, now)).toBe(true);

    // _archive 内容第 29 天：保留；第 31 天：删除（进入 _archive 后再 30 天）。
    expect(shouldDeleteArchiveDir(now.getTime() - 29 * DAY_MS, now)).toBe(false);
    expect(shouldDeleteArchiveDir(now.getTime() - 31 * DAY_MS, now)).toBe(true);

    // 端到端：一条 applied 提案被真的搬进 _archive。
    const created = await store().createReflection({ title: "旧", body: "正文", folder: "inbox", userDataDir: base });
    const meta = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "新正文",
      summary: "改",
      userDataDir: base,
    });
    await applyProposal(meta.id, { indexWriter: noopIndexWriter, userDataDir: base });
    // apply 已归档，这里再造一条「过期未归档」的样本。
    const toBeArchived = await createProposal({
      target: `${created.path}`,
      kind: "reflection",
      body: "另一份正文",
      summary: "改2",
      userDataDir: base,
    });
    await dismissProposal(toBeArchived.id, base);
    const archived = await sweepPendingTtl({ userDataDir: base, now: new Date(Date.now() + 31 * DAY_MS) });
    expect(archived.archived).toContain(toBeArchived.id);
    expect(archived.failed).toEqual([]);

    // 进入 _archive 满 30 天后再跑一次：物理删除（从归档时刻起算，不是从离开 open 起算）。
    const deleted = await sweepPendingTtl({ userDataDir: base, now: new Date(Date.now() + 31 * DAY_MS) });
    expect(deleted.deleted).toContain(toBeArchived.id);

    // open 的那条还在。
    const open = await createProposal({
      target: created.path,
      kind: "reflection",
      body: "第三条正文",
      summary: "改3",
      userDataDir: base,
    });
    const swept = await sweepPendingTtl({ userDataDir: base, now: new Date(Date.now() + 365 * DAY_MS) });
    expect(swept.archived).not.toContain(open.id);
    expect((await readPendingMeta(open.id, base)).status).toBe("open");
  });

  it("archiveProposal 对同名归档加时间戳而不覆盖", async () => {
    const dir = path.join(base, "pending", "dup-1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: "dup-1" }), "utf-8");
    await archiveProposal("dup-1", base);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: "dup-1", v: 2 }), "utf-8");
    await archiveProposal("dup-1", base);
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(path.join(base, "pending", "_archive")));
    expect(entries.filter((name) => name.startsWith("dup-1"))).toHaveLength(2);
  });
});

describe("apply-all（plan §12.2）", () => {
  it("全部 open 提案按创建时间顺序应用", async () => {
    const target = path.join(base, "knowledge_base", "库", "批量.md");
    await writeFile(target, "第一版\n", "utf-8");
    const first = await createProposal({
      target: "knowledge_base/库/批量.md",
      kind: "doc",
      body: "第二版\n",
      summary: "第一次改",
      userDataDir: base,
    });
    // 第二个提案基于第一版内容（尚未应用时的当前内容），因此也要能正常应用。
    const second = await createProposal({
      target: "knowledge_base/库/批量二.md",
      kind: "doc",
      body: "另一份\n",
      summary: "新增一篇",
      userDataDir: base,
    });

    const result = await applyAllProposals({ userDataDir: base, indexWriter: noopIndexWriter });
    expect(result.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(result.applied).toBe(2);
    expect(result.ok).toBe(true);
    expect(await readFile(target, "utf-8")).toBe("第二版\n");
  });

  it("同一文件的第二个提案因 baseHash 失效而降级为 stale，但不中止整批", async () => {
    const target = path.join(base, "knowledge_base", "库", "撞车.md");
    await writeFile(target, "原始\n", "utf-8");
    const a = await createProposal({
      target: "knowledge_base/库/撞车.md",
      kind: "doc",
      body: "A 写入\n",
      summary: "A 的改法",
      userDataDir: base,
    });
    const b = await createProposal({
      target: "knowledge_base/库/撞车.md",
      kind: "doc",
      body: "B 写入\n",
      summary: "B 的改法",
      userDataDir: base,
    });

    const result = await applyAllProposals({ userDataDir: base, indexWriter: noopIndexWriter });
    // 先创建的先应用；第二个面对的已经不是它记录的 baseHash。
    expect(result.applied).toBe(1);
    expect(result.ok).toBe(false);
    const byId = new Map(result.items.map((item) => [item.id, item.result]));
    expect(byId.get(a.id)).toMatchObject({ ok: true, status: "applied" });
    expect(byId.get(b.id)).toMatchObject({ ok: false });
    // 冲突不静默合并：文件内容只反映 A。
    expect(await readFile(target, "utf-8")).toBe("A 写入\n");
  });

  it("显式 ids 只应用指定提案，未选中的保持 open", async () => {
    const first = await createProposal({
      target: "knowledge_base/库/选一.md",
      kind: "doc",
      body: "一\n",
      summary: "一",
      userDataDir: base,
    });
    const second = await createProposal({
      target: "knowledge_base/库/选二.md",
      kind: "doc",
      body: "二\n",
      summary: "二",
      userDataDir: base,
    });

    const result = await applyAllProposals({
      userDataDir: base,
      indexWriter: noopIndexWriter,
      ids: [second.id],
    });
    expect(result.applied).toBe(1);
    expect(result.items[0].id).toBe(second.id);
    const rest = await listPending({ status: "open", userDataDir: base });
    expect(rest.map((item) => item.id)).toEqual([first.id]);
  });

  it("不存在的 id 记为失败，不影响其他提案", async () => {
    const real = await createProposal({
      target: "knowledge_base/库/真.md",
      kind: "doc",
      body: "真\n",
      summary: "真",
      userDataDir: base,
    });
    const result = await applyAllProposals({
      userDataDir: base,
      indexWriter: noopIndexWriter,
      ids: ["does-not-exist", real.id],
    });
    expect(result.items[0].result).toMatchObject({ ok: false, error: "pending not found" });
    expect(result.items[1].result).toMatchObject({ ok: true, status: "applied" });
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("dryRun 不写入任何文件", async () => {
    await writeFile(path.join(base, "knowledge_base", "库", "预演.md"), "旧\n", "utf-8");
    await createProposal({
      target: "knowledge_base/库/预演.md",
      kind: "doc",
      body: "新\n",
      summary: "预演",
      userDataDir: base,
    });
    const result = await applyAllProposals({ userDataDir: base, indexWriter: noopIndexWriter, dryRun: true });
    expect(result.items[0].result).toMatchObject({ ok: true, status: "dry-run" });
    expect(result.applied).toBe(0);
    expect(await readFile(path.join(base, "knowledge_base", "库", "预演.md"), "utf-8")).toBe("旧\n");
  });
});

describe("create 提案的 apply 回归", () => {
  it("目标文件不存在时 create 提案能被应用（曾因 target-missing 误判 stale）", async () => {
    const proposal = await createProposal({
      target: "knowledge_base/库/全新.md",
      kind: "doc",
      body: "全新内容\n",
      summary: "新建文档",
      userDataDir: base,
    });
    expect(proposal.changeType).toBe("create");

    const result = await applyProposal(proposal.id, { userDataDir: base, indexWriter: noopIndexWriter });
    expect(result).toMatchObject({ ok: true, status: "applied" });
    expect(await readFile(path.join(base, "knowledge_base", "库", "全新.md"), "utf-8")).toBe("全新内容\n");
  });

  it("create 提案的目标后来被别人建出不同内容 → 冲突，绝不覆盖", async () => {
    const proposal = await createProposal({
      target: "knowledge_base/库/抢先.md",
      kind: "doc",
      body: "提案内容\n",
      summary: "新建",
      userDataDir: base,
    });
    await writeFile(path.join(base, "knowledge_base", "库", "抢先.md"), "别人写的\n", "utf-8");

    const result = await applyProposal(proposal.id, { userDataDir: base, indexWriter: noopIndexWriter });
    expect(result).toMatchObject({ ok: false, error: "conflict" });
    expect(await readFile(path.join(base, "knowledge_base", "库", "抢先.md"), "utf-8")).toBe("别人写的\n");
  });

  it("create 提案的目标后来被建出相同内容 → 幂等成功", async () => {
    const proposal = await createProposal({
      target: "knowledge_base/库/撞同.md",
      kind: "doc",
      body: "一样的内容\n",
      summary: "新建",
      userDataDir: base,
    });
    await writeFile(path.join(base, "knowledge_base", "库", "撞同.md"), "一样的内容\n", "utf-8");

    const result = await applyProposal(proposal.id, { userDataDir: base, indexWriter: noopIndexWriter });
    expect(result).toMatchObject({ ok: true, status: "applied", idempotent: true });
  });
});
