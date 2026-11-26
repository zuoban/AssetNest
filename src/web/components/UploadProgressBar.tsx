import { X } from "lucide-react";
import type { ImageUploadSizes, UploadTransferProgress } from "../api/client";
import { formatBytes } from "../utils/format";
import type { PreparedUploadItem } from "../utils/uploadPreparation";

export function formatSavingPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0.0%";
  return percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

function formatBytePair(originalBytes: number, targetBytes: number): string {
  const original = formatBytes(originalBytes);
  const target = formatBytes(targetBytes);
  return original === target
    ? `${originalBytes} B → ${targetBytes} B`
    : `${original} → ${target}`;
}

export function formatCompressionSummaryLine(sizes: ImageUploadSizes): string {
  const { originalBytes, uploadedBytes, unchangedImages } = sizes;
  if (originalBytes <= uploadedBytes) {
    return `图片未缩小，按原图上传（${formatBytes(originalBytes)}）`;
  }
  const savedBytes = originalBytes - uploadedBytes;
  const savedPercent = (savedBytes / originalBytes) * 100;
  return `已压缩：${formatBytePair(originalBytes, uploadedBytes)}，节省 ${formatBytes(savedBytes)} (-${formatSavingPercent(savedPercent)})${
    unchangedImages > 0 ? `（${unchangedImages} 张未缩小）` : ""
  }`;
}

export function formatPreparedItemStatus(
  item: PreparedUploadItem,
  compressEnabled: boolean
): { text: string; toneClass: string } {
  const originalSize = formatBytes(item.originalFile.size);
  if (!compressEnabled) {
    return { text: `原文件 · ${originalSize}`, toneClass: "text-gray-500" };
  }
  switch (item.status) {
    case "queued":
      return { text: `等待压缩 · ${originalSize}`, toneClass: "text-gray-500" };
    case "compressing":
      return { text: `压缩中… · ${originalSize}`, toneClass: "text-blue-600" };
    case "compressed": {
      const savedPercent =
        item.originalFile.size > 0
          ? ((item.originalFile.size - item.uploadFile.size) / item.originalFile.size) * 100
          : 0;
      return {
        text: `${formatBytePair(item.originalFile.size, item.uploadFile.size)} (-${formatSavingPercent(savedPercent)})`,
        toneClass: "text-emerald-700"
      };
    }
    case "unchanged":
      return { text: `未缩小（原图） · ${originalSize}`, toneClass: "text-gray-500" };
    case "skipped":
    case "idle":
    default:
      return { text: `原文件 · ${originalSize}`, toneClass: "text-gray-500" };
  }
}

interface CompressionProgressPanelProps {
  completed: number;
  total: number;
  percent: number;
  isCompressing: boolean;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  savedPercent: number;
  unchangedImages: number;
  compact?: boolean;
}

export function CompressionProgressPanel({
  completed,
  total,
  percent,
  isCompressing,
  originalBytes,
  compressedBytes,
  savedBytes,
  savedPercent,
  unchangedImages,
  compact = false
}: CompressionProgressPanelProps) {
  if (total <= 0) return null;

  const padClass = compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-2 text-xs";

  if (isCompressing) {
    return (
      <div
        className={`space-y-1.5 rounded-lg border border-blue-200 bg-blue-50/70 text-blue-900 ${padClass}`}
        data-testid="compression-progress"
      >
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="font-medium">
            正在压缩图片 {completed}/{total} ({percent}%)
          </span>
          {savedBytes > 0 ? (
            <span className="font-mono-tabular text-emerald-700">
              已节省 {formatBytes(savedBytes)} (-{formatSavingPercent(savedPercent)})
            </span>
          ) : completed > 0 ? (
            <span className="font-mono-tabular text-blue-700">已处理 {completed} 张</span>
          ) : null}
        </div>
        <div
          role="progressbar"
          aria-label="图片压缩进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-blue-100"
        >
          <div
            className="h-full rounded-full bg-blue-600 transition-[width] duration-150"
            style={{ width: `${Math.max(4, percent)}%` }}
          />
        </div>
      </div>
    );
  }

  if (completed <= 0) return null;

  if (savedBytes > 0) {
    return (
      <div
        className={`rounded-lg border border-emerald-200 bg-emerald-50/70 text-emerald-800 ${padClass}`}
        data-testid="compression-summary"
      >
        <span className="font-medium">压缩完成：</span>
        <span className="font-mono-tabular">
          {formatBytePair(originalBytes, compressedBytes)}，节省 {formatBytes(savedBytes)} (-
          {formatSavingPercent(savedPercent)})
        </span>
        {unchangedImages > 0 && <span>（{unchangedImages} 张未缩小）</span>}
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border border-gray-200 bg-gray-50 text-gray-600 ${padClass}`}
      data-testid="compression-summary"
    >
      压缩完成：图片未缩小，将按原图上传（
      <span className="font-mono-tabular">{formatBytes(originalBytes)}</span>）
    </div>
  );
}

interface UploadTransferProgressPanelProps {
  progress: UploadTransferProgress;
  label?: string;
  compressionSummary?: ImageUploadSizes | null;
  compact?: boolean;
}

export function UploadTransferProgressPanel({
  progress,
  label = "正在上传文件…",
  compressionSummary,
  compact = false
}: UploadTransferProgressPanelProps) {
  const padClass = compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-2 text-xs";
  const isProcessing = progress.phase === "processing";

  return (
    <div
      className={`space-y-1.5 rounded-lg border border-blue-200 bg-blue-50/70 text-blue-900 ${padClass}`}
      data-testid="upload-progress"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="font-medium">
          {isProcessing ? "上传完成，服务器处理中…" : label}
        </span>
        <span className="font-mono-tabular text-blue-800">
          {isProcessing
            ? `100%${progress.total > 0 ? ` · ${formatBytes(progress.total)}` : ""}`
            : `${progress.percent}%${
                progress.total > 0
                  ? ` · ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
                  : ""
              }`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="文件上传进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-blue-100"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-150 ${
            isProcessing ? "animate-pulse bg-emerald-600" : "bg-blue-600"
          }`}
          style={{ width: `${isProcessing ? 100 : progress.percent}%` }}
        />
      </div>
      {compressionSummary && (
        <p className="font-mono-tabular text-[11px] text-emerald-700">
          {formatCompressionSummaryLine(compressionSummary)}
        </p>
      )}
    </div>
  );
}

interface PreparedUploadListProps {
  items: PreparedUploadItem[];
  compressEnabled: boolean;
  disabled?: boolean;
  onRemove: (id: string) => void;
}

export function PreparedUploadList({
  items,
  compressEnabled,
  disabled = false,
  onRemove
}: PreparedUploadListProps) {
  if (items.length === 0) return null;

  return (
    <div
      className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2"
      data-testid="upload-queue-list"
    >
      {items.map((item) => {
        const statusInfo = formatPreparedItemStatus(item, compressEnabled);
        return (
          <div
            key={item.id}
            className="flex items-center justify-between gap-2 text-[11px]"
          >
            <span className="min-w-0 flex-1 truncate text-gray-800">
              {item.originalFile.name}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className={`font-mono-tabular ${statusInfo.toneClass}`}>
                {statusInfo.text}
              </span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`移除 ${item.originalFile.name}`}
                  onClick={() => onRemove(item.id)}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
