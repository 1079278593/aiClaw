import {
  ReflectionsError,
  createReflection,
  deleteReflection,
  importReflections,
  listReflectionTree,
  listReflections,
  mkdirReflection,
  moveReflection,
  organizeReflectionByDate,
  readReflection,
  updateReflection,
} from "../../reflections/store.js";
import { parseReflectionPaste } from "../../reflections/parse.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

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
