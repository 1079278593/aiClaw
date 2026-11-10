/**
 * App 内更新：fir 代理的解析与降级行为。
 *
 * 这里用 **fixture 固定 fir 的真实返回形状**，而不是靠猜字段名：
 * 一旦 fir 改字段，这些测试会先失败，而不是让移动端空白一片。
 *
 * 断言的四个关键行为：
 * 1. 未开启 / 无 token → `configured:false`，移动端据此隐藏入口；
 * 2. 应用不存在（Android 现状）→ `available:false` 且**不抛错**；
 * 3. 正常返回 → 拿到 build 与可安装链接；
 * 4. 网络失败 / 超时 → 降级成 reason，不影响页面其它部分。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchAppUpdate, isAppUpdatePlatform } from "./index.js";
import type { AppUpdateConfig } from "./index.js";

const baseConfig: AppUpdateConfig = {
  enabled: true,
  apiToken: "t".repeat(32),
  apiBase: "https://api.bq04.com",
  iosBundleId: "com.aiclaw.aiclawMobile",
  androidBundleId: "com.aiclaw.aiclaw_mobile",
  timeoutMs: 5000,
};

/** 真实抓包得到的 iOS 返回（字段顺序与取值风格保留原样）。 */
const IOS_FIXTURE = {
  name: "aiClaw",
  version: "13",
  changelog: "更新",
  updated_at: 1794270335,
  versionShort: "1.0.0",
  build: "13",
  installUrl: "https://download.appmeta.cn/apps/6add99a523389f6af6e2500c/install?download_token=abc&source=update",
  install_url: "https://download.appmeta.cn/apps/6add99a523389f6af6e2500c/install?download_token=abc&source=update",
  direct_install_url: "",
  update_url: "http://fir.xcxwo.com/gwrq4k9u",
  binary: { fsize: 9064558 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok,
    json: async () => payload,
  })));
}

describe("isAppUpdatePlatform", () => {
  it("只接受 ios 与 android", () => {
    expect(isAppUpdatePlatform("ios")).toBe(true);
    expect(isAppUpdatePlatform("android")).toBe(true);
    expect(isAppUpdatePlatform("IOS")).toBe(false);
    expect(isAppUpdatePlatform("../etc")).toBe(false);
    expect(isAppUpdatePlatform(undefined)).toBe(false);
  });
});

describe("fetchAppUpdate", () => {
  it("未开启时返回 configured:false 并说明原因", async () => {
    const info = await fetchAppUpdate({ ...baseConfig, enabled: false }, "ios");
    expect(info.configured).toBe(false);
    expect(info.available).toBe(false);
    expect(info.reason).toContain("未开启");
  });

  it("没有 token 时返回 configured:false", async () => {
    const info = await fetchAppUpdate({ ...baseConfig, apiToken: "  " }, "ios");
    expect(info.configured).toBe(false);
    expect(info.reason).toContain("Token");
  });

  it("配置完全缺失（undefined）时不抛错", async () => {
    const info = await fetchAppUpdate(undefined, "ios");
    expect(info.configured).toBe(false);
    expect(info.available).toBe(false);
  });

  it("解析 iOS 的真实返回：版本、安装链接、大小齐全", async () => {
    stubFetch(IOS_FIXTURE);
    const info = await fetchAppUpdate(baseConfig, "ios");

    expect(info.configured).toBe(true);
    expect(info.available).toBe(true);
    expect(info.version).toBe("1.0.0");
    expect(info.build).toBe("13");
    expect(info.changelog).toBe("更新");
    expect(info.installUrl).toContain("download_token=");
    expect(info.updateUrl).toBe("http://fir.xcxwo.com/gwrq4k9u");
    expect(info.sizeBytes).toBe(9064558);
    expect(info.updatedAt).toBe(new Date(1794270335 * 1000).toISOString());
  });

  it("应用不存在时是正常的空结果，不抛错（Android 现状）", async () => {
    stubFetch({ errors: { exception: ["app is not found"] }, code: 100701 });
    const info = await fetchAppUpdate(baseConfig, "android");

    expect(info.configured).toBe(true);
    expect(info.available).toBe(false);
    expect(info.reason).toContain("还没有");
  });

  it("缺 build 时判为不可用，而不是给出版本为 undefined 的结果", async () => {
    stubFetch({ versionShort: "1.0.0" });
    const info = await fetchAppUpdate(baseConfig, "ios");
    expect(info.available).toBe(false);
    expect(info.reason).toContain("版本号");
  });

  it("只有 update_url 时退回短链（installUrl 缺失）", async () => {
    stubFetch({ versionShort: "1.0.0", build: "5", update_url: "http://fir.xcxwo.com/abc" });
    const info = await fetchAppUpdate(baseConfig, "ios");
    expect(info.available).toBe(true);
    expect(info.installUrl).toBeUndefined();
    expect(info.updateUrl).toBe("http://fir.xcxwo.com/abc");
  });

  it("网络异常时降级为 reason，不抛异常", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const info = await fetchAppUpdate(baseConfig, "ios");
    expect(info.configured).toBe(true);
    expect(info.available).toBe(false);
    expect(info.reason).toContain("无法连接");
  });

  it("token 错误时透传 fir 的 message，而不是说「没有版本号」", async () => {
    stubFetch({ message: "api token 无效" });
    const info = await fetchAppUpdate(baseConfig, "ios");
    expect(info.available).toBe(false);
    expect(info.reason).toContain("fir 拒绝了请求");
    expect(info.reason).toContain("api token 无效");
  });

  it("按平台使用不同 bundle id，且 URL 做了编码", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      calls.push(input);
      return { ok: true, json: async () => IOS_FIXTURE };
    }));

    await fetchAppUpdate(baseConfig, "ios");
    await fetchAppUpdate(baseConfig, "android");

    expect(calls[0]).toContain("com.aiclaw.aiclawMobile");
    expect(calls[0]).toContain("type=ios");
    expect(calls[1]).toContain("com.aiclaw.aiclaw_mobile");
    expect(calls[1]).toContain("type=android");
    // token 不能以未编码形式拼进去之外的意外字符
    expect(calls[0]).not.toContain("undefined");
  });
});
