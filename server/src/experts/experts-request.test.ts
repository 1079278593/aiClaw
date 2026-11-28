/**
 * 领域块真的进了请求（plan_experts §3 的落地断言）。
 *
 * 单测证明 `buildExpertsBlock` 拼得对；这里确认它经 `chatStream` 真的出现在
 * 发给模型的 system 里，并且整理调用里没有——否则实现得再对也不改变请求。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types/index.js";
import { getPaths, ensureDirectories } from "../config/paths.js";
import { saveSession, createSession } from "../session/index.js";

let dir = "";
const captured: Message[][] = [];

const fakeProvider = {
  label: "fake",
  async complete(_key: string, messages: Message[]) {
    captured.push(messages);
    return { content: "好的", finish_reason: "stop" };
  },
  async *stream(_key: string, messages: Message[]) {
    captured.push(messages);
    yield { type: "content" as const, text: "好的" };
    return { finish_reason: "stop" };
  },
};

vi.mock("../llm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/index.js")>("../llm/index.js");
  return { ...actual, createProvider: () => fakeProvider };
});

const config = {
  providers: {
    zai: {
      apiKey: "k",
      baseUrl: "https://example.invalid",
      models: [{ id: "glm-4.5-air", label: "x", contextWindow: 200_000 }],
    },
  },
  defaultProvider: "zai",
  defaultModel: "glm-4.5-air",
  defaultThinkingEffort: "off",
  maxTokens: 4096,
  contextMaxTokens: 100_000,
  contextMaxMessages: 0,
  injectRootIndex: false,
  injectDistillMap: false,
  autoRefreshDistill: false,
  autoOrganize: false,
  autoOrganizeCadence: "message",
  autoOrganizeDebounceMs: 0,
  autoOrganizeMinUnits: 0,
  maxToolCalls: 10,
  server: { port: 3000, host: "127.0.0.1", accessToken: "", corsOrigins: [] },
  fs: { policy: { readable: [], writable: [], denied: [] }, allowedFiles: [] },
  tools: { tavily: { enabled: false }, trilium: { enabled: false } },
  compaction: { provider: "zai", model: "glm-4.5-air", thinkingEffort: "off", keepRecentRounds: 0 },
};

async function writeDomain(id: string, rules: string): Promise<void> {
  const domainDir = path.join(dir, "knowledge_base", id);
  await mkdir(domainDir, { recursive: true });
  await writeFile(path.join(domainDir, "rules.md"), rules, "utf-8");
}

function systemText(sent: Message[] | undefined): string {
  return (sent ?? [])
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aiclaw-experts-request-"));
  process.env.AICLAW_DATA_DIR = dir;
  await ensureDirectories(getPaths(dir));
  captured.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("领域块进请求", () => {
  it("勾上后 system 里有规则与目录；没勾的会话没有", async () => {
    const { chatStream } = await import("../chat/index.js");
    await writeDomain("情感", "先澄清情绪，不急着给建议。");

    const picked = await createSession("勾了情感", dir);
    picked.experts = ["情感"];
    await saveSession(picked, dir);
    const plain = await createSession("没勾", dir);

    for await (const _chunk of chatStream(picked.id, "我很难过", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }
    for await (const _chunk of chatStream(plain.id, "我很难过", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }

    expect(systemText(captured[0])).toContain("先澄清情绪，不急着给建议。");
    expect(systemText(captured[0])).toContain('<专家 领域="情感">');
    // 换一条会话不跟着走。
    expect(systemText(captured[1])).not.toContain("先澄清情绪");
    expect(systemText(captured[1])).not.toContain("<专家");
  });

  it("整理调用不带领域块（同一模型同一规矩，整理只写简报）", async () => {
    const { chatStream } = await import("../chat/index.js");
    await writeDomain("情感", "先澄清情绪，不急着给建议。");

    const session = await createSession("整理", dir);
    session.experts = ["情感"];
    await saveSession(session, dir);

    for await (const _chunk of chatStream(session.id, "整理目前新增的内容。", config as never, {
      provider: "zai",
      model: "glm-4.5-air",
      omitTools: true,
      organizing: true,
    })) {
      // 消费完即可
    }

    expect(systemText(captured[0])).not.toContain("先澄清情绪");
    expect(systemText(captured[0])).not.toContain("<专家");
  });

  it("rules.md 被删后该段不再出现", async () => {
    const { chatStream } = await import("../chat/index.js");
    await writeDomain("情感", "先澄清情绪。");
    const session = await createSession("删了规则", dir);
    session.experts = ["情感"];
    await saveSession(session, dir);

    await rm(path.join(dir, "knowledge_base", "情感", "rules.md"));

    for await (const _chunk of chatStream(session.id, "你好", config as never, { provider: "zai", model: "glm-4.5-air" })) {
      // 消费完即可
    }
    expect(systemText(captured[0])).not.toContain("<专家");
  });
});
