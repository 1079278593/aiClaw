import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import type { getLogger } from "../logger/index.js";

const PUBLIC_DIR = join(process.cwd(), "src", "server", "public");
const NODE_MODULES_DIR = join(process.cwd(), "node_modules");
const VENDOR_ASSET_ROOTS = {
  "markdown-it": join(NODE_MODULES_DIR, "markdown-it", "dist"),
  katex: join(NODE_MODULES_DIR, "katex", "dist"),
  lucide: join(NODE_MODULES_DIR, "lucide", "dist"),
} as const;

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function contentType(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function resolveInside(root: string, requestPath: string): string {
  const resolved = resolve(root, requestPath);
  const rel = relative(root, resolved);
  if (!rel || (!rel.startsWith("..") && !rel.includes(":"))) return resolved;
  throw new Error("Static asset not allowed");
}

function resolveVendorAsset(requestPath: string): string {
  const parts = requestPath.replace(/^\/vendor\//, "").split("/").filter(Boolean);
  const packageName = parts.shift();
  if (!packageName || !(packageName in VENDOR_ASSET_ROOTS) || parts.length === 0) throw new Error("Vendor asset not found");
  return resolveInside(VENDOR_ASSET_ROOTS[packageName as keyof typeof VENDOR_ASSET_ROOTS], parts.join("/"));
}

export async function handleStaticRequest(
  pathname: string,
  res: ServerResponse,
  logger: ReturnType<typeof getLogger>,
): Promise<boolean> {
  try {
    let assetPath: string;
    if (pathname.startsWith("/vendor/")) assetPath = resolveVendorAsset(pathname);
    else if (pathname === "/" || pathname === "/index.html") assetPath = join(PUBLIC_DIR, "index.html");
    else if (pathname === "/icon-demo.html") assetPath = join(PUBLIC_DIR, "icon-demo.html");
    else if (pathname.startsWith("/styles/") || pathname.startsWith("/js/")) assetPath = resolveInside(PUBLIC_DIR, pathname.slice(1));
    else return false;

    res.setHeader("Content-Type", contentType(assetPath));
    res.end(await readFile(assetPath));
    return true;
  } catch (error) {
    logger.debug(`Static asset not found: ${pathname} (${(error as Error).message})`);
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }
}
