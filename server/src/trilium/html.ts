const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "pre", "blockquote", "section", "article"]);
const BREAK_TAGS = new Set(["br", "hr"]);

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Convert Trilium text-note HTML into readable plain text / light markdown.
 * Not a full HTML renderer; tables and complex layouts are flattened.
 */
export function htmlToReadableText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  let text = withoutScripts.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, rawTag: string) => {
    const tag = rawTag.toLowerCase();
    if (BREAK_TAGS.has(tag)) return "\n";
    if (tag === "img") {
      const alt = /alt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(match);
      return alt?.[2] || alt?.[3] ? `[图片: ${alt[2] || alt[3]}]` : "";
    }
    if (BLOCK_TAGS.has(tag)) return "\n";
    return "";
  });

  text = decodeEntities(text);
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
