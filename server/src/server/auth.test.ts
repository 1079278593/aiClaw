import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyCorsHeaders,
  assertServerBindSafe,
  authRequired,
  extractAccessTokenFromUrl,
  extractBearerToken,
  handleCorsPreflight,
  isAuthorizedToken,
  isLoopbackHost,
  requireHttpAuth,
} from "./auth.js";

function mockRes() {
  const headers = new Map<string, string | number | readonly string[]>();
  const res = {
    statusCode: 200,
    setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
      headers.set(key.toLowerCase(), value);
    }),
    end: vi.fn(),
    getHeader: (key: string) => headers.get(key.toLowerCase()),
  };
  return res as unknown as ServerResponse & {
    statusCode: number;
    end: ReturnType<typeof vi.fn>;
    getHeader: (key: string) => string | number | readonly string[] | undefined;
  };
}

describe("auth helpers", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });

  it("requires auth only when accessToken is set", () => {
    expect(authRequired({ accessToken: "" })).toBe(false);
    expect(authRequired({ accessToken: "secret" })).toBe(true);
  });

  it("rejects non-loopback bind without token", () => {
    expect(() => assertServerBindSafe({ host: "0.0.0.0", accessToken: "" })).toThrow(/accessToken/);
    expect(() => assertServerBindSafe({ host: "0.0.0.0", accessToken: "x" })).not.toThrow();
    expect(() => assertServerBindSafe({ host: "127.0.0.1", accessToken: "" })).not.toThrow();
  });

  it("compares tokens", () => {
    expect(isAuthorizedToken(undefined, "")).toBe(true);
    expect(isAuthorizedToken("a", "a")).toBe(true);
    expect(isAuthorizedToken("b", "a")).toBe(false);
    expect(isAuthorizedToken(undefined, "a")).toBe(false);
  });

  it("reads access_token from URL", () => {
    const url = new URL("http://x/ws?access_token=abc");
    expect(extractAccessTokenFromUrl(url)).toBe("abc");
    expect(extractAccessTokenFromUrl(new URL("http://x/ws?token=t"))).toBe("t");
  });

  it("extracts Bearer tokens", () => {
    const req = { headers: { authorization: "Bearer secret" } } as IncomingMessage;
    expect(extractBearerToken(req)).toBe("secret");
    expect(extractBearerToken({ headers: {} } as IncomingMessage)).toBeUndefined();
  });

  it("requireHttpAuth rejects missing/wrong token when configured", () => {
    const resOk = mockRes();
    expect(requireHttpAuth({ headers: {} } as IncomingMessage, resOk, { accessToken: "" })).toBe(true);
    expect(resOk.end).not.toHaveBeenCalled();

    const resDeny = mockRes();
    expect(
      requireHttpAuth({ headers: {} } as IncomingMessage, resDeny, { accessToken: "secret" }),
    ).toBe(false);
    expect(resDeny.statusCode).toBe(401);

    const resAllow = mockRes();
    expect(
      requireHttpAuth(
        { headers: { authorization: "Bearer secret" } } as IncomingMessage,
        resAllow,
        { accessToken: "secret" },
      ),
    ).toBe(true);
  });

  it("applies CORS for allowed origins and preflight", () => {
    const res = mockRes();
    const req = {
      method: "OPTIONS",
      headers: { origin: "https://app.example" },
    } as IncomingMessage;
    applyCorsHeaders(req, res, ["https://app.example"]);
    expect(res.getHeader("access-control-allow-origin")).toBe("https://app.example");
    expect(res.getHeader("access-control-allow-headers")).toEqual(
      expect.stringContaining("Authorization"),
    );

    const preflight = mockRes();
    expect(handleCorsPreflight(req, preflight, ["https://app.example"])).toBe(true);
    expect(preflight.statusCode).toBe(204);
    expect(preflight.end).toHaveBeenCalled();
  });

  it("skips CORS when origin list is empty or origin not allowed", () => {
    const res = mockRes();
    applyCorsHeaders(
      { headers: { origin: "https://evil.example" } } as IncomingMessage,
      res,
      ["https://app.example"],
    );
    expect(res.getHeader("access-control-allow-origin")).toBeUndefined();

    const empty = mockRes();
    expect(
      handleCorsPreflight(
        { method: "OPTIONS", headers: { origin: "https://app.example" } } as IncomingMessage,
        empty,
        [],
      ),
    ).toBe(false);
  });
});
