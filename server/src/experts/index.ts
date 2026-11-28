/**
 * 领域（专家）注入：`knowledge_base/<领域>/rules.md` + `index.md` → 一个系统块。
 *
 * 设计见 `docs/plan_experts.md` §2 / §3。三条硬约束：
 * 1. **只拼一个块**。预算装配不做块间淘汰，超限只丢这一块，所以规则和目录必须
 *    分开封顶后再合起来：`index.md` 写长了不能连带把同块的规则挤掉。
 * 2. **超限整段不带，绝不截断**。半段立场比没有立场更危险。
 * 3. **路径由服务端拼**。现有知识库目录里用的是 `[文章.md](文章.md)` 这种相对
 *    链接，而 `read` 只认数据根下的完整相对路径；不写前缀，勾选就只剩规则，
 *    正文永远打不开。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import { logger } from "../logger/index.js";
import { estimateTokens } from "../chat/context-budget.js";

/** 整块上限：勾选带来的固定前缀不能无限膨胀（plan §3）。 */
export const EXPERTS_TOKEN_MAX = 2000;

/** 单个 `rules.md` 上限。超了这一段整段不注入（规则和目录都不带）。 */
export const EXPERT_RULES_TOKEN_MAX = 1200;

/** 单个 `index.md` 上限。超了只把目录换成一行提示，规则照常注入。 */
export const EXPERT_INDEX_TOKEN_MAX = 800;

/** 一条会话最多勾几个。接口层拒绝更多，不静默换掉其中一个。 */
export const EXPERTS_MAX = 2;

/** 目录上限：防病态文件名。目录名是中文时 64 字符足够。 */
const EXPERT_ID_MAX_LENGTH = 64;

/**
 * 领域 id 必须是单一路径段。
 *
 * 只检查「目录存在」挡不住 `../people`：拼出来之后的路径会落到别的目录。
 * 控制字符一并拒绝，避免日志与提示词里出现不可见字符。
 */
export function isValidExpertId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (!id.length || id.length > EXPERT_ID_MAX_LENGTH) return false;
  if (id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return false;
  return true;
}

/**
 * 把会话上存的名单收敛成可用的 id 列表。
 *
 * 读路径上也做一次：文件是人可改的，写进去的字段不保证合法。
 * 超过 2 个时取前 2 个——接口层该拒绝，这里只保证不把整轮搞坏。
 */
export function normalizeExpertIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (!isValidExpertId(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= EXPERTS_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 可勾选的领域：`knowledge_base/` 下存在且非空 `rules.md` 的子目录。
 *
 * 判据只看 = `rules.md` 非空。没有它的目录（含安装模板里的「示例」）不出现在
 * 列表里——那些只是知识库，没有自己的立场。`index.md` 可以没有。
 */
export async function listExpertDomains(userDataDir?: string): Promise<Array<{ id: string; hasIndex: boolean }>> {
  const base = knowledgeBaseDir(userDataDir);
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: Array<{ id: string; hasIndex: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidExpertId(entry.name)) continue;
    const dir = path.join(base, entry.name);
    const rules = (await fs.readFile(path.join(dir, "rules.md"), "utf-8").catch(() => "")).trim();
    if (!rules) continue;
    const hasIndex = (await fs.readFile(path.join(dir, "index.md"), "utf-8").catch(() => "")).trim().length > 0;
    out.push({ id: entry.name, hasIndex });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, "zh-CN"));
}

/**
 * `rules.md` 的首段。这句不是客套：不写清何时去读文件，模型会拿目录那一行直接
 * 回答，勾选就只剩「语气」没有「事实」（plan_experts §2）。
 */
export const EXPERT_RULES_TEMPLATE = `涉及具体数字、原话、步骤或这个领域里已经写过的结论时，先按下面的目录用 read 打开对应文件，再回答。目录里的一句话不是正文。

## 立场

（在这里写这个领域的立场。例如情感：先澄清情绪，不急着给建议。）

`;

/** 新建领域时的空目录表。只有表头，不预置行——自动补行会冲掉人写的那一句话。 */
export const EXPERT_INDEX_TEMPLATE = `# 目录

| 文件 | 说明 |
|------|------|

`;

export class ExpertCreateError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ExpertCreateError";
  }
}

/**
 * 新建领域：目录、`rules.md`、`index.md` 一次建好（plan_experts §2.1）。
 *
 * 「只做一次」是硬约束：三者任一已存在就拒绝，不覆盖。人改过的立场不能被模板
 * 盖掉；自动补 `index.md` 的行同理。之后这两个文件只在文档浏览器里改。
 */
export async function createExpertDomain(id: unknown, userDataDir?: string): Promise<{ id: string }> {
  if (!isValidExpertId(id)) throw new ExpertCreateError("领域名不合法：不能为空、不能含 / 或 \\，也不能是 . 或 ..");
  const base = knowledgeBaseDir(userDataDir);
  const dir = path.join(base, id);

  const exists = async (file: string) => fs.access(file).then(() => true).catch(() => false);
  if (await exists(dir)) throw new ExpertCreateError(`领域「${id}」已存在`, 409);
  if (await exists(path.join(dir, "rules.md")) || await exists(path.join(dir, "index.md"))) {
    throw new ExpertCreateError(`领域「${id}」已存在`, 409);
  }

  await fs.mkdir(dir, { recursive: true });
  // wx：再挡一次并发创建。上面两次检查之间可能有人抢先建好。
  try {
    await fs.writeFile(path.join(dir, "rules.md"), EXPERT_RULES_TEMPLATE, { encoding: "utf-8", flag: "wx" });
    await fs.writeFile(path.join(dir, "index.md"), EXPERT_INDEX_TEMPLATE, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ExpertCreateError(`领域「${id}」已存在`, 409);
    }
    throw error;
  }

  logger.info(`expert domain created: ${id}`);
  return { id };
}

