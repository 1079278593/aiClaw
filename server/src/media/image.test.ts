import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { MAX_IMAGE_BYTES, normalizeImageBuffer, normalizeImageDataUrl } from "./image.js";

async function createPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#6b8e23" } }).png().toBuffer();
}

describe("normalizeImageBuffer", () => {
  it("keeps a supported image within the dimension limit unchanged", async () => {
    const input = await createPng(800, 600);
    const result = await normalizeImageBuffer(input);

    expect(result.buffer).toEqual(input);
    expect(result.mimeType).toBe("image/png");
    expect(result.resized).toBe(false);
  });

  it("resizes an oversized image to a 1024-pixel long edge as JPEG", async () => {
    const result = await normalizeImageBuffer(await createPng(2000, 1000));
    const metadata = await sharp(result.buffer).metadata();

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.resized).toBe(true);
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(512);
  });

  it("rejects input larger than 5 MiB before decoding it", async () => {
    await expect(normalizeImageBuffer(Buffer.alloc(MAX_IMAGE_BYTES + 1))).rejects.toThrow("图片超过 5 MiB 限制");
  });
});

describe("normalizeImageDataUrl", () => {
  it("normalizes pasted image data with the same dimension rule", async () => {
    const input = await createPng(500, 2000);
    const dataUrl = `data:image/png;base64,${input.toString("base64")}`;
    const normalizedUrl = await normalizeImageDataUrl(dataUrl);
    const encoded = normalizedUrl.slice(normalizedUrl.indexOf(",") + 1);
    const metadata = await sharp(Buffer.from(encoded, "base64")).metadata();

    expect(normalizedUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(1024);
  });
});
