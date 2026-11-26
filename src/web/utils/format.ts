import type { ProductStatus, ReviewStatus, TagDimension } from "../../shared/types";

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

export const REVIEW_STATUS_META: Record<ReviewStatus, { label: string; className: string }> = {
  pending: { label: "待审核", className: "bg-amber-50 text-amber-700 border-amber-200" },
  approved: { label: "已通过", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "已拒绝", className: "bg-rose-50 text-rose-700 border-rose-200" }
};

export const PRODUCT_STATUS_META: Record<ProductStatus, { label: string; className: string }> = {
  active: { label: "在用", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  draft: { label: "草稿", className: "bg-slate-100 text-slate-700 border-slate-200" },
  archived: { label: "已归档", className: "bg-amber-50 text-amber-700 border-amber-200" }
};

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
