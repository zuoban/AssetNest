import type {
  ListingStatus,
  ProductStatus,
  TagDimension
} from "../../shared/types";
import type { ImageUploadSizes } from "../api/client";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[idx]}`;
}

export function formatUploadCompression(sizes: ImageUploadSizes | null): string {
  if (!sizes) return "";
  const { originalBytes, uploadedBytes, unchangedImages } = sizes;
  const original = formatBytes(originalBytes);
  if (originalBytes === uploadedBytes) return ` · 图片未缩小，按原文件上传（${original}）`;

  const uploaded = formatBytes(uploadedBytes);
  const saving = ((originalBytes - uploadedBytes) / originalBytes) * 100;
  const percent = saving < 0.1 ? "<0.1%" : `${saving.toFixed(1)}%`;
  const sizeChange = original === uploaded
    ? `原始 ${originalBytes} B → 上传 ${uploadedBytes} B`
    : `原始 ${original} → 上传 ${uploaded}`;
  return ` · 图片${sizeChange}，节省 ${percent}${
    unchangedImages > 0 ? `（${unchangedImages} 张未缩小）` : ""
  }`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export const TAG_DIMENSION_LABELS: Record<TagDimension, string> = {
  market: "市场",
  platform: "平台",
  purpose: "用途",
  scene: "场景",
  color: "颜色",
  custom: "自定义"
};

export const PRODUCT_STATUS_META: Record<ProductStatus, { label: string; className: string }> = {
  active: { label: "在用", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  draft: { label: "草稿", className: "bg-slate-100 text-slate-700 border-slate-200" },
  archived: { label: "已归档", className: "bg-amber-50 text-amber-700 border-amber-200" }
};

export const LISTING_STATUS_META: Record<ListingStatus, { label: string; className: string }> = {
  draft: { label: "草稿", className: "bg-slate-100 text-slate-700 border-slate-200" },
  ready: { label: "已准备", className: "bg-blue-50 text-blue-700 border-blue-200" },
  published: { label: "已上架（人工标记）", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  archived: { label: "已归档", className: "bg-amber-50 text-amber-800 border-amber-200" }
};

export const MASTER_ANGLE_OPTIONS = [
  { value: "front", label: "正面 (front)" },
  { value: "side", label: "侧面 (side)" },
  { value: "back", label: "背面 (back)" },
  { value: "top", label: "俯视 (top)" },
  { value: "worn", label: "佩戴/使用态 (worn)" },
  { value: "detail", label: "细节特写 (detail)" },
  { value: "package", label: "包装形态 (package)" }
];

export function formatAspectRatio(width: number | null, height: number | null): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const rw = Math.round(width / divisor);
  const rh = Math.round(height / divisor);
  if (rw <= 21 && rh <= 21) {
    return `${rw}:${rh}`;
  }
  return `${(width / height).toFixed(2)}:1`;
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export const ASSET_PURPOSES = [
  { value: "raw", label: "实拍图" },
  { value: "main", label: "主图" },
  { value: "carousel", label: "轮播图" },
  { value: "detail", label: "详情图" },
  { value: "sku", label: "SKU图" },
  { value: "ai_generated", label: "AI生成图" },
  { value: "video", label: "视频" },
  { value: "manual", label: "说明书" },
  { value: "other", label: "其他" }
];

export function isPreviewableRaster(mimeType: string): boolean {
  return (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif" ||
    mimeType === "image/avif" ||
    mimeType === "image/bmp"
  );
}

export function isSafeTextPreview(mimeType: string, ext: string): boolean {
  const lowerExt = ext.toLowerCase();
  if (mimeType.includes("svg") || mimeType.includes("html") || lowerExt === ".svg" || lowerExt === ".html") {
    return false;
  }
  return (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".log"].includes(lowerExt)
  );
}
