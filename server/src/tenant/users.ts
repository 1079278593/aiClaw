/**
 * Tenant access tokens. Only SHA-256 hashes are stored.
 * The plaintext token is shown once, at create or rotate time.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstallRoot } from "../config/paths.js";
import { assertUserId } from "./store.js";

export type UserRecord = {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  disabled: boolean;
};

type UserFile = { users: UserRecord[] };

export function usersFile(installRoot = getInstallRoot()): string {
  return path.join(installRoot, "auth", "users.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, tokenHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  if (actual.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

export async function loadUsers(installRoot = getInstallRoot()): Promise<UserRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(usersFile(installRoot), "utf-8")) as UserFile;
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveUsers(users: UserRecord[], installRoot = getInstallRoot()): Promise<void> {
  const file = usersFile(installRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const body: UserFile = { users };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

export function findActiveUser(users: UserRecord[], token: string): UserRecord | undefined {
  return users.find((user) => !user.disabled && tokenMatches(token, user.tokenHash));
}

export function hasActiveUser(users: UserRecord[]): boolean {
  return users.some((user) => !user.disabled);
}

export async function createUser(id: string, label = "", installRoot = getInstallRoot()): Promise<string> {
  assertUserId(id);
  const users = await loadUsers(installRoot);
  if (users.some((user) => user.id === id && !user.disabled)) {
    throw new Error(`User '${id}' already exists. Use 'user rotate' to replace the token.`);
  }
  const token = randomBytes(32).toString("hex");
  const next = users.filter((user) => user.id !== id);
  next.push({
    id,
    tokenHash: hashToken(token),
    label,
    createdAt: new Date().toISOString(),
    disabled: false,
  });
  await saveUsers(next, installRoot);
  return token;
}

export async function revokeUser(id: string, installRoot = getInstallRoot()): Promise<void> {
  const users = await loadUsers(installRoot);
  const user = users.find((item) => item.id === id && !item.disabled);
  if (!user) throw new Error(`User '${id}' not found.`);
  user.disabled = true;
  await saveUsers(users, installRoot);
}

export async function rotateUser(id: string, installRoot = getInstallRoot()): Promise<string> {
  const users = await loadUsers(installRoot);
  const user = users.find((item) => item.id === id && !item.disabled);
  if (!user) throw new Error(`User '${id}' not found.`);
  const token = randomBytes(32).toString("hex");
  user.tokenHash = hashToken(token);
  await saveUsers(users, installRoot);
  return token;
}
