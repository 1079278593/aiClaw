import { afterEach, describe, expect, it } from "vitest";
import { getInstallRoot } from "../config/paths.js";
import { cleanupTestDir, setupTestDir } from "../test-utils.js";
import { resolveTenantToken } from "./access.js";
import { createUser, loadUsers, revokeUser, rotateUser, tokenMatches, hashToken } from "./users.js";

describe("tenant users", () => {
  let testDir = "";

  afterEach(async () => {
    if (testDir) await cleanupTestDir(testDir);
  });

  it("stores only a hash and resolves the token to that tenant", async () => {
    testDir = await setupTestDir("tenant-users");
    const token = await createUser("ming", "me", testDir);
    const users = await loadUsers(testDir);
    expect(users).toHaveLength(1);
    expect(users[0].tokenHash).toBe(hashToken(token));
    expect(users[0].tokenHash).not.toBe(token);
    expect(tokenMatches(token, users[0].tokenHash)).toBe(true);

    const identity = await resolveTenantToken(token, "", testDir);
    expect(identity?.id).toBe("ming");
    expect(identity?.base.endsWith("/tenants/ming")).toBe(true);

    const rotated = await rotateUser("ming", testDir);
    expect(await resolveTenantToken(token, "", testDir)).toBeNull();
    expect((await resolveTenantToken(rotated, "", testDir))?.id).toBe("ming");

    await revokeUser("ming", testDir);
    expect(await resolveTenantToken(rotated, "", testDir)).toBeNull();
  });

  it("keeps the legacy access token on the default tenant", async () => {
    testDir = await setupTestDir("tenant-legacy-token");
    const identity = await resolveTenantToken("secret", "secret", getInstallRoot());
    expect(identity?.id).toBe("default");
    expect(identity?.base).toBe(testDir);
  });
});
