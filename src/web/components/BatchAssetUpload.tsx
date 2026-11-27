import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Upload, X } from "lucide-react";
import { ApiClientError, type api, type CompressionBatchProgress, type ImageUploadSizes, type UploadTransferProgress } from "../api/client";
import { usePreparedUploadFiles } from "../hooks/usePreparedUploadFiles";
import { initialUploadProgress, useUploadSubmission } from "../hooks/useUploadSubmission";
import type { PreparedUploadFile } from "../utils/uploadPreparation";
import { FileDropButton } from "./FileDropButton";
import { ImageCompressionSwitch } from "./ImageCompressionSwitch";
import { ListingUploadRow, useListingWorkbenchUpload, type ListingUploadGroup } from "./ListingWorkbenchUpload";
import { CompressionProgressPanel, PreparedUploadList, UploadTransferProgressPanel } from "./UploadProgressBar";

export interface PreparedUploadOptions {
  compressImages: boolean;
  preparedFiles: PreparedUploadFile[];
  compressionSummary: ImageUploadSizes | null;
  onUploadProgress: (progress: UploadTransferProgress) => void;
}

interface Props {
  dialogTitle?: string;
  onClose?: () => void;
  initialFiles?: File[];
  compression?: { checked: boolean; onChange: (checked: boolean) => void };
  onBusyChange?: (busy: boolean) => void;
  onFilesAdded?: () => void;
  fields?: (busy: boolean) => ReactNode;
  className?: string;
}

type UploadMode = {
  singleFile?: boolean;
  onSubmit: (files: File[], options: PreparedUploadOptions) => Promise<void>;
  onError?: (message: string) => void;
  group?: never;
} | {
  group: ListingUploadGroup;
  singleFile?: never;
  onSubmit?: never;
  onError?: never;
};

type QueuedUploadProps = Props & UploadMode;
type AssetUploadOptions = NonNullable<Parameters<typeof api.uploadAssets>[1]>;

export interface DirectAssetUploadRequest {
  files: File[];
  options: AssetUploadOptions;
}

interface DirectUploadProps {
  direct: DirectAssetUploadRequest;
  onSubmit: (files: File[], options: AssetUploadOptions) => Promise<void>;
  onError: (message: string) => void;
  onComplete: () => void;
}

export function BatchAssetUpload(props: QueuedUploadProps | DirectUploadProps) {
  return "direct" in props ? <DirectAssetUpload {...props} /> : <QueuedAssetUpload {...props} />;
}

function DirectAssetUpload({ direct, onSubmit, onError, onComplete }: DirectUploadProps) {
  const { progress, run } = useUploadSubmission();
  const [compression, setCompression] = useState<CompressionBatchProgress | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const { files, options } = direct;
    void run(async (reportProgress) => {
      if (!options.compressImages) {
        reportProgress(initialUploadProgress(files.reduce((sum, file) => sum + file.size, 0)));
      }
      try {
        await onSubmit(files, {
          ...options,
          onCompressionProgress: setCompression,
          onUploadProgress: reportProgress
        });
      } catch (err) {
        onError(err instanceof ApiClientError ? err.message : "上传失败");
      } finally {
        onComplete();
      }
    });
  }, [direct, onSubmit, onError, onComplete, run]);

  if (progress) {
    return (
      <UploadTransferProgressPanel
        progress={progress}
        label="正在上传素材…"
        compressionSummary={compression && compression.total > 0 ? {
          originalBytes: compression.originalBytes,
          uploadedBytes: compression.compressedBytes,
          unchangedImages: compression.unchangedImages
        } : null}
      />
    );
  }
  if (!compression) return null;
  return (
    <CompressionProgressPanel
      {...compression}
      isCompressing={compression.completed < compression.total}
    />
  );
}

