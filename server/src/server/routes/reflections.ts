import {
  ReflectionsError,
  createReflection,
  deleteReflection,
  deleteReflectionFolder,
  importReflections,
  listReflectionTree,
  listReflections,
  mkdirReflection,
  moveReflection,
  organizeReflectionByDate,
  readReflection,
  renameReflectionFolder,
  updateReflection,
} from "../../reflections/store.js";
import {
  deleteReflectionMedia,
  listNoteAssets,
  listOrphanAssets,
  readReflectionMediaFile,
  writeReflectionMedia,
  type CropRect,
} from "../../reflections/media.js";
import { parseReflectionPaste } from "../../reflections/parse.js";
import { readMultipart } from "../form.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

/** `crop=left,top,width,height`，四个都是 0..1 的原图比例。 */
function parseCropField(raw: string): CropRect | undefined {
  if (!raw.trim()) return undefined;
  const parts = raw.split(",").map((item) => Number(item.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return undefined;
  return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] };
}

export const handleReflectionsRoutes: RouteHandler = async ({ req, res, url }) => {
  try {
    if (url.pathname === "/api/reflections" && req.method === "GET") {
      if (url.searchParams.get("view") === "tree") {
        sendJson(res, { tree: await listReflectionTree() });
        return true;
      }
      const items = await listReflections({ q: url.searchParams.get("q") ?? undefined });
      sendJson(res, { reflections: items });
      return true;
    }

    if (url.pathname === "/api/reflections" && req.method === "POST") {
      const body = await readJsonBody<{
        title?: string;
        body?: string;
        occurredAt?: string;
        context?: string;
        folder?: string;
      }>(req);
      sendJson(res, { reflection: await createReflection({
        title: body.title ?? "",
        body: body.body,
        occurredAt: body.occurredAt,
        context: body.context,
        folder: body.folder,
      }) });
      return true;
    }

    if (url.pathname === "/api/reflections" && req.method === "DELETE") {
      const filePath = url.searchParams.get("path") ?? "";
      await deleteReflection(filePath);
      sendJson(res, { ok: true });
      return true;
    }

    if (url.pathname === "/api/reflections/content" && req.method === "GET") {
      const filePath = url.searchParams.get("path") ?? "";
      sendJson(res, { reflection: await readReflection(filePath) });
      return true;
    }

    if (url.pathname === "/api/reflections/content" && req.method === "PUT") {
      const body = await readJsonBody<{
        path?: string;
        title?: string;
        body?: string;
        occurredAt?: string;
        context?: string;
      }>(req);
      sendJson(res, {
        reflection: await updateReflection({
          path: body.path ?? "",
          title: body.title,
          body: body.body,
          occurredAt: body.occurredAt,
          context: body.context,
        }),
      });
      return true;
    }

    if (url.pathname === "/api/reflections/parse" && req.method === "POST") {
      const body = await readJsonBody<{ text?: string }>(req);
      sendJson(res, { items: parseReflectionPaste(body.text ?? "") });
      return true;
    }

    if (url.pathname === "/api/reflections/import" && req.method === "POST") {
      const body = await readJsonBody<{
        text?: string;
        sourcePath?: string;
        folder?: string;
        dryRun?: boolean;
        deleteSource?: boolean;
      }>(req);
      sendJson(res, await importReflections({
        text: body.text,
        sourcePath: body.sourcePath,
        folder: body.folder,
        dryRun: body.dryRun,
        deleteSource: body.deleteSource,
      }));
      return true;
    }

    if (url.pathname === "/api/reflections/mkdir" && req.method === "POST") {
      const body = await readJsonBody<{ folder?: string }>(req);
      sendJson(res, await mkdirReflection(body.folder ?? ""));
      return true;
    }

    if (url.pathname === "/api/reflections/rename-folder" && req.method === "POST") {
      const body = await readJsonBody<{ path?: string; name?: string }>(req);
      sendJson(res, await renameReflectionFolder({ path: body.path ?? "", name: body.name }));
      return true;
    }

    if (url.pathname === "/api/reflections/folder" && req.method === "DELETE") {
      await deleteReflectionFolder(url.searchParams.get("path") ?? "");
      sendJson(res, { ok: true });
      return true;
    }

    if (url.pathname === "/api/reflections/move" && req.method === "POST") {
      const body = await readJsonBody<{ from?: string; toFolder?: string; toPath?: string }>(req);
      sendJson(res, {
        reflection: await moveReflection({
          from: body.from ?? "",
          toFolder: body.toFolder,
          toPath: body.toPath,
        }),
      });
      return true;
    }

    if (url.pathname === "/api/reflections/organize-by-date" && req.method === "POST") {
      const body = await readJsonBody<{ path?: string }>(req);
      sendJson(res, { reflection: await organizeReflectionByDate(body.path ?? "") });
      return true;
    }

    if (url.pathname === "/api/reflections/media" && req.method === "POST") {
      const form = await readMultipart(req);
      const notePath = form.fields.get("path") ?? "";
      const kindRaw = (form.fields.get("kind") || "").trim().toLowerCase();
      const kind = kindRaw === "image" || kindRaw === "audio" ? kindRaw : undefined;
      const transcript = form.fields.get("transcript") ?? "";
      const crop = parseCropField(form.fields.get("crop") || "");
      const file = form.files.find((item) => item.field === "file") || form.files[0];
      if (!file) {
        sendJson(res, { error: "缺少文件" }, 400);
        return true;
      }
      const written = await writeReflectionMedia({
        path: notePath,
        data: file.data,
        filename: file.filename,
        mime: file.mime,
        kind,
        transcript,
        crop,
      });
      sendJson(res, written);
      return true;
    }

    if (url.pathname === "/api/reflections/media" && req.method === "GET") {
      const mediaPath = url.searchParams.get("path") ?? "";
      const file = await readReflectionMediaFile(mediaPath);
      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").some((tag) => tag.trim() === file.etag)) {
        res.statusCode = 304;
        res.setHeader("ETag", file.etag);
        res.end();
        return true;
      }
      res.setHeader("Content-Type", file.mime);
      res.setHeader("ETag", file.etag);
      res.setHeader("Last-Modified", new Date(file.mtimeMs).toUTCString());
      // sidecar 文件名是唯一 id，内容不会原地改，可以长缓存。
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.end(file.data);
      return true;
    }

    if (url.pathname === "/api/reflections/media" && req.method === "DELETE") {
      await deleteReflectionMedia(url.searchParams.get("path") ?? "");
      sendJson(res, { ok: true });
      return true;
    }

    if (url.pathname === "/api/reflections/assets" && req.method === "GET") {
      const notePath = url.searchParams.get("path") ?? "";
      sendJson(res, { assets: await listNoteAssets(notePath) });
      return true;
    }

    if (url.pathname === "/api/reflections/orphans" && req.method === "GET") {
      sendJson(res, { orphans: await listOrphanAssets() });
      return true;
    }
  } catch (error) {
    if (error instanceof ReflectionsError) {
      sendJson(res, { error: error.message }, error.statusCode);
      return true;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, { error: "请求不是 JSON" }, 400);
      return true;
    }
    sendJson(res, { error: (error as Error).message || "请求失败" }, 400);
    return true;
  }

  if (url.pathname === "/api/reflections" || url.pathname.startsWith("/api/reflections/")) return false;
  return false;
};
