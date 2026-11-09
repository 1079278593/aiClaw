/**
 * `GET / PUT /api/context/sources` 的路由契约。
 *
 * 只断言路由层的职责：参数校验、错误码、以及「部分失败也要带最新统计」。
 * 清单计算与写盘语义在 `sources.test.ts` 里覆盖，不在这里重复。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithTenant } from "../../tenant/store.js";
import { handleContextRoutes } from "./context.js";
import type { HttpContext } from "../http-types.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-context-route-"));
  await mkdir(path.join(base, "agents", "main", "memory"), { recursive: true });
  await mkdir(path.join(base, "reflections"), { recursive: true });
  await mkdir(path.join(base, "distill", "meta"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

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
    // 只放路由会用到的开关字段，其余按配置形状不参与断言。
    config: { injectRootIndex: false, injectDistillMap: false } as HttpContext["config"],
    gitSyncEnabled: false,
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as HttpContext["logger"],
    broadcast() {},
  } as HttpContext;

  return {
    context,
    captured: () => ({ status, json: chunks.length ? JSON.parse(chunks.join("")) : null }),
  };
}

describe("/api/context/sources", () => {
  it("GET 返回各来源与合计", async () => {
    await writeFile(path.join(base, "agents", "main", "AGENT.md"), "宪法", "utf-8");
    const { context, captured } = fakeContext("GET", "/api/context/sources");
    const handled = await runWithTenant({ id: "t", base }, () => handleContextRoutes(context));
    const { status, json } = captured();

    expect(handled).toBe(true);
    expect(status).toBe(200);
    const body = json as { sources: Array<{ id: string }>; totalTokens: number };
    expect(body.sources.some((item) => item.id === "constitution")).toBe(true);
    expect(body.totalTokens).toBeGreaterThan(0);
  });

  it("不匹配的路径交还给后续路由", async () => {
    const { context } = fakeContext("GET", "/api/other");
    const handled = await handleContextRoutes(context);
    expect(handled).toBe(false);
  });

  it("PUT 缺少 updates 数组时返回 400", async () => {
    const { context, captured } = fakeContext("PUT", "/api/context/sources", {});
    await runWithTenant({ id: "t", base }, () => handleContextRoutes(context));
    expect(captured().status).toBe(400);
  });

  it("PUT 空数组时返回 400（避免假装成功）", async () => {
    const { context, captured } = fakeContext("PUT", "/api/context/sources", { updates: [] });
    await runWithTenant({ id: "t", base }, () => handleContextRoutes(context));
    const { status, json } = captured();
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain("没有需要保存");
  });

  it("PUT 成功时落盘并返回最新 overview", async () => {
    const { context, captured } = fakeContext("PUT", "/api/context/sources", {
      updates: [{ id: "constitution", content: "新宪法内容" }],
    });
    await runWithTenant({ id: "t", base }, () => handleContextRoutes(context));
    const { status, json } = captured();

    expect(status).toBe(200);
    const body = json as { saved: string[]; overview: { sources: Array<{ id: string; content: string }> } };
    expect(body.saved).toEqual(["constitution"]);
    const constitution = body.overview.sources.find((item) => item.id === "constitution");
    expect(constitution?.content).toBe("新宪法内容");
  });

  it("部分失败返回 400，但仍带已保存列表与最新统计", async () => {
    const { context, captured } = fakeContext("PUT", "/api/context/sources", {
      updates: [
        { id: "constitution", content: "新宪法" },
        { id: "rootIndex", content: "不允许改" },
      ],
    });
    await runWithTenant({ id: "t", base }, () => handleContextRoutes(context));
    const { status, json } = captured();

    expect(status).toBe(400);
    const body = json as {
      saved: string[];
      failed: Array<{ id: string }>;
      overview: { sources: unknown[] } | null;
    };
    expect(body.saved).toEqual(["constitution"]);
    expect(body.failed[0].id).toBe("rootIndex");
    // 关键：失败也要回传统计，否则前端只能整页重拉。
    expect(body.overview?.sources.length).toBeGreaterThan(0);
  });

  it("PUT 的方法之外的动词返回 405", async () => {
    const { context, captured } = fakeContext("DELETE", "/api/context/sources");
    await runWithTenant({ id: "t", base }, () => handleContextRoutes(context));
    expect(captured().status).toBe(405);
  });
});
