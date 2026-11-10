/**
 * `GET /api/app/update` 的路由契约。
 *
 * 重点只有两条：`platform` 白名单不能被绕过（它参与拼 URL），
 * 以及「查不到」必须返回 200 —— 未配置/未上传都是正常状态，
 * 用 4xx/5xx 会让移动端把「还没发包」显示成故障。
 */

import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAppUpdateRoutes } from "./app-update.js";
import type { HttpContext } from "../http-types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeContext(method: string, pathname: string, appUpdate?: unknown): {
  context: HttpContext;
  captured: () => { status: number; json: unknown };
} {
  const req = Readable.from([]) as unknown as HttpContext["req"];
  Object.assign(req, { method, headers: {} });

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
    config: { appUpdate } as HttpContext["config"],
    gitSyncEnabled: false,
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as HttpContext["logger"],
    broadcast() {},
  } as HttpContext;

  return {
    context,
    captured: () => ({ status, json: chunks.length ? JSON.parse(chunks.join("")) : null }),
  };
}

const enabled = {
  enabled: true,
  apiToken: "t".repeat(32),
  apiBase: "https://api.bq04.com",
  iosBundleId: "com.aiclaw.aiclawMobile",
  androidBundleId: "com.aiclaw.aiclaw_mobile",
  timeoutMs: 3000,
};

describe("/api/app/update", () => {
  it("不匹配的路径交还给后续路由", async () => {
    const { context } = fakeContext("GET", "/api/other");
    expect(await handleAppUpdateRoutes(context)).toBe(false);
  });

  it("拒绝非法 platform（白名单，防拼进 URL）", async () => {
    const { context, captured } = fakeContext("GET", "/api/app/update?platform=../../secret");
    await handleAppUpdateRoutes(context);
    const { status, json } = captured();
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain("platform");
  });

  it("非 GET 返回 405", async () => {
    const { context, captured } = fakeContext("POST", "/api/app/update");
    await handleAppUpdateRoutes(context);
    expect(captured().status).toBe(405);
  });

  it("未配置 appUpdate 时返回 200 且 configured:false", async () => {
    const { context, captured } = fakeContext("GET", "/api/app/update?platform=ios", undefined);
    await handleAppUpdateRoutes(context);
    const { status, json } = captured();

    // 关键：不是 500。移动端要据此隐藏入口，而不是报错。
    expect(status).toBe(200);
    const body = json as { configured: boolean; available: boolean };
    expect(body.configured).toBe(false);
    expect(body.available).toBe(false);
  });

  it("默认 platform 为 ios", async () => {
    const { context, captured } = fakeContext("GET", "/api/app/update", enabled);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ versionShort: "1.0.0", build: "13", installUrl: "https://x/y" }),
    })));
    await handleAppUpdateRoutes(context);
    const body = captured().json as { platform: string; available: boolean };
    expect(body.platform).toBe("ios");
    expect(body.available).toBe(true);
  });

  it("Android 应用不存在时仍是 200 + available:false", async () => {
    const { context, captured } = fakeContext("GET", "/api/app/update?platform=android", enabled);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ errors: { exception: ["app is not found"] }, code: 100701 }),
    })));
    await handleAppUpdateRoutes(context);
    const { status, json } = captured();
    expect(status).toBe(200);
    expect((json as { available: boolean }).available).toBe(false);
  });
});
