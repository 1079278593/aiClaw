/**
 * Map a presented access token to a tenant directory.
 * users.json wins. The legacy server.accessToken still opens the default tenant.
 */

import path from "node:path";
import { getInstallRoot, pathExists } from "../config/paths.js";
import { defaultTenantDir } from "./migrate.js";
import { findActiveUser, hasActiveUser, loadUsers } from "./users.js";

export type TenantIdentity = {
  id: string;
  base: string;
};

export async function authIsRequired(legacyToken: string, installRoot = getInstallRoot()): Promise<boolean> {
  if (legacyToken) return true;
  return hasActiveUser(await loadUsers(installRoot));
}

export async function resolveTenantToken(
  token: string | undefined,
  legacyToken: string,
  installRoot = getInstallRoot(),
): Promise<TenantIdentity | null> {
  if (!token) return null;
  const users = await loadUsers(installRoot);
  const user = findActiveUser(users, token);
  if (user) {
    return { id: user.id, base: defaultTenantDir(installRoot, user.id) };
  }
  if (legacyToken && token === legacyToken) {
    return { id: "default", base: await defaultDataDir(installRoot) };
  }
  return null;
}

async function defaultDataDir(installRoot: string): Promise<string> {
  const tenantDir = defaultTenantDir(installRoot, "default");
  if (await pathExists(path.join(tenantDir, "config.json"))) return tenantDir;
  return installRoot;
}
