/**
 * `POST /api/pending/apply-all` 的路由契约（plan §12.2）。
 *
 * 这里不启真实服务，直接喂一个假的 req/res 给 handler：要断言的只有路由层
 * 的两件事——**「apply-all」不被当成提案 id**，以及**批量结果原样透出且恒为 200**。
 * 逐条的 apply 语义在 `pending.test.ts` 里已经覆盖。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProposal } from "../../pending/store.js";
import { runWithTenant } from "../../tenant/store.js";
import { handlePendingRoutes } from "./pending.js";
import type { HttpContext } from "../http-types.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-pending-route-"));
  for (const rel of ["reflections/inbox", "knowledge_base/库"]) {
    await mkdir(path.join(base, rel), { recursive: true });
  }
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 造一个够用的假 req/res：只实现 handler 会碰到的部分。 */
function fakeContext(method: string, pathname: string, body?: unknown): {
  context: HttpContext;
  captured: () => { status: number; json: unknown };
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

  const context = {
    req,
    res,
    url: new URL(`http://localhost${pathname}`),
    config: {} as HttpContext["config"],
    gitSyncEnabled: false,
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as HttpContext["logger"],
    broadcast() {},
  } as HttpContext;

  return {
    context,
    captured: () => ({ status, json: chunks.length ? JSON.parse(chunks.join("")) : null }),
  };
}

describe("POST /api/pending/apply-all", () => {
  it("不被当作 id=apply-all 详情请求，且逐条返回结果", async () => {
    await writeFile(path.join(base, "knowledge_base", "库", "甲.md"), "旧\n", "utf-8");
    await createProposal({
      target: "knowledge_base/库/甲.md",
      kind: "doc",
      body: "新\n",
      summary: "改甲",
      userDataDir: base,
    });
    await createProposal({
      target: "knowledge_base/库/乙.md",
      kind: "doc",
      body: "乙\n",
      summary: "新建乙",
      userDataDir: base,
    });

    const { context, captured } = fakeContext("POST", "/api/pending/apply-all", {});
    const handled = await runWithTenant({ id: "t", base }, () => handlePendingRoutes(context));
    const { status, json } = captured();

    expect(handled).toBe(true);
    expect(status).toBe(200);
    const result = json as { items: unknown[]; applied: number; ok: boolean };
    expect(result.items).toHaveLength(2);
    expect(result.applied).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("部分失败仍是 200，用 items 表达（批量非原子）", async () => {
    await writeFile(path.join(base, "knowledge_base", "库", "丙.md"), "原始\n", "utf-8");
    const first = await createProposal({
      target: "knowledge_base/库/丙.md",
      kind: "doc",
      body: "A\n",
      summary: "A",
      userDataDir: base,
    });
    const second = await createProposal({
      target: "knowledge_base/库/丙.md",
      kind: "doc",
      body: "B\n",
      summary: "B",
      userDataDir: base,
    });

    const { context, captured } = fakeContext("POST", "/api/pending/apply-all", {
      ids: [first.id, second.id],
    });
    await runWithTenant({ id: "t", base }, () => handlePendingRoutes(context));
    const { status, json } = captured();

    expect(status).toBe(200);
    const result = json as { items: Array<{ id: string; result: { ok: boolean } }>; applied: number; ok: boolean };
    expect(result.applied).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.items.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("ids 里的非字符串被过滤掉，不会 500", async () => {
    const { context, captured } = fakeContext("POST", "/api/pending/apply-all", {
      ids: [1, null, { a: 1 }, "not-exist"],
    });
    const handled = await runWithTenant({ id: "t", base }, () => handlePendingRoutes(context));
    expect(handled).toBe(true);
    const result = captured().json as { items: Array<{ id: string }> };
    expect(result.items.map((item) => item.id)).toEqual(["not-exist"]);
  });

  it("GET /api/pending/apply-all 不被当成批量应用", async () => {
    const { context, captured } = fakeContext("GET", "/api/pending/apply-all");
    await runWithTenant({ id: "t", base }, () => handlePendingRoutes(context));
    // 落到 id 分支：被视为提案 id "apply-all" 的详情请求 → 404 pending not found。
    expect(captured().status).toBe(404);
  });
});
