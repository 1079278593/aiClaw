import type { ProviderName } from "../../config/index.js";
import { getProviderCredential } from "../../config/index.js";
import { createProvider } from "../../llm/index.js";
import { normalizeImageBuffer } from "../../media/image.js";
import { PeopleError, appendEntry, createPerson, deleteEntry, deletePerson, getPersonRecord, lastEntryPreview, listPeople, pageEntries, patchEntry, readEntries, updatePersonNames } from "../../people/store.js";
import { parseRecognition, RECOGNIZE_PROMPT } from "../../people/recognize.js";
import { readMultipart } from "../form.js";
import type { RouteHandler } from "../http-types.js";
import { readJsonBody, sendJson } from "../http-types.js";

const MAX_IMAGES = 20;

export const handlePeopleRoutes: RouteHandler = async ({ req, res, url, config }) => {
  const entryMatch = /^\/api\/people\/([A-Za-z0-9]+)\/entries\/([A-Za-z0-9]+)$/.exec(url.pathname);
  const entriesMatch = /^\/api\/people\/([A-Za-z0-9]+)\/entries$/.exec(url.pathname);
  const recognizeMatch = /^\/api\/people\/([A-Za-z0-9]+)\/recognize$/.exec(url.pathname);
  const personMatch = /^\/api\/people\/([A-Za-z0-9]+)$/.exec(url.pathname);

  try {
    if (url.pathname === "/api/people" && req.method === "GET") {
      const sort = url.searchParams.get("sort") === "name" ? "name" : "recent";
      const people = await listPeople();
      const listed = await Promise.all(people.map(async (person) => ({
        ...person,
        preview: lastEntryPreview(await readEntries(person.id)),
      })));
      listed.sort((a, b) => sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN")
        : b.updatedAt.localeCompare(a.updatedAt));
      sendJson(res, { people: listed });
      return true;
    }

    if (url.pathname === "/api/people" && req.method === "POST") {
      const body = await readJsonBody<{ name?: string }>(req);
      sendJson(res, await createPerson(body.name ?? ""));
      return true;
    }

    if (personMatch && req.method === "GET") {
      sendJson(res, await getPersonRecord(personMatch[1]));
      return true;
    }

    if (personMatch && req.method === "PATCH") {
      const body = await readJsonBody<{ name?: string; nicknames?: string[]; shortNames?: string[] }>(req);
      sendJson(res, { person: await updatePersonNames(personMatch[1], body) });
      return true;
    }

    if (personMatch && req.method === "DELETE") {
      await deletePerson(personMatch[1]);
      sendJson(res, { ok: true });
      return true;
    }

    if (entriesMatch && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const page = pageEntries(await readEntries(entriesMatch[1]), url.searchParams.get("before") ?? undefined, Number.isFinite(limit) && limit > 0 ? limit : 50);
      sendJson(res, page);
      return true;
    }

    if (entriesMatch && req.method === "POST") {
      const body = await readJsonBody<{ kind?: "line" | "note"; speaker?: "me" | "them"; text?: string }>(req);
      sendJson(res, await appendEntry(entriesMatch[1], { kind: body.kind ?? "line", speaker: body.speaker, text: body.text ?? "" }));
      return true;
    }

    if (entryMatch && req.method === "PATCH") {
      const body = await readJsonBody<{ text?: string; speaker?: "me" | "them" }>(req);
      sendJson(res, { entry: await patchEntry(entryMatch[1], entryMatch[2], body) });
      return true;
    }

    if (entryMatch && req.method === "DELETE") {
      await deleteEntry(entryMatch[1], entryMatch[2]);
      sendJson(res, { ok: true });
      return true;
    }

    if (recognizeMatch && req.method === "POST") {
      sendJson(res, await recognizeImages(recognizeMatch[1], req, config));
      return true;
    }
  } catch (error) {
    if (error instanceof PeopleError) {
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

  if (url.pathname === "/api/people" || url.pathname.startsWith("/api/people/")) return false;
  return false;
};

async function recognizeImages(
  personId: string,
  req: import("node:http").IncomingMessage,
  config: import("../../config/index.js").Config,
) {
  await getPersonRecord(personId);
  const form = await readMultipart(req);
  const provider = form.fields.get("provider") as ProviderName | undefined;
  const model = form.fields.get("model") ?? "";
  if (!provider || !model) throw new PeopleError("缺少模型", 400);
  const modal = config.providers[provider]?.models.find((item) => item.id === model)?.modal ?? "l";
  if (modal !== "vl") throw new PeopleError("请切换到视觉模型后再识别", 400);
  const images = form.files.filter((file) => file.field === "images");
  if (images.length === 0) throw new PeopleError("没有图片", 400);
  if (images.length > MAX_IMAGES) throw new PeopleError("一次最多 20 张", 400);

  const credential = getProviderCredential(config, provider);
  const llm = createProvider(provider);
  const results: Array<{ ok: true; entries: Awaited<ReturnType<typeof appendEntry>>["entry"][] } | { ok: false; error: string }> = [];
  for (const image of images) {
    try {
      const normalized = await normalizeImageBuffer(image.data);
      const dataUrl = `data:${normalized.mimeType};base64,${normalized.buffer.toString("base64")}`;
      const response = await llm.complete(credential.apiKey, [{
        id: "recognize",
        role: "user",
        content: [
          { type: "text", text: RECOGNIZE_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
        timestamp: new Date().toISOString(),
      }], {
        model,
        baseUrl: credential.baseUrl,
        maxTokens: 2000,
        responseFormat: { type: "json_object" },
      });
      const parsed = parseRecognition(response.content ?? "");
      if ("error" in parsed) {
        results.push({ ok: false, error: parsed.error === "group" ? "这是群聊，不能放进个人对话" : "识别失败" });
        continue;
      }
      const entries = [];
      for (const line of parsed.lines) {
        const saved = await appendEntry(personId, { kind: "line", speaker: line.speaker, text: line.text });
        entries.push(saved.entry);
      }
      results.push({ ok: true, entries });
    } catch {
      results.push({ ok: false, error: "识别失败" });
    }
  }
  return { person: (await getPersonRecord(personId)).person, results };
}
