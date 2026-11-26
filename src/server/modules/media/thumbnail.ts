import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import sharp from "sharp";
import type { ThumbStatus } from "../../../shared/types.js";
import { isRasterImageMime } from "./detect.js";

const MAX_INPUT_PIXELS = 64_000_000;
const THUMB_MAX_DIMENSION = 480;

export interface ImageDimensions {
  width: number | null;
  height: number | null;
}

export interface ThumbnailGenerationResult {
  thumbStatus: ThumbStatus;
  thumbKey: string | null;
}

export async function inspectImageDimensions(filePath: string, mimeType: string): Promise<ImageDimensions> {
  if (!isRasterImageMime(mimeType)) {
    return { width: null, height: null };
  }
  try {
    const metadata = await sharp(filePath, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "warning"
    }).metadata();
    return {
      width: typeof metadata.width === "number" ? metadata.width : null,
      height: typeof metadata.height === "number" ? metadata.height : null
    };
  } catch {
    return { width: null, height: null };
  }
}

export function buildThumbnailRelPath(sha256: string): string {
  const normalized = sha256.toLowerCase();
  return path.join("thumbs", normalized.slice(0, 2), `${normalized}.webp`);
}

export function resolveThumbnailAbsPath(cacheDir: string, thumbKey: string): string {
  const root = path.resolve(cacheDir);
  const resolved = path.resolve(root, thumbKey);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("缩略图缓存路径越界");
  }
  return resolved;
}

export async function isValidThumbnailFile(absPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile() || stat.size < 16) {
      return false;
    }
    const fd = await fsp.open(absPath, "r");
    try {
      const header = Buffer.alloc(12);
      await fd.read(header, 0, 12, 0);
      return (
        header[0] === 0x52 &&
        header[1] === 0x49 &&
        header[2] === 0x46 &&
        header[3] === 0x46 &&
        header[8] === 0x57 &&
        header[9] === 0x45 &&
        header[10] === 0x42 &&
        header[11] === 0x50
      );
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

async function enforceCacheLimit(cacheDir: string, maxSizeMB: number): Promise<void> {
  const thumbsRoot = path.join(path.resolve(cacheDir), "thumbs");
  if (!fs.existsSync(thumbsRoot)) {
    return;
  }
  const maxBytes = maxSizeMB * 1024 * 1024;
  const entries: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile() && item.name.endsWith(".webp")) {
        const stat = await fsp.stat(fullPath).catch(() => null);
        if (stat) {
          totalBytes += stat.size;
          entries.push({ filePath: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }

  await walk(thumbsRoot);
  if (totalBytes <= maxBytes) {
    return;
  }

  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const targetBytes = Math.floor(maxBytes * 0.85);
  for (const entry of entries) {
    if (totalBytes <= targetBytes) {
      break;
    }
    await fsp.rm(entry.filePath, { force: true }).catch(() => {});
    totalBytes -= entry.size;
  }
}

export async function generateThumbnailFromFile(
  sourcePath: string,
  mimeType: string,
  sha256: string,
  cacheDir: string,
  maxCacheSizeMB: number
): Promise<ThumbnailGenerationResult> {
  if (!isRasterImageMime(mimeType)) {
    return { thumbStatus: "unsupported", thumbKey: null };
  }
  const thumbKey = buildThumbnailRelPath(sha256);
  const targetPath = resolveThumbnailAbsPath(cacheDir, thumbKey);
  const parentDir = path.dirname(targetPath);
  const tempPath = path.join(parentDir, `.${crypto.randomUUID()}.webp.tmp`);

  try {
    await fsp.mkdir(parentDir, { recursive: true });
    await sharp(sourcePath, {
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false
    })
      .rotate()
      .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 82 })
      .toFile(tempPath);

    await fsp.rename(tempPath, targetPath);
    await enforceCacheLimit(cacheDir, maxCacheSizeMB);
    return { thumbStatus: "ready", thumbKey };
  } catch {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    return { thumbStatus: "failed", thumbKey: null };
  }
}

export async function generateThumbnailFromStream(
  stream: Readable,
  mimeType: string,
  sha256: string,
  cacheDir: string,
  maxCacheSizeMB: number
): Promise<ThumbnailGenerationResult> {
  if (!isRasterImageMime(mimeType)) {
    stream.resume();
    return { thumbStatus: "unsupported", thumbKey: null };
  }
  const thumbKey = buildThumbnailRelPath(sha256);
  const targetPath = resolveThumbnailAbsPath(cacheDir, thumbKey);
  const parentDir = path.dirname(targetPath);
  const tempPath = path.join(parentDir, `.${crypto.randomUUID()}.webp.tmp`);

  try {
    await fsp.mkdir(parentDir, { recursive: true });
    const transformer = sharp({
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false
    })
      .rotate()
      .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 82 });

    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      transformer.on("error", reject);
      stream.pipe(transformer);
      transformer.toFile(tempPath).then(() => resolve(), reject);
    });

    await fsp.rename(tempPath, targetPath);
    await enforceCacheLimit(cacheDir, maxCacheSizeMB);
    return { thumbStatus: "ready", thumbKey };
  } catch {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    return { thumbStatus: "failed", thumbKey: null };
  }
}
