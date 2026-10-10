import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError, InboxPathError } from "./errors.js";
import { newMessageId } from "./ids.js";
import { getChatsRoot, resolveThreadDir, sanitizeThreadId, timestampSlug } from "./paths.js";

/**
 * Long-term chat storage (v1)
 *
 * inputs/chats/<threadId>/
 *   meta.json          — thread metadata + schemaVersion
 *   messages.jsonl     — append-only source of truth (one JSON object per line)
 *   media/             — binary attachments referenced by relative path
 *   transcript.md      — derived, human-readable mirror (append-synced)
 *
 * Do NOT store one markdown file per utterance — that does not scale.
 */

const SCHEMA_VERSION = 1;
const META_FILE = "meta.json";
const LEGACY_META = "_thread.json";
const MESSAGES_FILE = "messages.jsonl";
const TRANSCRIPT_FILE = "transcript.md";
const MEDIA_DIR = "media";

/**
 * @typedef {{
 *   schemaVersion: number,
 *   id: string,
 *   title: string,
 *   members: string[],
 *   kind: "dm" | "group",
 *   createdAt: string,
 *   updatedAt: string,
 *   messageCount: number,
 * }} ThreadMeta
 */

/**
 * @typedef {{
 *   v: number,
 *   id: string,
 *   ts: string,
 *   speaker: string,
 *   type: "text" | "image",
 *   text?: string,
 *   media?: { path: string, mime: string, bytes: number, originalName?: string },
 * }} ChatMessage
 */

export class ChatStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.chatsRoot = getChatsRoot(dataDir);
  }

  async ensureRoot() {
    await fs.mkdir(this.chatsRoot, { recursive: true });
  }

  async listThreads() {
    await this.ensureRoot();
    const entries = await fs.readdir(this.chatsRoot, { withFileTypes: true });
    const threads = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const meta = await this.ensureMeta(entry.name);
        threads.push(publicMeta(meta));
      } catch {
        // skip unreadable dirs
      }
    }
    threads.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    return threads;
  }

  async createThread({ title, members, kind }) {
    const id = sanitizeThreadId(title);
    const { dir } = resolveThreadDir(this.chatsRoot, id);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(path.join(dir, META_FILE));
      throw new InboxPathError(`会话已存在：${id}`);
    } catch (err) {
      if (err instanceof InboxPathError) throw err;
    }
    try {
      await fs.access(path.join(dir, LEGACY_META));
      throw new InboxPathError(`会话已存在：${id}`);
    } catch (err) {
      if (err instanceof InboxPathError) throw err;
    }

    const now = new Date().toISOString();
    const memberList = normalizeMembers(
      members?.length ? members : kind === "group" ? ["我"] : ["我", id],
    );
    const meta = /** @type {ThreadMeta} */ ({
      schemaVersion: SCHEMA_VERSION,
      id,
      title: id,
      members: memberList,
      kind: kind === "group" ? "group" : "dm",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    });
    await this.writeMeta(dir, meta);
    await fs.writeFile(path.join(dir, MESSAGES_FILE), "", "utf-8");
    await fs.writeFile(
      path.join(dir, TRANSCRIPT_FILE),
      transcriptHeader(meta),
      "utf-8",
    );
    await fs.mkdir(path.join(dir, MEDIA_DIR), { recursive: true });
    return publicMeta(meta);
  }

  async updateThread(threadId, patch) {
    const { meta, dir } = await this.assertThread(threadId);
    const next = {
      ...meta,
      title: patch.title ?? meta.title,
      members: patch.members ? normalizeMembers(patch.members) : meta.members,
      kind: patch.kind === "group" || patch.kind === "dm" ? patch.kind : meta.kind,
      updatedAt: new Date().toISOString(),
    };
    await this.writeMeta(dir, next);
    return publicMeta(next);
  }

  async addTextEntry({ thread, speaker, text }) {
    const body = String(text ?? "").trim();
    if (!body) throw new InboxPathError("正文不能为空");
    const who = requireSpeaker(speaker);
    const { id, dir, meta } = await this.assertThread(thread);
    await this.ensureSpeaker(dir, meta, who);

    /** @type {ChatMessage} */
    const message = {
      v: SCHEMA_VERSION,
      id: newMessageId(),
      ts: new Date().toISOString(),
      speaker: who,
      type: "text",
      text: body,
    };
    await this.appendMessage(dir, meta, message);
    return {
      thread: id,
      message,
      path: `inputs/chats/${id}/${MESSAGES_FILE}`,
    };
  }

  async addImageEntry({ thread, speaker, buffer, originalName, mimeType }) {
    const who = requireSpeaker(speaker);
    if (!buffer?.length) throw new InboxPathError("缺少图片文件");
    const { id, dir, meta } = await this.assertThread(thread);
    await this.ensureSpeaker(dir, meta, who);

    const ext = extFromUpload(originalName, mimeType);
    const mediaName = `${timestampSlug()}_${newMessageId().slice(-8)}${ext}`;
    const relMedia = `${MEDIA_DIR}/${mediaName}`;
    await fs.mkdir(path.join(dir, MEDIA_DIR), { recursive: true });
    await fs.writeFile(path.join(dir, relMedia), buffer);

    /** @type {ChatMessage} */
    const message = {
      v: SCHEMA_VERSION,
      id: newMessageId(),
      ts: new Date().toISOString(),
      speaker: who,
      type: "image",
      text: originalName ? String(originalName) : undefined,
      media: {
        path: relMedia,
        mime: mimeType || "application/octet-stream",
        bytes: buffer.length,
        originalName: originalName || undefined,
      },
    };
    await this.appendMessage(dir, meta, message);
    return {
      thread: id,
      message,
      path: `inputs/chats/${id}/${relMedia}`,
    };
  }

  /** Recent messages, newest last (chronological). */
  async listMessages(threadId, { limit = 100 } = {}) {
    const { id, dir } = await this.assertThread(threadId);
    const raw = await fs.readFile(path.join(dir, MESSAGES_FILE), "utf-8").catch(() => "");
    const lines = raw.split("\n").filter((l) => l.trim());
    const sliced = limit > 0 ? lines.slice(-limit) : lines;
    const messages = [];
    for (const line of sliced) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // skip corrupt line
      }
    }
    return { thread: id, messages };
  }

  async assertThread(threadId) {
    const { id, dir } = resolveThreadDir(this.chatsRoot, threadId);
    try {
      await fs.access(dir);
    } catch {
      throw new NotFoundError(`会话不存在：${id}`);
    }
    const meta = await this.ensureMeta(id);
    return { id, dir, meta };
  }

  async ensureMeta(threadId) {
    const { id, dir } = resolveThreadDir(this.chatsRoot, threadId);
    const metaPath = path.join(dir, META_FILE);
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      const parsed = JSON.parse(raw);
      return normalizeMeta(id, parsed);
    } catch {
      // legacy _thread.json
      try {
        const legacy = JSON.parse(await fs.readFile(path.join(dir, LEGACY_META), "utf-8"));
        const meta = normalizeMeta(id, legacy);
        await this.writeMeta(dir, meta);
        await fs.mkdir(path.join(dir, MEDIA_DIR), { recursive: true });
        try {
          await fs.access(path.join(dir, MESSAGES_FILE));
        } catch {
          await fs.writeFile(path.join(dir, MESSAGES_FILE), "", "utf-8");
        }
        try {
          await fs.access(path.join(dir, TRANSCRIPT_FILE));
        } catch {
          await fs.writeFile(path.join(dir, TRANSCRIPT_FILE), transcriptHeader(meta), "utf-8");
        }
        return meta;
      } catch {
        const now = new Date().toISOString();
        const meta = normalizeMeta(id, {
          title: id,
          members: ["我", id],
          kind: "dm",
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
        });
        await this.writeMeta(dir, meta);
        await fs.mkdir(path.join(dir, MEDIA_DIR), { recursive: true });
        await fs.writeFile(path.join(dir, MESSAGES_FILE), "", "utf-8");
        await fs.writeFile(path.join(dir, TRANSCRIPT_FILE), transcriptHeader(meta), "utf-8");
        return meta;
      }
    }
  }

  async writeMeta(dir, meta) {
    const payload = normalizeMeta(meta.id, meta);
    await fs.writeFile(path.join(dir, META_FILE), JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }

  async ensureSpeaker(dir, meta, speaker) {
    if (meta.members.includes(speaker)) return;
    meta.members = normalizeMembers([...meta.members, speaker]);
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(dir, meta);
  }

  /**
   * @param {string} dir
   * @param {ThreadMeta} meta
   * @param {ChatMessage} message
   */
  async appendMessage(dir, meta, message) {
    const line = JSON.stringify(message) + "\n";
    await fs.appendFile(path.join(dir, MESSAGES_FILE), line, "utf-8");
    await fs.appendFile(path.join(dir, TRANSCRIPT_FILE), formatTranscriptBlock(message), "utf-8");
    meta.messageCount = (meta.messageCount || 0) + 1;
    meta.updatedAt = message.ts;
    await this.writeMeta(dir, meta);
  }
}