export type ExpertDomain = {
  id: string;
  /** 规范化后的目录绝对路径。 */
  dir: string;
  rules: string;
  /** 空串表示没有 `index.md` 或文件为空。 */
  index: string;
  /** 这一段是否真的进了块，以及没进的原因。 */
  skipped?: "no-rules" | "rules-too-large" | "unsafe";
  /** 目录被丢弃时（超限）为 true；`index#text` 此时已换成提示行。 */
  indexDropped?: boolean;
};

export type ExpertsBlock = {
  /** 注入用文本；空串表示这一轮不带领域块。 */
  text: string;
  tokens: number;
  /** 实际进块的领域（按勾选顺序）。 */
  domains: ExpertDomain[];
  /** 整块没进的原因。 */
  skipped?: "no-domains" | "too-large";
};

function knowledgeBaseDir(userDataDir?: string): string {
  return getPaths(userDataDir).knowledgeBase;
}

/**
 * 解析并读取一个领域。目录不存在、`rules.md` 缺失或为空都返回 `skipped`，
 * 由调用方决定「跳过这一段，另一段仍在」。
 */
export async function readExpertDomain(id: string, userDataDir?: string): Promise<ExpertDomain> {
  const base = path.resolve(knowledgeBaseDir(userDataDir));
  const dir = path.resolve(base, id);
  // 纵深防御：即使 isValidExpertId 漏了某类输入，也不许解析到 base 之外。
  if (!isValidExpertId(id) || (dir !== base && !dir.startsWith(base + path.sep))) {
    return { id, dir, rules: "", index: "", skipped: "unsafe" };
  }

  const rules = (await fs.readFile(path.join(dir, "rules.md"), "utf-8").catch(() => "")).trim();
  if (!rules) return { id, dir, rules: "", index: "", skipped: "no-rules" };
  if (estimateTokens(rules) > EXPERT_RULES_TOKEN_MAX) {
    // 规则超限：这一段整段不带，目录也不带。截半段立场会误导行为。
    return { id, dir, rules: "", index: "", skipped: "rules-too-large" };
  }

  const index = (await fs.readFile(path.join(dir, "index.md"), "utf-8").catch(() => "")).trim();
  const domain: ExpertDomain = { id, dir, rules, index };
  if (index && estimateTokens(index) > EXPERT_INDEX_TOKEN_MAX) {
    // 目录超限只丢目录，规则留下——只设整块上限时会把规则一起挤掉。
    domain.indexDropped = true;
  }
  return domain;
}

/**
 * 一个领域的块片段。
 *
 * 首行写明绝对可用的读取路径：`knowledge_base/<id>/<文件名>`。
 * 这一行由服务端拼，不从 `index.md` 里摘（那里的相对链接对 `read` 无效）。
 */
export function formatExpertDomain(domain: ExpertDomain): string {
  const lines: string[] = [];
  lines.push(`<专家 领域="${domain.id}">`);
  lines.push(
    `文章都在 knowledge_base/${domain.id}/ 下。用 read 时路径写成 knowledge_base/${domain.id}/<文件名>，不要用目录里的相对链接。`,
  );
  lines.push("");
  lines.push(domain.rules);
  lines.push("");
  lines.push("目录：");
  if (domain.indexDropped) lines.push("目录超限，未注入");
  else if (domain.index) lines.push(domain.index);
  else lines.push("这个领域没有目录");
  lines.push("</专家>");
  return lines.join("\n");
}

/**
 * 装配整块。按勾选顺序拼接，合计超 `EXPERTS_TOKEN_MAX` 时**整块不带**。
 *
 * 不抛异常：领域目录是用户可改的，读失败只该让这一轮少一块，不该让对话开不起来。
 */
export async function buildExpertsBlock(
  ids: unknown,
  options: { userDataDir?: string } = {},
): Promise<ExpertsBlock> {
  const normalized = normalizeExpertIds(ids) ?? [];
  if (normalized.length === 0) return { text: "", tokens: 0, domains: [], skipped: "no-domains" };

  const read = await Promise.all(normalized.map((id) => readExpertDomain(id, options.userDataDir)));
  const domains = read.filter((domain) => !domain.skipped);
  for (const domain of read) {
    if (!domain.skipped) continue;
    if (domain.skipped === "unsafe") logger.warn(`experts: refused path segment "${domain.id}"`);
    else logger.info(`experts: domain "${domain.id}" not injected (${domain.skipped})`);
  }
  if (domains.length === 0) return { text: "", tokens: 0, domains: [], skipped: "no-domains" };

  const text = domains.map(formatExpertDomain).join("\n\n");
  const tokens = estimateTokens(text);
  if (tokens > EXPERTS_TOKEN_MAX) {
    logger.info("experts: block dropped, too large", { tokens, max: EXPERTS_TOKEN_MAX, ids: domains.map((item) => item.id) });
    return { text: "", tokens: 0, domains: [], skipped: "too-large" };
  }
  return { text, tokens, domains };
}
