import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileArchive,
  FileText,
  Maximize2,
  Minimize2,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { AssetListItem } from "../../shared/types";
import { api } from "../api/client";
import { formatBytes, isPreviewableRaster, isSafeTextPreview } from "../utils/format";

interface AssetLightboxProps {
  items: AssetListItem[];
  currentIndex: number;
  onChangeIndex: (index: number) => void;
  onClose: () => void;
}

export function AssetLightbox({
  items,
  currentIndex,
  onChangeIndex,
  onClose
}: AssetLightboxProps) {
  const asset = items[currentIndex];
  const [zoomMode, setZoomMode] = useState<"fit" | "actual">("fit");
  const [scale, setScale] = useState(1);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  const canPrev = currentIndex > 0;
  const canNext = currentIndex < items.length - 1;

  useEffect(() => {
    setZoomMode("fit");
    setScale(1);
    setTextContent(null);
    setTextError(null);
  }, [asset?.id, asset?.currentVersionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && canPrev) {
        onChangeIndex(currentIndex - 1);
      } else if (event.key === "ArrowRight" && canNext) {
        onChangeIndex(currentIndex + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canNext, canPrev, currentIndex, onChangeIndex, onClose]);

  useEffect(() => {
    if (!asset || !isSafeTextPreview(asset.mimeType, asset.ext)) {
      return;
    }
    let cancelled = false;
    setTextLoading(true);
    fetch(api.contentUrl(asset.id, asset.currentVersionId, true), { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (!cancelled) {
          setTextContent(raw.length > 200_000 ? `${raw.slice(0, 200_000)}\n\n...（文件较大，仅展示前 200KB）` : raw);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTextError(err instanceof Error ? err.message : "读取文本内容失败");
        }
      })
      .finally(() => {
        if (!cancelled) setTextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  if (!asset) {
    return null;
  }

  const raster = isPreviewableRaster(asset.mimeType);
  const video = asset.mimeType.startsWith("video/");
  const plainText = isSafeTextPreview(asset.mimeType, asset.ext);
  const previewUrl = api.contentUrl(asset.id, asset.currentVersionId, true);
  const downloadUrl = api.contentUrl(asset.id, asset.currentVersionId, false);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 text-white">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm font-medium">{asset.name}</span>
          <span className="font-mono-tabular shrink-0 text-xs text-slate-400">
            {currentIndex + 1} / {items.length}
          </span>
          <span className="font-mono-tabular hidden shrink-0 text-xs text-slate-400 sm:inline">
            {asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.mimeType} ·{" "}
            {formatBytes(asset.sizeBytes)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {raster && (
            <>
              <button
                type="button"
                onClick={() => setScale((prev) => Math.max(0.25, Number((prev - 0.25).toFixed(2))))}
                className="rounded-md bg-white/10 p-1.5 hover:bg-white/20"
                title="缩小"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="font-mono-tabular w-12 text-center text-xs text-slate-300">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setScale((prev) => Math.min(4, Number((prev + 0.25).toFixed(2))))}
                className="rounded-md bg-white/10 p-1.5 hover:bg-white/20"
                title="放大"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoomMode((prev) => (prev === "fit" ? "actual" : "fit"));
                  setScale(1);
                }}
                className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs hover:bg-white/20"
              >
                {zoomMode === "fit" ? (
                  <>
                    <Maximize2 className="h-3.5 w-3.5" /> 100% 原尺寸
                  </>
                ) : (
                  <>
                    <Minimize2 className="h-3.5 w-3.5" /> 适应窗口
                  </>
                )}
              </button>
            </>
          )}
          <a
            href={downloadUrl}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            <Download className="h-3.5 w-3.5" />
            下载原文件
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-white/10 p-1.5 hover:bg-white/20"
            title="关闭 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        {canPrev && (
          <button
            type="button"
            onClick={() => onChangeIndex(currentIndex - 1)}
            className="fixed left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/25"
            title="上一项 (←)"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}

        {raster ? (
          <img
            src={previewUrl}
            alt={asset.name}
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "center center"
            }}
            className={
              zoomMode === "fit"
                ? "max-h-full max-w-full rounded object-contain transition-transform duration-150"
                : "max-w-none rounded transition-transform duration-150"
            }
          />
        ) : video ? (
          <video
            src={previewUrl}
            controls
            className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
          />
        ) : plainText ? (
          <div className="max-h-full w-full max-w-4xl overflow-auto rounded-xl border border-white/10 bg-slate-900 p-6">
            <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
              <FileText className="h-4 w-4" />
              安全纯文本预览（沙箱隔离，不执行任何脚本）
            </div>
            {textLoading ? (
              <div className="text-xs text-slate-400">正在加载文本内容...</div>
            ) : textError ? (
              <div className="text-xs text-rose-400">{textError}</div>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-100">
                {textContent}
              </pre>
            )}
          </div>
        ) : (
          <div className="flex max-w-md flex-col items-center rounded-xl border border-white/10 bg-slate-900 p-8 text-center">
            <FileArchive className="h-12 w-12 text-slate-400" />
            <div className="mt-4 text-sm font-medium text-white">{asset.originalFilename}</div>
            <div className="mt-1 text-xs text-slate-400">
              {asset.mimeType} · {formatBytes(asset.sizeBytes)}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              当前格式不支持站内直接渲染（或出于安全策略已禁止同源执行 SVG/HTML）。请下载原文件至本地专业工具查看。
            </p>
            <a
              href={downloadUrl}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
            >
              <Download className="h-3.5 w-3.5" />
              下载原文件
            </a>
          </div>
        )}

        {canNext && (
          <button
            type="button"
            onClick={() => onChangeIndex(currentIndex + 1)}
            className="fixed right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/25"
            title="下一项 (→)"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}
