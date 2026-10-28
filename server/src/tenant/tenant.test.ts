import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths, getUserDataDir } from "../config/paths.js";
import { setupTestDir, cleanupTestDir } from "../test-utils.js";
import { defaultTenantDir, migrateLegacyInstall } from "./migrate.js";
import { assertUserId, runWithTenant } from "./store.js";

describe("tenant scope", () => {
  let testDir = "";

  afterEach(async () => {
    if (testDir) await cleanupTestDir(testDir);
  });

  it("keeps the install root outside a tenant scope", async () => {
    testDir = await setupTestDir("tenant-scope");
    expect(getUserDataDir()).toBe(testDir);
    const base = defaultTenantDir(testDir);
    runWithTenant({ id: "default", base }, () => {
      expect(getUserDataDir()).toBe(base);
      expect(getPaths().config).toBe(path.join(base, "config.json"));
    });
    expect(getUserDataDir()).toBe(testDir);
  });

  it("rejects path-like user ids", () => {
    expect(() => assertUserId("..")).toThrow(/Invalid user id/);
    expect(() => assertUserId("a/b")).toThrow(/Invalid user id/);
    expect(assertUserId("default")).toBe("default");
  });

  it("moves a legacy install into tenants/default once", async () => {
    testDir = await setupTestDir("tenant-migrate");
    await writeFile(path.join(testDir, "config.json"), "{}\n", "utf-8");
    await mkdir(path.join(testDir, "conversations"), { recursive: true });
    await writeFile(path.join(testDir, "conversations", "s.jsonl"), "{}\n", "utf-8");

    expect(await migrateLegacyInstall(testDir)).toBe("migrated");
    expect(await migrateLegacyInstall(testDir)).toBe("already");

    const dest = defaultTenantDir(testDir);
    expect(await import("node:fs/promises").then((fs) => fs.readFile(path.join(dest, "config.json"), "utf-8"))).toBe("{}\n");
    expect(await import("node:fs/promises").then((fs) => fs.readFile(path.join(dest, "conversations", "s.jsonl"), "utf-8"))).toBe("{}\n");
  });
});
