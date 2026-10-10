import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import dotenv from "dotenv";

import { AuthError, InboxPathError, NotFoundError } from "./errors.js";
import { ChatStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const dataDir = process.env.AICLAW_DATA_DIR;
const token = process.env.INBOX_TOKEN;
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

if (!dataDir) {
  console.error("请设置 AICLAW_DATA_DIR（指向 aiclaw 数据目录）");
  process.exit(1);
}
if (!token || token === "change-me-to-a-long-random-string") {
  console.error("请在 inbox/.env 中设置强随机 INBOX_TOKEN");
  process.exit(1);
}

const store = new ChatStore(dataDir);
const publicDir = path.join(rootDir, "public");

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function assertAuth(req) {
  const header = req.headers.authorization || "";
  const expected = `Bearer ${token}`;
  if (header !== expected) throw new AuthError();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
    /** @type {Record<string, string>} */
    const fields = {};
    /** @type {{ buffer: Buffer, filename: string, mimeType: string } | null} */
    let file = null;

    bb.on("file", (name, stream, info) => {
      if (name !== "file") {
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => reject(new InboxPathError("图片超过 12 MiB 限制")));
      stream.on("end", () => {
        file = {
          buffer: Buffer.concat(chunks),
          filename: info.filename || "image.jpg",
          mimeType: info.mimeType || "application/octet-stream",
        };
      });
    });
    bb.on("field", (name, value) => {
      fields[name] = value;
    });
    bb.on("error", reject);
    bb.on("finish", () => resolve({ fields, file }));
    req.pipe(bb);
  });
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const filePath = path.resolve(publicDir, "." + rel);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json",
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function handleApi(req, res, pathname) {
  assertAuth(req);

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, chats: path.join(dataDir, "inputs", "chats") });
    return;
  }

  if (req.method === "GET" && pathname === "/api/threads") {
    sendJson(res, 200, { threads: await store.listThreads() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/threads") {
    const body = await readJson(req);
    const thread = await store.createThread(body);
    sendJson(res, 201, { thread });
    return;
  }

  const patchMatch = /^\/api\/threads\/([^/]+)$/.exec(pathname);
  if (req.method === "PATCH" && patchMatch) {
    const id = decodeURIComponent(patchMatch[1]);
    const body = await readJson(req);
    const thread = await store.updateThread(id, body);
    sendJson(res, 200, { thread });
    return;
  }

  const messagesMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(pathname);
  if (req.method === "GET" && messagesMatch) {
    const id = decodeURIComponent(messagesMatch[1]);
    const limit = Number(new URL(req.url || "/", "http://localhost").searchParams.get("limit") || 100);
    const result = await store.listMessages(id, { limit });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/entries") {
    const body = await readJson(req);
    const entry = await store.addTextEntry({
      thread: body.thread,
      speaker: body.speaker,
      text: body.text,
    });
    sendJson(res, 201, { entry });
    return;
  }

  if (req.method === "POST" && pathname === "/api/entries/image") {
    const { fields, file } = await parseMultipart(req);
    if (!file?.buffer?.length) throw new InboxPathError("缺少图片文件");
    const entry = await store.addImageEntry({
      thread: fields.thread,
      speaker: fields.speaker,
      buffer: file.buffer,
      originalName: file.filename,
      mimeType: file.mimeType,
    });
    sendJson(res, 201, { entry });
    return;
  }

  sendJson(res, 404, { error: "未知接口" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url.pathname);
      return;
    }
    sendText(res, 405, "Method not allowed");
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || "服务器错误" });
  }
});

await store.ensureRoot();
server.listen(port, host, () => {
  console.log(`aiclaw-inbox listening on http://${host}:${port}`);
  console.log(`data: ${dataDir}`);
  console.log(`chats: ${path.join(dataDir, "inputs", "chats")}`);
});
