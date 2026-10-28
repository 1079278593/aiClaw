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

async function tokenMatchesAccount(token) {
  const response = await fetch("/api/config", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error("无法连接服务器");
  return true;
}

/**
 * When auth is required, stay on the token page until /api/config accepts the token.
 * A stored token is checked the same way. An unknown token is not saved.
 */
export function ensureAccessTokenGate(authRequired) {
  if (!authRequired) return Promise.resolve(true);

  return new Promise((resolve) => {
    const overlay = document.getElementById("access-token-gate");
    const input = document.getElementById("access-token-input");
    const button = document.getElementById("access-token-save");
    const status = document.getElementById("access-token-status");
    if (!overlay || !input || !button) {
      resolve(false);
      return;
    }

    const showStatus = (text) => {
      if (status) status.textContent = text;
    };

    const openGate = (message) => {
      overlay.classList.add("open");
      showStatus(message);
      input.focus();
    };

    const save = async () => {
      const value = input.value.trim();
      if (!value) {
        showStatus("请输入 access token");
        return;
      }
      button.disabled = true;
      showStatus("正在验证…");
      try {
        const matched = await tokenMatchesAccount(value);
        if (!matched) {
          setAccessToken("");
          showStatus("没有匹配的账号");
          return;
        }
        setAccessToken(value);
        overlay.classList.remove("open");
        resolve(true);
      } catch (error) {
        showStatus(error.message || "无法连接服务器");
      } finally {
        button.disabled = false;
      }
    };

    button.onclick = () => { void save(); };
    input.onkeydown = (event) => {
      if (event.key === "Enter") void save();
    };

    const saved = getAccessToken();
    if (!saved) {
      openGate("");
      return;
    }
    void tokenMatchesAccount(saved).then((matched) => {
      if (matched) {
        resolve(true);
        return;
      }
      setAccessToken("");
      openGate("没有匹配的账号");
    }).catch((error) => {
      openGate(error.message || "无法连接服务器");
    });
  });
}
