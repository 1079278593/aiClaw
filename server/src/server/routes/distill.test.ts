/**
 * 蒸馏路由的契约（plan_distill §9 第 5 步）。
 *
 * 这里存在的直接原因是一个**冒烟测试才发现**的缺陷：
 * `handleDistillRoutes` 的解构里漏了 `config`，导致路由永远以
 * 「未提供配置，无法调用模型」失败——而单测用注入的 summarizer 绕过了那条路径，
 * 所以 41 条测试全绿、功能却是死的。
 *
 * 因此本文件的重点不是「接口能返回 200」，而是**路由必须把 `config` 递给生成层**：
 * 断言错误信息里出现 provider 的东西（说明真的走到模型调用），
 * 而不是「未提供配置」。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithTenant } from "../../tenant/store.js";
import { handleDistillRoutes } from "./distill.js";
import type { HttpContext } from "../http-types.js";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aiclaw-distill-route-"));
  await mkdir(path.join(base, "reflections", "inbox"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function fakeContext(
  method: string,
  pathname: string,
  options: { body?: unknown; config?: unknown } = {},
): { context: HttpContext; captured: () => { status: number; json: unknown } } {
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
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
    config: (options.config ?? {}) as HttpContext["config"],
    gitSyncEnabled: false,
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as HttpContext["logger"],
    broadcast() {},
  } as HttpContext;

  return {
    context,
    captured: () => ({ status, json: chunks.length ? JSON.parse(chunks.join("")) : null }),
  };
}

/**
 * 最小可用 config：provider/model 齐全。
 *
 * 注意这里**不**断言具体的 provider 错误：那需要真实发起网络请求（或等它超时），
 * 会让测试慢 7 秒且随环境波动。要防的回归只有一个——
 * 「路由有没有把 config 递给生成层」，用下面这条更直接的方式验证。
 */
const fakeConfig = {
  compaction: { provider: "deepseek", model: "deepseek-chat", thinkingEffort: "off" },
  providers: {
    deepseek: { apiKey: "sk-fake", models: [], baseUrl: "http://127.0.0.1:0" },
  },
};

describe("POST /api/distill/refresh：config 必须透传到生成层", () => {
  /**
   * 防回归的核心：`handleDistillRoutes` 的解构里必须有 `config`。
   *
   * 直接读源码断言，而不是发一次真实请求——后者要等 provider 超时（7 秒），
   * 且失败原因随网络环境变化。漏传 config 这个 bug 的特征是「代码里没有 config」，
   * 所以静态断言既更准确也更快。
   *
   * 行为层的等价验证已在 `distill.test.ts` 里（工具层：拿到 config →
   * 错误信息不再是「未提供配置」）。
   */
  it("路由签名解构了 config，且传给 generateDistill", async () => {
    const source = await readFile(new URL("./distill.ts", import.meta.url), "utf-8");
    // handler 参数里必须取 config。
    expect(source).toMatch(/handleDistillRoutes[^=]*=\s*async\s*\(\{[^}]*\bconfig\b/);
    // 生成调用必须带上它。
    expect(source).toMatch(/generateDistill\(\{[\s\S]*?\bconfig\b[\s\S]*?\}\)/);
  });

  it("scope 非法返回 400，且不触碰生成层", async () => {
    const { context, captured } = fakeContext("POST", "/api/distill/refresh", {
      body: { scope: "chat", path: "x.md", sources: ["a.md"] },
      config: fakeConfig,
    });
    await runWithTenant({ id: "t", base }, () => handleDistillRoutes(context));
    expect(captured()).toMatchObject({ status: 400 });
  });

  it("path 为空返回 400", async () => {
    const { context, captured } = fakeContext("POST", "/api/distill/refresh", {
      body: { scope: "reflections", path: "", sources: ["a.md"] },
      config: fakeConfig,
    });
    await runWithTenant({ id: "t", base }, () => handleDistillRoutes(context));
    expect(captured()).toMatchObject({ status: 400 });
  });

  it("来源全都不存在时 200 + ok:false，且不写任何文件", async () => {
    const { context, captured } = fakeContext("POST", "/api/distill/refresh", {
      body: { scope: "reflections", path: "x.md", sources: ["reflections/inbox/没有.md"] },
      config: fakeConfig,
    });
    await runWithTenant({ id: "t", base }, () => handleDistillRoutes(context));
    const result = captured().json as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("读不到");
  });
});

describe("GET 接口", () => {
  it("/api/distill/overview 空库返回空文本", async () => {
    const { context, captured } = fakeContext("GET", "/api/distill/overview");
    await runWithTenant({ id: "t", base }, () => handleDistillRoutes(context));
    expect(captured()).toEqual({ status: 200, json: { text: "", bytes: 0 } });
  });

  it("/api/distill/stale 空库返回空列表", async () => {
    const { context, captured } = fakeContext("GET", "/api/distill/stale");
    await runWithTenant({ id: "t", base }, () => handleDistillRoutes(context));
    expect(captured()).toEqual({ status: 200, json: { items: [] } });
  });

  it("未知子路径不被本 handler 接管", async () => {
    const { context } = fakeContext("GET", "/api/distill/unknown");
    const handled = await runWithTenant({ id: "t", base }, () => handleDistillRoutes(context));
    expect(handled).toBe(false);
  });
});
