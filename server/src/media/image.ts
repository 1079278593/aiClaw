import sharp from "sharp";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 1024;

const MIME_BY_FORMAT: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface NormalizedImage {
  buffer: Buffer;
  mimeType: string;
  resized: boolean;
}

function imageTooLargeError(): Error {
  return new Error("图片超过 5 MiB 限制");
}

function assertImageSize(buffer: Buffer): void {
  if (buffer.length > MAX_IMAGE_BYTES) throw imageTooLargeError();
}

export async function normalizeImageBuffer(buffer: Buffer): Promise<NormalizedImage> {
  assertImageSize(buffer);

  const image = sharp(buffer, { animated: false, limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  const mimeType = MIME_BY_FORMAT[metadata.format ?? ""];
  if (!mimeType || !metadata.width || !metadata.height) {
    throw new Error("不支持的图片类型（仅支持 PNG、JPG/JPEG、GIF、WebP）");
  }

  if (Math.max(metadata.width, metadata.height) <= MAX_IMAGE_DIMENSION) {
    return { buffer, mimeType, resized: false };
  }

  const resized = await sharp(buffer, { animated: false, limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return { buffer: resized, mimeType: "image/jpeg", resized: true };
}

export async function normalizeImageDataUrl(dataUrl: string): Promise<string> {
  const match = /^data:image\/[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("无效的图片数据");

  const buffer = Buffer.from(match[1], "base64");
  assertImageSize(buffer);
  const normalized = await normalizeImageBuffer(buffer);
  return `data:${normalized.mimeType};base64,${normalized.buffer.toString("base64")}`;
}
