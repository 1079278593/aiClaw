/**
 * `/api/experts` 与 `PATCH /api/sessions/:id` 的 experts 分支（plan_experts §4 阶段 2）。
 *
 * 只断言路由层职责：状态码、白名单、以及「只带 title 的旧请求行为不变」。
 * 装配与限额在 `experts.test.ts` 里覆盖。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithTenant } from "../../tenant/store.js";
import { createSession, loadSession, saveSession } from "../../session/index.js";
import { handleExpertsRoutes } from "./experts.js";
import { handleSessionRoutes } from "./sessions.js";
import type { HttpContext } from "../http-types.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-experts-route-"));
  await mkdir(path.join(base, "knowledge_base"), { recursive: true });
  await mkdir(path.join(base, "conversations"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function fakeContext(method: string, pathname: string, body?: unknown): {
  context: HttpContext;
  captured: () => { status: number; json: unknown };
  broadcasts: () => unknown[];
} {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload, "utf-8")] : []) as unknown as HttpContext["req"];
  Object.assign(req, { method, headers: { "content-type": "application/json" } });

  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader() {},
    end(data?: string) {
      if (data) chunks.push(data);
    },
    set statusCode(value: number) {
      status = value;
    },
    get statusCode() {
      return status;
    },
  } as unknown as HttpContext["res"];

  const sent: unknown[] = [];
  const context = {
    req,
    res,
    url: new URL(`http://localhost${pathname}`),
    config: {} as HttpContext["config"],
    gitSyncEnabled: false,
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as HttpContext["logger"],
    broadcast(message: unknown) {
      sent.push(message);
    },
  } as HttpContext;

  return {
    context,
    captured: () => ({ status, json: chunks.length ? JSON.parse(chunks.join("")) : null }),
    broadcasts: () => sent,
  };
}

describe("GET /api/experts", () => {
  it("只返回有非空 rules.md 的子目录", async () => {
    await mkdir(path.join(base, "knowledge_base", "情感"), { recursive: true });
    await writeFile(path.join(base, "knowledge_base", "情感", "rules.md"), "先澄清情绪。", "utf-8");
    await writeFile(path.join(base, "knowledge_base", "情感", "index.md"), "| 文件 | 说明 |\n", "utf-8");

    // 没有 rules.md 的目录（含安装模板里的「示例」）不算领域。
    await mkdir(path.join(base, "knowledge_base", "示例"), { recursive: true });
    await writeFile(path.join(base, "knowledge_base", "示例", "index.md"), "只有目录", "utf-8");
    // rules.md 为空也不算。
    await mkdir(path.join(base, "knowledge_base", "空"), { recursive: true });
    await writeFile(path.join(base, "knowledge_base", "空", "rules.md"), "   \n", "utf-8");

    const { context, captured } = fakeContext("GET", "/api/experts");
    const handled = await runWithTenant({ id: "t", base }, () => handleExpertsRoutes(context));
    const { status, json } = captured();

    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect((json as { experts: Array<{ id: string; hasIndex: boolean }> }).experts)
      .toEqual([{ id: "情感", hasIndex: true }]);
  });
});

describe("POST /api/experts", () => {
  it("一次建出目录、rules.md 模板与空 index.md", async () => {
    const { context, captured } = fakeContext("POST", "/api/experts", { id: "理财" });
    await runWithTenant({ id: "t", base }, () => handleExpertsRoutes(context));
    const { status } = captured();

    expect(status).toBe(201);
    const rules = await readFile(path.join(base, "knowledge_base", "理财", "rules.md"), "utf-8");
    const index = await readFile(path.join(base, "knowledge_base", "理财", "index.md"), "utf-8");
    // 首段固定：不写清何时读文件，模型会拿目录那一行直接回答。
    expect(rules).toContain("先按下面的目录用 read 打开对应文件");
    expect(index).toContain("| 文件 | 说明 |");
    // 不预置文章行：自动补行会冲掉人写的那一句话。
    expect(index.trim().split("\n").filter((line) => line.startsWith("|") && !line.includes("---"))).toHaveLength(1);
  });

  it("已存在时 409，且不覆盖人改过的 rules.md", async () => {
    await mkdir(path.join(base, "knowledge_base", "情感"), { recursive: true });
    await writeFile(path.join(base, "knowledge_base", "情感", "rules.md"), "我改过的立场", "utf-8");

    const { context, captured } = fakeContext("POST", "/api/experts", { id: "情感" });
    await runWithTenant({ id: "t", base }, () => handleExpertsRoutes(context));

    expect(captured().status).toBe(409);
    expect(await readFile(path.join(base, "knowledge_base", "情感", "rules.md"), "utf-8")).toBe("我改过的立场");
  });

  it("路径段不合法时 400，且不会在 knowledge_base 之外建目录", async () => {
    const { context, captured } = fakeContext("POST", "/api/experts", { id: "../people" });
    await runWithTenant({ id: "t", base }, () => handleExpertsRoutes(context));

    expect(captured().status).toBe(400);
    await expect(readFile(path.join(base, "people", "rules.md"), "utf-8")).rejects.toThrow();
  });

  it("新建后立刻出现在列表里", async () => {
    const create = fakeContext("POST", "/api/experts", { id: "运动" });
    await runWithTenant({ id: "t", base }, () => handleExpertsRoutes(create.context));

    const list = fakeContext("GET", "/api/experts");
    await runWithTenant({ id: "t", base }, () => handleExpertsRoutes(list.context));
    const body = list.captured().json as { experts: Array<{ id: string }> };
    expect(body.experts.map((item) => item.id)).toContain("运动");
  });
});

describe("PATCH /api/sessions/:id", () => {
  it("只带 title 时行为与改动前一致", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("旧标题", base));
    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, { title: "新标题" });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    const { status, json } = captured();
    expect(status).toBe(200);
    expect((json as { session: { title: string } }).session.title).toBe("新标题");
    expect((await loadSession(session.id, base)).experts).toBeUndefined();
  });

  it("experts 写进会话，并广播给其它端", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("勾选", base));
    const { context, captured, broadcasts } = fakeContext("PATCH", `/api/sessions/${session.id}`, {
      experts: ["情感"],
    });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    expect(captured().status).toBe(200);
    expect((await loadSession(session.id, base)).experts).toEqual(["情感"]);
    // 广播的 sessionLoaded 也要带 experts，否则其它端看不到。
    const loaded = broadcasts()[0] as { type: string; session: { experts?: string[] } };
    expect(loaded.type).toBe("sessionLoaded");
    expect(loaded.session.experts).toEqual(["情感"]);
  });

  it("experts: [] 表示清空", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("清空", base));
    session.experts = ["情感", "理财"];
    await saveSession(session, base);

    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, { experts: [] });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    expect(captured().status).toBe(200);
    expect((await loadSession(session.id, base)).experts).toBeUndefined();
  });

  it("超过 2 个时 400，不静默丢掉一个", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("三个", base));
    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, {
      experts: ["情感", "理财", "运动"],
    });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    expect(captured().status).toBe(400);
    expect((await loadSession(session.id, base)).experts).toBeUndefined();
  });

  it("非法领域名 400（挡不住 ../people 就等于把越界检查拖到每一轮）", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("越界", base));
    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, {
      experts: ["../people"],
    });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    expect(captured().status).toBe(400);
    expect((await loadSession(session.id, base)).experts).toBeUndefined();
  });

  it("title 与 experts 都缺时 400", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("空请求", base));
    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, {});
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));
    expect(captured().status).toBe(400);
  });

  it("experts 不是数组时 400", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("类型错", base));
    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, { experts: "情感" });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));
    expect(captured().status).toBe(400);
  });

  it("同时带非法标题与合法 experts 时，不留下半成功", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("同时", base));
    const { context, captured } = fakeContext("PATCH", `/api/sessions/${session.id}`, {
      title: "   ",
      experts: ["情感"],
    });
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    expect(captured().status).toBe(400);
    // 关键：标题非法时 experts 也不能写进去。
    expect((await loadSession(session.id, base)).experts).toBeUndefined();
  });
});

describe("GET /api/sessions/:id 下发白名单", () => {
  it("带上 experts，界面才看得到", async () => {
    const session = await runWithTenant({ id: "t", base }, () => createSession("白名单", base));
    session.experts = ["情感"];
    await saveSession(session, base);

    const { context, captured } = fakeContext("GET", `/api/sessions/${session.id}`);
    await runWithTenant({ id: "t", base }, () => handleSessionRoutes(context));

    const body = captured().json as { session: { experts?: string[] } };
    expect(body.session.experts).toEqual(["情感"]);
  });
});
