import { authHeaders } from "./access-token.js";

export async function requestJson(path, init = {}) {
  const headers = new Headers(init.headers || {});
  const auth = authHeaders();
  for (const [key, value] of Object.entries(auth)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  const response = await fetch(path, { ...init, headers });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { response, data };
}

export function jsonRequest(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
