import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectFileType,
  isActiveMimeOrExt,
  isSafePlainTextMime,
  sanitizeFilename
} from "../../src/server/modules/media/detect.js";
import {
  generateThumbnailFromFile,
  inspectImageDimensions,
  isValidThumbnailFile,
  resolveThumbnailAbsPath
} from "../../src/server/modules/media/thumbnail.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-media-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Media detection and thumbnail generation", () => {
  it("detects magic bytes, sanitizes filenames, and classifies active SVG/HTML safely", async () => {
    const pngBuf = await sharp({
      create: { width: 120, height: 80, channels: 4, background: { r: 37, g: 99, b: 235, alpha: 1 } }
    })
      .png()
      .toBuffer();

    const pngDetected = detectFileType(pngBuf, "hero.png", "image/png");
    expect(pngDetected.mimeType).toBe("image/png");
    expect(pngDetected.assetType).toBe("image");

    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svgDetected = detectFileType(svgBuf, "icon.svg", "image/svg+xml");
    expect(svgDetected.mimeType).toBe("image/svg+xml");
    expect(isActiveMimeOrExt(svgDetected.mimeType, svgDetected.ext)).toBe(true);
    expect(isSafePlainTextMime(svgDetected.mimeType, svgDetected.ext)).toBe(false);

    const htmlBuf = Buffer.from("<!doctype html><html><body>hi</body></html>");
    const htmlDetected = detectFileType(htmlBuf, "page.html", "text/html");
    expect(isActiveMimeOrExt(htmlDetected.mimeType, htmlDetected.ext)).toBe(true);

    const txtDetected = detectFileType(Buffer.from("hello ไทย 中文"), "notes.txt", "text/plain");
    expect(isSafePlainTextMime(txtDetected.mimeType, txtDetected.ext)).toBe(true);

    expect(sanitizeFilename("../../evil\u0000/name?.png")).not.toContain("..");
    expect(sanitizeFilename("../../evil\u0000/name?.png")).not.toContain("/");
  });

  it("generates WebP thumbnails, reads dimensions, and detects corrupted cached thumbnails", async () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, "sample.png");
    const cacheDir = path.join(dir, "cache");

    const pngBuf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 220, g: 120, b: 40 } }
    })
      .png()
      .toBuffer();
    fs.writeFileSync(sourcePath, pngBuf);
    const sha = crypto.createHash("sha256").update(pngBuf).digest("hex");

    const dims = await inspectImageDimensions(sourcePath, "image/png");
    expect(dims).toEqual({ width: 800, height: 600 });

    const thumb = await generateThumbnailFromFile(sourcePath, "image/png", sha, cacheDir, 50);
    expect(thumb.thumbStatus).toBe("ready");
    expect(thumb.thumbKey).toBeTruthy();

    const absPath = resolveThumbnailAbsPath(cacheDir, thumb.thumbKey!);
    expect(await isValidThumbnailFile(absPath)).toBe(true);

    // Corrupt the cached thumbnail file and verify detection
    fs.writeFileSync(absPath, "CORRUPTED_BYTES");
    expect(await isValidThumbnailFile(absPath)).toBe(false);

    // Re-generate and verify recovery
    const recovered = await generateThumbnailFromFile(sourcePath, "image/png", sha, cacheDir, 50);
    expect(recovered.thumbStatus).toBe("ready");
    expect(await isValidThumbnailFile(absPath)).toBe(true);
  });
});
