/**
 * Per-request tenant scope. AsyncLocalStorage so getUserDataDir() follows the
 * active tenant without a process-wide data directory swap.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type TenantScope = {
  id: string;
  /** Absolute tenant data directory (tenants/<id>). */
  base: string;
};

const USER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const storage = new AsyncLocalStorage<TenantScope>();

export function assertUserId(id: string): string {
  if (!USER_ID.test(id)) {
    throw new Error(
      `Invalid user id '${id}'. Use 1-32 characters: lowercase letters, digits, '_' or '-', starting with a letter or digit.`,
    );
  }
  return id;
}

export function currentTenant(): TenantScope | undefined {
  return storage.getStore();
}

export function runWithTenant<T>(tenant: TenantScope, fn: () => T): T {
  return storage.run({ id: assertUserId(tenant.id), base: tenant.base }, fn);
}
