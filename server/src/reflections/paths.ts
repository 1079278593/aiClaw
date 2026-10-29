import path from "node:path";
import { getPaths } from "../config/paths.js";

export class ReflectionsError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export const ROOT_REL = "inputs/reflections";

export function reflectionsRoot(userDataDir?: string): string {
  return path.join(getPaths(userDataDir).inputs, "reflections");
}

export function normalizeRel(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function assertUnderRoot(abs: string, root: string): void {
  const resolved = path.resolve(abs);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new ReflectionsError("路径不允许", 400);
  }
}

/** 将用户传入的 path（完整相对或根内相对）解析为绝对路径与规范相对路径。 */
export function resolveReflectionPath(inputPath: string, userDataDir?: string): {
  relativePath: string;
  absolutePath: string;
  root: string;
} {
  const root = reflectionsRoot(userDataDir);
  let rel = normalizeRel(inputPath);
  if (rel === ROOT_REL || rel.startsWith(`${ROOT_REL}/`)) {
    // keep
  } else if (!rel.includes("..")) {
    rel = `${ROOT_REL}/${rel}`;
  } else {
    throw new ReflectionsError("路径不允许", 400);
  }
  if (rel.includes("..")) throw new ReflectionsError("路径不允许", 400);
  const absolutePath = path.resolve(getPaths(userDataDir).base, rel);
  assertUnderRoot(absolutePath, root);
  return { relativePath: normalizeRel(rel), absolutePath, root };
}

export function resolveFolder(folder: string | undefined, userDataDir?: string): {
  relativeFolder: string;
  absoluteFolder: string;
} {
  const raw = normalizeRel(folder || "inbox") || "inbox";
  const withoutRoot = raw === ROOT_REL ? "" : raw.startsWith(`${ROOT_REL}/`) ? raw.slice(ROOT_REL.length + 1) : raw;
  if (withoutRoot.includes("..")) throw new ReflectionsError("路径不允许", 400);
  const relativeFolder = withoutRoot ? `${ROOT_REL}/${withoutRoot}` : ROOT_REL;
  const absoluteFolder = path.resolve(getPaths(userDataDir).base, relativeFolder);
  assertUnderRoot(absoluteFolder, reflectionsRoot(userDataDir));
  return { relativeFolder: normalizeRel(relativeFolder), absoluteFolder };
}
