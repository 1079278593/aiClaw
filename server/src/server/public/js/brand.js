/**
 * Product branding for the browser UI.
 * Keep in sync with src/brand.ts (BRAND_NAME / BRAND_SLUG).
 */
export const BRAND_NAME = "aiClaw";
export const BRAND_SLUG = "aiclaw";

export function storageKey(suffix) {
  return `${BRAND_SLUG}-${suffix}`;
}

export function readStorage(suffix) {
  return localStorage.getItem(storageKey(suffix));
}

export function writeStorage(suffix, value) {
  localStorage.setItem(storageKey(suffix), value);
}