function publicMeta(meta) {
  return {
    id: meta.id,
    title: meta.title,
    members: meta.members,
    kind: meta.kind,
    schemaVersion: meta.schemaVersion,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount ?? 0,
  };
}

function normalizeMeta(id, raw) {
  return {
    schemaVersion: Number(raw.schemaVersion) || SCHEMA_VERSION,
    id,
    title: String(raw.title || id),
    members: normalizeMembers(raw.members || ["我"]),
    kind: raw.kind === "group" ? "group" : "dm",
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    messageCount: Number(raw.messageCount) || 0,
  };
}

function normalizeMembers(members) {
  const list = (Array.isArray(members) ? members : [])
    .map((m) => String(m).trim())
    .filter(Boolean);
  if (!list.includes("我")) list.unshift("我");
  return [...new Set(list)];
}

function requireSpeaker(speaker) {
  const who = String(speaker ?? "").trim();
  if (!who) throw new InboxPathError("说话人不能为空");
  return who;
}

function transcriptHeader(meta) {
  return (
    `# ${meta.title}\n\n` +
    `- kind: ${meta.kind}\n` +
    `- members: ${meta.members.join(", ")}\n` +
    `- schemaVersion: ${meta.schemaVersion}\n\n` +
    `<!-- append-only human mirror of messages.jsonl; do not hand-edit if syncing -->\n\n`
  );
}

/** @param {ChatMessage} message */
function formatTranscriptBlock(message) {
  const local = formatLocalTime(message.ts);
  if (message.type === "image") {
    const rel = message.media?.path || "";
    return `### ${local} · ${message.speaker}\n\n![image](${rel})\n\n`;
  }
  const text = message.text || "";
  return `### ${local} · ${message.speaker}\n\n${text}\n\n`;
}

function formatLocalTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function extFromUpload(name, mime) {
  const fromName = path.extname(name || "").toLowerCase();
  if (fromName && fromName.length <= 8) return fromName;
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
  };
  return map[mime] || ".jpg";
}