function QueuedAssetUpload({
  dialogTitle, onClose, initialFiles, compression, onBusyChange, onFilesAdded,
  fields, className, singleFile, onSubmit, onError, group
}: QueuedUploadProps) {
  const titleId = useId();
  const [compress, setCompress] = useState(true);
  const compressImages = compression?.checked ?? compress;
  const prep = usePreparedUploadFiles(compressImages);
  const { setFiles, summary } = prep;
  const submission = useUploadSubmission(onBusyChange);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const listing = useListingWorkbenchUpload(prep.items, group);
  const { busy, progress, running } = submission;

  useEffect(() => {
    if (initialFiles) setFiles(initialFiles);
  }, [initialFiles, setFiles]);

  const run = (retryIds?: string[]) => submission.run(async (reportProgress) => {
    if (group) {
      await listing.submit(group, compressImages, reportProgress, retryIds);
      return;
    }
    setError(null);
    const options: PreparedUploadOptions = {
      compressImages,
      preparedFiles: prep.preparedFiles,
      compressionSummary: summary.compressionSummary,
      onUploadProgress: reportProgress
    };
    reportProgress(initialUploadProgress(prep.preparedFiles.reduce((sum, file) => sum + file.upload.size, 0)));
    try {
      await onSubmit(prep.items.map((item) => item.originalFile), options);
      prep.clear();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : singleFile ? "上传新版本失败" : "上传素材失败";
      if (onError) onError(message);
      else setError(message);
    }
  });

  const close = () => {
    if (!running.current) onClose?.();
  };
  const queueLocked = busy || listing.started;
  const submitLabel = singleFile ? "提交新版本" : group ? "上传并加入图组" : `开始上传 (${prep.items.length})`;
  const content = (
    <div className={className ?? "space-y-3.5 p-5 text-xs"}>
      {!singleFile && fields?.(busy)}
      {group && <p className="text-xs text-gray-600">确认新增图片的顺序。上传成功的图片会关联当前商品并一次加入图组。</p>}
      {!listing.started && (
        <div className="space-y-2">
          <ImageCompressionSwitch checked={compressImages} onChange={compression?.onChange ?? setCompress} disabled={busy} />
          <FileDropButton
            multiple={!singleFile}
            disabled={busy}
            onFiles={(files) => {
              if (running.current) return;
              if (singleFile && files.length > 1) {
                setFileError("每次只能上传一个版本文件，请重新选择或拖入单个文件。");
                return;
              }
              if (singleFile) prep.setFiles(files);
              else prep.addFiles(files);
              setFileError(null);
              setError(null);
              onFilesAdded?.();
            }}
            className={singleFile ? "flex items-center justify-center gap-1.5 px-2 py-2 font-medium" : "flex flex-col items-center justify-center px-4 py-6"}
          >
            {singleFile ? (
              <><Upload className="h-3.5 w-3.5" /><span>拖入单个文件，或点击选择</span></>
            ) : (
              <>
                <Upload className="h-6 w-6 text-gray-400" />
                <span className="mt-1.5 font-medium text-gray-700">拖入文件，或点击选择</span>
                <span className="mt-0.5 text-[11px] text-gray-400">支持多文件批量上传，相同底层文件自动基于 SHA-256 去重</span>
              </>
            )}
          </FileDropButton>
        </div>
      )}
      {(fileError || error) && <p role="alert" className="text-rose-700">{fileError || error}</p>}
      {compressImages && summary.compressibleCount > 0 && (!singleFile || summary.isCompressing) && (
        <CompressionProgressPanel
          compact={singleFile}
          completed={summary.completedCount}
          total={summary.compressibleCount}
          percent={summary.percent}
          isCompressing={summary.isCompressing}
          originalBytes={summary.originalBytes}
          compressedBytes={summary.compressedBytes}
          savedBytes={summary.savedBytes}
          savedPercent={summary.savedPercent}
          unchangedImages={summary.unchangedImages}
        />
      )}
      <PreparedUploadList
        items={group ? listing.items : prep.items}
        compressEnabled={compressImages}
        disabled={queueLocked}
        onRemove={prep.removeFile}
        renderDetails={group ? (item, index, status) => (
          <ListingUploadRow
            item={item}
            index={index}
            length={listing.items.length}
            status={status}
            result={listing.results[item.id]}
            editable={!queueLocked}
            busy={busy}
            isCarousel={group.kind === "carousel"}
            main={listing.main}
            onMain={listing.setMain}
            onMove={listing.move}
            onRetry={() => void run([item.id])}
          />
        ) : undefined}
      />
      {progress && <UploadTransferProgressPanel compact={singleFile} progress={progress} label={singleFile ? "正在上传新版本…" : "正在上传素材…"} />}
      {busy && listing.started && !progress && <p role="status" className="text-blue-700">正在保存素材组…</p>}
      {listing.bindingError && <p role="alert" className="text-rose-700">{listing.bindingError}。已上传的文件可直接重试绑定。</p>}
      {singleFile && fields?.(busy)}
      {(singleFile || onClose || prep.items.length > 0) && (
        <div className={singleFile ? "" : "flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-3"}>
          {!singleFile && !listing.started && prep.items.length > 0 && (
            <button type="button" disabled={busy} onClick={prep.clear} className="mr-auto rounded-lg border border-gray-200 px-3 py-2 font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              清空队列
            </button>
          )}
          {!listing.started && listing.main && listing.items.some((item) => item.id === listing.main) && (
            <button type="button" onClick={() => listing.setMain(null)} className="text-gray-600">取消指定主图</button>
          )}
          {onClose && (
            <button type="button" disabled={busy} onClick={close} className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {listing.done ? "完成" : listing.started ? "关闭" : "取消"}
            </button>
          )}
          {!listing.started && (
            <button
              type="button"
              disabled={busy || !!fileError || prep.items.length === 0 || summary.isCompressing}
              onClick={() => void run()}
              className={`rounded-lg bg-blue-600 font-medium text-white hover:bg-blue-700 disabled:opacity-50 ${singleFile ? "w-full px-2.5 py-1.5" : "px-4 py-2"}`}
            >
              {summary.isCompressing
                ? singleFile ? "正在压缩图片…" : `正在压缩 (${summary.completedCount}/${summary.compressibleCount})…`
                : busy
                  ? progress?.phase === "processing" ? "服务器处理中…" : `${singleFile ? "上传新版本" : "上传中"} ${progress?.percent ?? 0}%`
                  : submitLabel}
            </button>
          )}
          {listing.bindingError && (
            <button type="button" disabled={busy} onClick={() => void run([])} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              仅重试绑定
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (!dialogTitle) return content;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl ${group ? "max-w-2xl" : "max-w-lg"}`}>
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <h2 id={titleId} className="text-sm font-semibold text-gray-900">{dialogTitle}</h2>
          <button type="button" aria-label="关闭上传" disabled={busy} onClick={close} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">{content}</div>
      </section>
    </div>
  );
}
