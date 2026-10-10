import { readStorage, storageKey, writeStorage } from "./brand.js";

const TOKEN_SUFFIX = "access-token";

export function getAccessToken() {
  return readStorage(TOKEN_SUFFIX) || "";
}

export function setAccessToken(token) {
  const value = String(token || "").trim();
  if (value) writeStorage(TOKEN_SUFFIX, value);
  else localStorage.removeItem(storageKey(TOKEN_SUFFIX));
}

export function authHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchHealth() {
  const response = await fetch("/health");
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

/**
 * If the server requires auth and no token is stored, show a simple gate.
 * Resolves when a token is saved (caller should reload or continue boot).
 */
export function ensureAccessTokenGate(authRequired) {
  if (!authRequired) return Promise.resolve(true);
  if (getAccessToken()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const overlay = document.getElementById("access-token-gate");
    const input = document.getElementById("access-token-input");
    const button = document.getElementById("access-token-save");
    const status = document.getElementById("access-token-status");
    if (!overlay || !input || !button) {
      resolve(false);
      return;
    }
    overlay.classList.add("open");
    input.focus();

    const save = () => {
      const value = input.value.trim();
      if (!value) {
        if (status) status.textContent = "请输入 access token";
        return;
      }
      setAccessToken(value);
      overlay.classList.remove("open");
      resolve(true);
    };

    button.onclick = save;
    input.onkeydown = (event) => {
      if (event.key === "Enter") save();
    };
  });
}
