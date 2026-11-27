import { useEffect, useState } from "react";
import { api } from "../api/client";
import { initialUploadProgress, type ReportUploadProgress } from "../hooks/useUploadSubmission";
import type { PreparedUploadItem } from "../utils/uploadPreparation";

export interface ListingUploadGroup {
  kind: "carousel" | "detail";
  productId: string;
  onBind: (versions: string[], mainVersion?: string) => Promise<void>;
}

type UploadResult = {
  versionId?: string;
  bound?: boolean;
  invalid?: boolean;
  error?: string;
  progress?: string;
};

export function useListingWorkbenchUpload(queue: PreparedUploadItem[], group?: ListingUploadGroup) {
  const [order, setOrder] = useState<string[]>([]);
  const [main, setMain] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [results, setResults] = useState<Record<string, UploadResult>>({});
  const [bindingError, setBindingError] = useState<string | null>(null);
  const byId = new Map(queue.map((item) => [item.id, item]));
  const items = group ? [
    ...order.flatMap((id) => {
      const item = byId.get(id);
      if (!item) return [];
      byId.delete(id);
      return [item];
    }),
    ...byId.values()
  ] : queue;

  const update = (id: string, patch: UploadResult) => {
    setResults((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };

  const move = (index: number, offset: number) => {
    const next = items.map((item) => item.id);
    const neighbor = index + offset;
    const currentId = next[index];
    const neighborId = next[neighbor];
    if (!currentId || !neighborId) return;
    next[index] = neighborId;
    next[neighbor] = currentId;
    setOrder(next);
  };

  const submit = async (
    target: ListingUploadGroup,
    compressImages: boolean,
    reportProgress: ReportUploadProgress,
    retryIds?: string[]
  ) => {
    setStarted(true);
    setBindingError(null);
    const versions = new Map(Object.entries(results).flatMap(([id, result]) => result.versionId ? [[id, result.versionId]] : []));
    for (const { id, originalFile, uploadFile } of items) {
      if (retryIds && !retryIds.includes(id)) continue;
      update(id, { error: undefined, progress: "正在上传" });
      reportProgress(initialUploadProgress(uploadFile.size));
      try {
        const result = await api.uploadAssets([originalFile], {
          productId: target.productId,
          compressImages,
          preparedFiles: [{ original: originalFile, upload: uploadFile }],
          onUploadProgress: (progress) => {
            reportProgress(progress);
            update(id, { progress: progress.phase === "processing" ? "正在处理" : `正在上传 ${progress.percent}%` });
          }
        });
        const asset = result.items[0];
        if (!asset?.currentVersionId) throw new Error("上传响应缺少素材版本");
        if (asset.assetType !== "image") {
          update(id, { invalid: true, error: "素材已上传，但图片组仅接受图片", progress: undefined });
          continue;
        }
        versions.set(id, asset.currentVersionId);
        update(id, { versionId: asset.currentVersionId, progress: undefined });
      } catch (error) {
        update(id, { error: error instanceof Error ? error.message : "上传失败", progress: undefined });
      }
    }
    const ready = items.filter(({ id }) => !results[id]?.bound && versions.has(id));
    if (ready.length === 0) return;
    reportProgress(null);
    try {
      // Keep already bound versions in the order so a retry restores the chosen position.
      await target.onBind(items.flatMap(({ id }) => {
        const version = versions.get(id);
        return version ? [version] : [];
      }), main ? versions.get(main) : undefined);
      ready.forEach(({ id }) => update(id, { bound: true }));
    } catch (error) {
      setBindingError(error instanceof Error ? error.message : "素材组绑定失败");
    }
  };

  const done = started && items.every((item) => results[item.id]?.bound);
  return { items, main, setMain, started, results, bindingError, move, submit, done };
}

interface RowProps {
  item: PreparedUploadItem;
  index: number;
  length: number;
  status: { text: string; toneClass: string };
  result?: UploadResult;
  editable: boolean;
  busy: boolean;
  isCarousel: boolean;
  main: string | null;
  onMain: (id: string) => void;
  onMove: (index: number, offset: number) => void;
  onRetry: () => void;
}

export function ListingUploadRow({ item, index, length, status, result, editable, busy, isCarousel, main, onMain, onMove, onRetry }: RowProps) {
  const [preview, setPreview] = useState("");
  const file = item.originalFile;
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <>
      {preview && <img src={preview} alt="" className="h-12 w-12 rounded bg-gray-100 object-contain" />}
      <div className="min-w-0 flex-1">
        <p className="break-all font-medium">{index + 1}. {file.name}</p>
        <p aria-live="polite" className={result?.error ? "text-rose-700" : status.toneClass}>
          {result?.error ?? result?.progress ?? (result?.bound ? "已加入图组" : result?.versionId ? "已上传，待绑定" : status.text)}
        </p>
      </div>
      {editable && (
        <>
          <button type="button" aria-label={`上移 ${file.name}`} disabled={index === 0} onClick={() => onMove(index, -1)} className="px-1 text-blue-700 disabled:opacity-30">↑</button>
          <button type="button" aria-label={`下移 ${file.name}`} disabled={index === length - 1} onClick={() => onMove(index, 1)} className="px-1 text-blue-700 disabled:opacity-30">↓</button>
          {isCarousel && <label><input type="radio" name="upload-main" checked={main === item.id} onChange={() => onMain(item.id)} /> 设为主图</label>}
        </>
      )}
      {result?.error && !result.invalid && <button type="button" disabled={busy} onClick={onRetry} className="text-blue-700 disabled:opacity-40">重试此文件</button>}
    </>
  );
}
