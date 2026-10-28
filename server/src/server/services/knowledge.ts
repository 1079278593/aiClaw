import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getPaths } from "../../config/paths.js";

export type KnowledgeBaseSummary = {
  name: string;
  description: string;
  files: string[];
};

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|")
    ? trimmed.slice(1, -1).split("|").map((cell) => cell.trim())
    : [];
}

function normalizeKnowledgeBaseName(value: string): string {
  const link = /^\[([^\]]+)\]\([^)]+\)$/.exec(value.trim());
  return link ? link[1].trim() : value.trim();
}

function parseKnowledgeDescriptions(indexContent: string): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const line of indexContent.split(/\r?\n/)) {
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 2) continue;
    const [nameCell, descriptionCell] = cells;
    if (!nameCell || /^-+$/.test(nameCell.replace(/:/g, "")) || /^(知识库|name)$/i.test(nameCell)) continue;
    const name = normalizeKnowledgeBaseName(nameCell);
    if (name) descriptions.set(name, descriptionCell);
  }
  return descriptions;
}

export async function getKnowledgeOverview(): Promise<{ bases: KnowledgeBaseSummary[] }> {
  const paths = getPaths();
  let entries;
  try {
    entries = await readdir(paths.knowledgeBase, { withFileTypes: true });
  } catch {
    return { bases: [] };
  }

  let descriptions = new Map<string, string>();
  try {
    descriptions = parseKnowledgeDescriptions(await readFile(join(paths.knowledgeBase, "index.md"), "utf-8"));
  } catch {
    // The directory listing remains useful without an index.
  }

  const bases: KnowledgeBaseSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const files = (await readdir(join(paths.knowledgeBase, entry.name), { withFileTypes: true }))
        .filter((item) => item.isFile() && item.name !== "index.md")
        .map((item) => item.name)
        .sort((a, b) => a.localeCompare(b, "zh-CN"));
      bases.push({ name: entry.name, description: descriptions.get(entry.name) ?? "", files });
    } catch {
      // Skip unreadable knowledge base directories.
    }
  }
  bases.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { bases };
}
