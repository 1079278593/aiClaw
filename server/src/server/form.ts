import type { IncomingMessage } from "node:http";

export type FormFile = {
  field: string;
  filename: string;
  mime: string;
  data: Buffer;
};

export async function readMultipart(req: IncomingMessage): Promise<{ fields: Map<string, string>; files: FormFile[] }> {
  const contentType = req.headers["content-type"] ?? "";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
  if (!boundary) throw new Error("不是表单");

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  const files: FormFile[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return { fields, files };
  cursor += delimiter.length;

  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).toString() === "--") break;
    if (body.subarray(cursor, cursor + 2).toString() === "\r\n") cursor += 2;
    const headerEnd = body.indexOf("\r\n\r\n", cursor);
    if (headerEnd === -1) break;
    const header = body.subarray(cursor, headerEnd).toString("utf-8");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next === -1) break;
    let dataEnd = next;
    if (body.subarray(dataEnd - 2, dataEnd).toString() === "\r\n") dataEnd -= 2;
    const data = body.subarray(dataStart, dataEnd);
    const name = /name="([^"]*)"/.exec(header)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(header)?.[1];
    const mime = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() ?? "application/octet-stream";
    if (filename !== undefined) files.push({ field: name, filename, mime, data });
    else fields.set(name, data.toString("utf-8"));
    cursor = next + delimiter.length;
  }
  return { fields, files };
}
