/**
 * 三档 ACL（plan §13.2 第 1、2、21、17 条）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FS_POLICY } from "../config/schema.js";
import { createFileTools } from "./file-tools.js";
import { assertFsAccess, checkFsPolicy } from "./fs-policy.js";
import { isKnowledgePath } from "../pending/store.js";
import { classifyToolRisk, needsConfirmation, sessionGrantKey } from "./risk.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-acl-"));
  process.env.AICLAW_DATA_DIR = base;
  for (const rel of [
    "reflections/inbox",
    "knowledge_base/库",
    "people/a1",
    "distill/knowledge",
    "agents/main",
    "files/prompts",
    "conversations",
  ]) {
    await mkdir(path.join(base, rel), { recursive: true });
  }
  await writeFile(path.join(base, "files", "prompts", "agent_system_prompt.txt"), "宪法", "utf-8");
  await writeFile(path.join(base, "agents", "main", "AGENT.md"), "角色", "utf-8");
  await writeFile(path.join(base, "agents", "main", "user.md"), "画像", "utf-8");
  await writeFile(path.join(base, "agents", "main", "runtime.md"), "运行时", "utf-8");
  await writeFile(path.join(base, "people", "a1", "profile.md"), "档案", "utf-8");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function tools() {
  return createFileTools(DEFAULT_FS_POLICY, []);
}

function tool(name: string) {
  const found = tools().find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("三档判定顺序", () => {
  it("denied 优先于 writable（即使落在可写区）", () => {
    expect(checkFsPolicy(path.join(base, "agents", "main", "AGENT.md"), "write", DEFAULT_FS_POLICY))
      .toMatchObject({ tier: "denied", allowed: false });
  });

  it("知识区可读不可写", () => {
    expect(checkFsPolicy(path.join(base, "reflections", "inbox"), "read", DEFAULT_FS_POLICY).allowed).toBe(true);
    expect(checkFsPolicy(path.join(base, "reflections", "inbox", "a.md"), "write", DEFAULT_FS_POLICY))
      .toMatchObject({ tier: "readable", allowed: false });
  });

  it("可写区读与写都通过", () => {
    expect(checkFsPolicy(path.join(base, "people", "a1", "profile.md"), "write", DEFAULT_FS_POLICY).allowed).toBe(true);
    expect(checkFsPolicy(path.join(base, "people", "a1", "profile.md"), "read", DEFAULT_FS_POLICY).allowed).toBe(true);
  });
});

describe("工具级拒绝", () => {
  it("1. move 从 reflections/ 搬到 distill/ 被拒绝", async () => {
    const result = await tool("move").execute({
      path: "reflections/inbox/a.md",
      new_path: "distill/knowledge/a.md",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read-only|not allowed/);
  });

  it("2. write 到 files/prompts/agent_system_prompt.txt 被拒绝", async () => {
    const result = await tool("write").execute({ path: "files/prompts/agent_system_prompt.txt", content: "改宪法" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/denied/i);
  });

  it("21. write/edit 到 AGENT.md 被拒绝，user.md 与 runtime.md 可写", async () => {
    const agentMd = await tool("write").execute({ path: "agents/main/AGENT.md", content: "改" });
    expect(agentMd.isError).toBe(true);
    const agentEdit = await tool("edit").execute({ path: "agents/main/AGENT.md", old_string: "角色", new_string: "改" });
    expect(agentEdit.isError).toBe(true);

    for (const rel of ["agents/main/user.md", "agents/main/runtime.md"]) {
      const write = await tool("write").execute({ path: rel, content: "新的正文" });
      expect(write.isError).toBeUndefined();
    }
  });

  it("21. denied 只约束工具：系统提示词文件仍可被服务端读取", async () => {
    // 直接 fs 读取（系统加载系统提示词走的是这条路，不经过 ACL）。
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(base, "files", "prompts", "agent_system_prompt.txt"), "utf-8")).toBe("宪法");
    // 但工具读不到它。
    const read = await tool("read").execute({ path: "files/prompts/agent_system_prompt.txt" });
    expect(read.isError).toBe(true);
  });

  it("delete 在 people/ 下走归档而不是物理删除", async () => {
    const result = await tool("delete").execute({ path: "people/a1/profile.md" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/Archived/);
    const { stat, readdir } = await import("node:fs/promises");
    await expect(stat(path.join(base, "people", "a1", "profile.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const archived = await readdir(path.join(base, "people", "a1", "_archive"));
    expect(archived.some((name) => name.endsWith("-profile.md"))).toBe(true);
  });
});

describe("授权分级（plan §3.5）", () => {
  it("read/propose_change/distill/pending 免确认", () => {
    expect(classifyToolRisk("read", { path: "reflections/a.md" })).toBe("safe");
    expect(classifyToolRisk("propose_change", { target: "reflections/a.md" })).toBe("safe");
    expect(classifyToolRisk("write", { path: "distill/knowledge/a.md" })).toBe("safe");
    expect(classifyToolRisk("write", { path: "pending/x/meta.json" })).toBe("safe");
  });

  it("people 常规写入是会话档，同会话只问一次", () => {
    const input = { path: "people/a1/digest.md" };
    const risk = classifyToolRisk("write", input);
    expect(risk).toBe("session");
    const key = sessionGrantKey("write", input);
    const granted = new Set<string>();
    expect(needsConfirmation(risk, granted, key)).toBe(true);
    granted.add(key);
    expect(needsConfirmation(risk, granted, sessionGrantKey("write", { path: "people/a1/profile.md" }))).toBe(false);
  });

  it("删除、跨目录 move、直接写 knowledge_base 每次都确认", () => {
    expect(classifyToolRisk("delete", { path: "people/a1/profile.md" })).toBe("always");
    expect(classifyToolRisk("move", { path: "people/a1/a.md", new_path: "distill/a.md" })).toBe("always");
    expect(classifyToolRisk("write", { path: "knowledge_base/库/文档.md" })).toBe("always");
  });

  it("confirm=never 把会话档降为免确认，always 档不受影响", () => {
    expect(classifyToolRisk("write", { path: "people/a1/digest.md" }, "never")).toBe("safe");
    expect(classifyToolRisk("delete", { path: "people/a1/digest.md" }, "never")).toBe("always");
    expect(classifyToolRisk("write", { path: "distill/a.md" }, "always")).toBe("safe");
    expect(classifyToolRisk("write", { path: "people/a1/digest.md" }, "always")).toBe("always");
  });

  it("批量写入（>3 个文件）每次都确认", () => {
    const paths = ["people/a1/a.md", "people/a1/b.md", "people/a1/c.md", "people/a1/d.md"];
    expect(classifyToolRisk("write", { paths })).toBe("always");
  });
});

describe("assertFsAccess 的错误语义", () => {
  it("写知识区给出「走 propose_change」的提示", () => {
    expect(() => assertFsAccess(path.join(base, "reflections", "x.md"), "write", DEFAULT_FS_POLICY))
      .toThrow(/propose_change/);
  });
});

describe("文档 / 人物复用同一套 ACL（plan §12.2 第 4 项）", () => {
  // 这两类内容走的是同一个 checkFsPolicy，差异只在配置的目录列表里，
  // 不允许在别处再写一份「文档能不能改」「人物能不能改」的判断。
  it("文档（knowledge_base）只读、人物（people）可写，由同一函数判定", () => {
    const doc = path.join(base, "knowledge_base", "库", "架构.md");
    const person = path.join(base, "people", "a1", "profile.md");

    expect(checkFsPolicy(doc, "read", DEFAULT_FS_POLICY).allowed).toBe(true);
    expect(checkFsPolicy(doc, "write", DEFAULT_FS_POLICY)).toMatchObject({
      allowed: false,
      tier: "readable",
    });

    expect(checkFsPolicy(person, "read", DEFAULT_FS_POLICY).allowed).toBe(true);
    expect(checkFsPolicy(person, "write", DEFAULT_FS_POLICY).allowed).toBe(true);
  });

  it("文档改动被拒时给出「走 propose_change」的指引，人物不会", () => {
    expect(() => assertFsAccess(
      path.join(base, "knowledge_base", "库", "架构.md"),
      "write",
      DEFAULT_FS_POLICY,
    )).toThrow(/propose_change/);

    expect(() => assertFsAccess(
      path.join(base, "people", "a1", "profile.md"),
      "write",
      DEFAULT_FS_POLICY,
    )).not.toThrow();
  });

  it("文档可以走提案，人物不需要（people 不在 pending 白名单）", () => {
    expect(isKnowledgePath("knowledge_base/库/架构.md")).toBe(true);
    expect(isKnowledgePath("reflections/inbox/a.md")).toBe(true);
    // people 是直写区：提案通道不覆盖它，免得同一份内容有两条写路径。
    expect(isKnowledgePath("people/a1/profile.md")).toBe(false);
  });
});
