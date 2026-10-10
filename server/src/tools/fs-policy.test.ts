/**
 * FS policy tests
 */

import { describe, it, expect } from "vitest";
import { assertPathAllowed, ToolError } from "./fs-policy.js";

const allowedDirs = [
  "C:\\Virtual_D\\aiClaw\\inputs",
  "C:\\Virtual_D\\aiClaw\\knowledge_base",
];
const allowedFiles = [
  "C:\\Virtual_D\\aiClaw\\memory.md",
];

describe("assertPathAllowed", () => {
  it("allows path inside allowed dir", () => {
    expect(() =>
      assertPathAllowed("C:\\Virtual_D\\aiClaw\\inputs\\test.txt", allowedDirs, allowedFiles)
    ).not.toThrow();
  });

  it("allows exact match of allowed dir", () => {
    expect(() =>
      assertPathAllowed("C:\\Virtual_D\\aiClaw\\inputs", allowedDirs, allowedFiles)
    ).not.toThrow();
  });

  it("allows exact match of allowed file", () => {
    expect(() =>
      assertPathAllowed("C:\\Virtual_D\\aiClaw\\memory.md", allowedDirs, allowedFiles)
    ).not.toThrow();
  });

  it("blocks path outside all allowed dirs and files", () => {
    expect(() =>
      assertPathAllowed("C:\\Windows\\System32\\secret.txt", allowedDirs, allowedFiles)
    ).toThrow(ToolError);
  });

  it("blocks path traversal attempt", () => {
    expect(() =>
      assertPathAllowed("C:\\Virtual_D\\aiClaw\\inputs\\..\\..\\secret.txt", allowedDirs, allowedFiles)
    ).toThrow(ToolError);
  });

  it("blocks sibling dir that starts with same prefix", () => {
    expect(() =>
      assertPathAllowed("C:\\Virtual_D\\aiClaw\\inputs_extra\\test.txt", allowedDirs, allowedFiles)
    ).toThrow(ToolError);
  });
});
