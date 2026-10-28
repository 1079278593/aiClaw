import { readFile } from "node:fs/promises";
import { getPaths } from "../../config/paths.js";

export type CommandDefinition = {
  name: string;
  prompt: string;
};

export function parseCommandsMarkdown(content: string): CommandDefinition[] {
  const lines = content.split(/\r?\n/);
  const commands: CommandDefinition[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!headingMatch) continue;
    const name = headingMatch[1].trim();
    if (!name || seen.has(name)) continue;

    let prompt: string | null = null;
    i += 1;
    while (i < lines.length) {
      if (/^##\s+/.test(lines[i])) {
        i -= 1;
        break;
      }
      if (prompt === null && /^```prompt\s*$/i.test(lines[i])) {
        const promptLines: string[] = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          promptLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length && /^```\s*$/.test(lines[i])) prompt = promptLines.join("\n").trimEnd();
        continue;
      }
      if (/^```/.test(lines[i]) && lines[i].trim() !== "```") {
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) i += 1;
      }
      i += 1;
    }

    if (!prompt?.trim()) continue;
    commands.push({ name, prompt });
    seen.add(name);
  }
  return commands;
}

export async function listCommands(query: string): Promise<CommandDefinition[]> {
  let content = "";
  try {
    content = await readFile(getPaths().commandsFile, "utf-8");
  } catch {
    return [];
  }
  const commands = parseCommandsMarkdown(content);
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery ? commands.filter((command) => command.name.toLowerCase().startsWith(normalizedQuery)) : commands;
}
