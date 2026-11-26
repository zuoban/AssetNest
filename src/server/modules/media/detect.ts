import path from "node:path";
import type { AssetType } from "../../../shared/types.js";

export interface DetectedFileType {
  mimeType: string;
  ext: string;
  assetType: AssetType;
  isRasterPreviewable: boolean;
  isVideo: boolean;
  isSafePlainText: boolean;
  isActiveContent: boolean;
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".log"]);
const ACTIVE_EXTENSIONS = new Set([".svg", ".svgz", ".html", ".htm", ".xhtml", ".js", ".mjs"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json"]);
const NON_RASTER_IMAGE_EXTENSIONS = new Set([".psd", ".ai", ".eps", ".raw", ".cr2", ".nef", ".arw", ".dng"]);

export function sanitizeFilename(rawName: string): string {
  const base = path.basename(rawName || "unnamed");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "unnamed";
  }
  return cleaned.slice(0, 220);
}

function startsWithBytes(buffer: Buffer, signature: number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) {
    return false;
  }
  for (let idx = 0; idx < signature.length; idx += 1) {
    if (buffer[offset + idx] !== signature[idx]) {
      return false;
    }
  }
  return true;
}

function isLikelyText(buffer: Buffer): boolean {
  const sampleLen = Math.min(buffer.length, 4096);
  if (sampleLen === 0) {
    return true;
  }
  let suspicious = 0;
  for (let idx = 0; idx < sampleLen; idx += 1) {
    const byte = buffer[idx]!;
    if (byte === 0) {
      return false;
    }
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLen < 0.02;
}

function detectTextActiveMarkup(buffer: Buffer): "svg" | "html" | null {
  const snippet = buffer
    .subarray(0, Math.min(buffer.length, 2048))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (snippet.includes("<svg")) {
    return "svg";
  }
  if (
    snippet.startsWith("<!doctype html") ||
    snippet.startsWith("<html") ||
    snippet.includes("<script")
  ) {
    return "html";
  }
  return null;
}

export function detectFileType(header: Buffer, originalFilename: string, declaredMime?: string): DetectedFileType {
  const safeName = sanitizeFilename(originalFilename);
  const ext = path.extname(safeName).toLowerCase();

  if (startsWithBytes(header, [0xff, 0xd8, 0xff])) {
    return {
      mimeType: "image/jpeg",
      ext: ext || ".jpg",
      assetType: "image",
      isRasterPreviewable: true,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return {
      mimeType: "image/png",
      ext: ext || ".png",
      assetType: "image",
      isRasterPreviewable: true,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (
    startsWithBytes(header, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(header, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return {
      mimeType: "image/gif",
      ext: ext || ".gif",
      assetType: "image",
      isRasterPreviewable: true,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(header, [0x57, 0x45, 0x42, 0x50], 8)) {
    return {
      mimeType: "image/webp",
      ext: ext || ".webp",
      assetType: "image",
      isRasterPreviewable: true,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x42, 0x4d])) {
    return {
      mimeType: "image/bmp",
      ext: ext || ".bmp",
      assetType: "image",
      isRasterPreviewable: true,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(header, [0x4d, 0x4d, 0x00, 0x2a])) {
    return {
      mimeType: "image/tiff",
      ext: ext || ".tiff",
      assetType: "image",
      isRasterPreviewable: true,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x38, 0x42, 0x50, 0x53])) {
    return {
      mimeType: "image/vnd.adobe.photoshop",
      ext: ext || ".psd",
      assetType: "other",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (header.length >= 12 && startsWithBytes(header, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = header.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") {
      return {
        mimeType: "image/avif",
        ext: ext || ".avif",
        assetType: "image",
        isRasterPreviewable: true,
        isVideo: false,
        isSafePlainText: false,
        isActiveContent: false
      };
    }
    if (brand === "qt  ") {
      return {
        mimeType: "video/quicktime",
        ext: ext || ".mov",
        assetType: "video",
        isRasterPreviewable: false,
        isVideo: true,
        isSafePlainText: false,
        isActiveContent: false
      };
    }
    return {
      mimeType: "video/mp4",
      ext: ext || ".mp4",
      assetType: "video",
      isRasterPreviewable: false,
      isVideo: true,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x1a, 0x45, 0xdf, 0xa3])) {
    return {
      mimeType: "video/webm",
      ext: ext || ".webm",
      assetType: "video",
      isRasterPreviewable: false,
      isVideo: true,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return {
      mimeType: "application/pdf",
      ext: ext || ".pdf",
      assetType: "document",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }
  if (startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(header, [0x50, 0x4b, 0x05, 0x06])) {
    return {
      mimeType: "application/zip",
      ext: ext || ".zip",
      assetType: "archive",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }

  const activeFromContent = isLikelyText(header) ? detectTextActiveMarkup(header) : null;
  const lowerDeclared = (declaredMime || "").toLowerCase();
  if (
    activeFromContent === "svg" ||
    ext === ".svg" ||
    ext === ".svgz" ||
    lowerDeclared.includes("svg")
  ) {
    return {
      mimeType: "image/svg+xml",
      ext: ext || ".svg",
      assetType: "image",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: true
    };
  }
  if (
    activeFromContent === "html" ||
    ACTIVE_EXTENSIONS.has(ext) ||
    lowerDeclared.includes("html") ||
    lowerDeclared.includes("javascript")
  ) {
    return {
      mimeType:
        ext === ".html" || ext === ".htm" || activeFromContent === "html"
          ? "text/html"
          : "application/octet-stream",
      ext: ext || ".html",
      assetType: "document",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: true
    };
  }

  if (NON_RASTER_IMAGE_EXTENSIONS.has(ext)) {
    return {
      mimeType: "application/octet-stream",
      ext,
      assetType: "other",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }

  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return {
      mimeType: "application/octet-stream",
      ext,
      assetType: "archive",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }

  if (TEXT_EXTENSIONS.has(ext) && isLikelyText(header)) {
    return {
      mimeType: ext === ".md" || ext === ".markdown" ? "text/markdown" : "text/plain",
      ext,
      assetType: "document",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: true,
      isActiveContent: false
    };
  }

  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return {
      mimeType: "application/octet-stream",
      ext,
      assetType: "document",
      isRasterPreviewable: false,
      isVideo: false,
      isSafePlainText: false,
      isActiveContent: false
    };
  }

  return {
    mimeType: "application/octet-stream",
    ext,
    assetType: "other",
    isRasterPreviewable: false,
    isVideo: false,
    isSafePlainText: false,
    isActiveContent: false
  };
}

export function isActiveMimeOrExt(mimeType: string, ext: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerExt = ext.toLowerCase();
  return (
    lowerMime.includes("svg") ||
    lowerMime.includes("html") ||
    lowerMime.includes("javascript") ||
    ACTIVE_EXTENSIONS.has(lowerExt)
  );
}

export function isSafePlainTextMime(mimeType: string, ext: string): boolean {
  if (isActiveMimeOrExt(mimeType, ext)) {
    return false;
  }
  const lowerMime = mimeType.toLowerCase();
  return lowerMime === "text/plain" || lowerMime === "text/markdown" || TEXT_EXTENSIONS.has(ext.toLowerCase());
}

export function isRasterImageMime(mimeType: string): boolean {
  return (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif" ||
    mimeType === "image/avif" ||
    mimeType === "image/bmp" ||
    mimeType === "image/tiff"
  );
}
