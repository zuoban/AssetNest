import {
  compressImageForUpload,
  isCompressibleImageFile,
  type CompressImageOptions
} from "./imageCompression";

export interface ImageUploadSizes {
  originalBytes: number;
  uploadedBytes: number;
  unchangedImages: number;
}

export interface PreparedUploadFile {
  original: File;
  upload: File;
}

export interface CompressionBatchProgress {
  completed: number;
  total: number;
  percent: number;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  savedPercent: number;
  unchangedImages: number;
}

export type PreparedUploadStatus =
  | "idle"
  | "queued"
  | "compressing"
  | "compressed"
  | "unchanged"
  | "skipped";

export interface PreparedUploadItem {
  id: string;
  originalFile: File;
  uploadFile: File;
  compressedFile?: File;
  status: PreparedUploadStatus;
}

export interface PreparedUploadSummary {
  totalFiles: number;
  compressibleCount: number;
  completedCount: number;
  compressingCount: number;
  queuedCount: number;
  skippedCount: number;
  percent: number;
  isCompressing: boolean;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  savedPercent: number;
  unchangedImages: number;
  compressionSummary: ImageUploadSizes | null;
}

export interface PreparedUploadSnapshot {
  items: PreparedUploadItem[];
  compressEnabled: boolean;
  summary: PreparedUploadSummary;
}

export type ImageCompressorFn = (file: File, options?: CompressImageOptions) => Promise<File>;

export const DEFAULT_COMPRESSION_CONCURRENCY = 2;

export function computeImageUploadSizes(
  preparedFiles: PreparedUploadFile[]
): ImageUploadSizes | null {
  let sizes: ImageUploadSizes | null = null;
  for (const { original, upload } of preparedFiles) {
    if (!isCompressibleImageFile(original)) continue;
    sizes ??= { originalBytes: 0, uploadedBytes: 0, unchangedImages: 0 };
    sizes.originalBytes += original.size;
    sizes.uploadedBytes += upload.size;
    if (upload.size >= original.size) {
      sizes.unchangedImages += 1;
    }
  }
  return sizes;
}

export async function compressFilesWithProgress(
  files: File[],
  options: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (progress: CompressionBatchProgress) => void;
    compressor?: ImageCompressorFn;
  } = {}
): Promise<{ prepared: PreparedUploadFile[]; compression: ImageUploadSizes | null }> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_COMPRESSION_CONCURRENCY);
  const compressor = options.compressor ?? compressImageForUpload;
  const prepared: PreparedUploadFile[] = files.map((file) => ({ original: file, upload: file }));
  const compressibleIndices: number[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file && isCompressibleImageFile(file)) {
      compressibleIndices.push(i);
    }
  }

  if (compressibleIndices.length === 0) {
    return { prepared, compression: null };
  }

  const total = compressibleIndices.length;
  let completed = 0;
  let originalBytes = 0;
  let compressedBytes = 0;
  let unchangedImages = 0;

  const emitProgress = () => {
    const savedBytes = Math.max(0, originalBytes - compressedBytes);
    const savedPercent = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;
    options.onProgress?.({
      completed,
      total,
      percent: Math.round((completed / total) * 100),
      originalBytes,
      compressedBytes,
      savedBytes,
      savedPercent,
      unchangedImages
    });
  };

  emitProgress();

  let cursor = 0;
  const workerCount = Math.min(concurrency, total);

  const runWorker = async () => {
    while (cursor < total) {
      if (options.signal?.aborted) break;
      const index = compressibleIndices[cursor];
      cursor += 1;
      if (index === undefined) break;
      const original = files[index];
      if (!original) continue;
      let upload = original;
      try {
        upload = await compressor(original, { signal: options.signal });
      } catch {
        upload = original;
      }
      prepared[index] = { original, upload };
      completed += 1;
      originalBytes += original.size;
      compressedBytes += upload.size;
      if (upload.size >= original.size) {
        unchangedImages += 1;
      }
      emitProgress();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    prepared,
    compression: {
      originalBytes,
      uploadedBytes: compressedBytes,
      unchangedImages
    }
  };
}

export class UploadPreparationController {
  private items: PreparedUploadItem[] = [];
  private compressEnabled: boolean;
  private readonly concurrency: number;
  private readonly compressor: ImageCompressorFn;
  private readonly cache = new WeakMap<File, File>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly listeners = new Set<(snapshot: PreparedUploadSnapshot) => void>();
  private nextId = 1;
  private disposed = false;

  constructor(options: {
    compressEnabled: boolean;
    concurrency?: number;
    compressor?: ImageCompressorFn;
  }) {
    this.compressEnabled = options.compressEnabled;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_COMPRESSION_CONCURRENCY);
    this.compressor = options.compressor ?? compressImageForUpload;
  }

  subscribe(listener: (snapshot: PreparedUploadSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PreparedUploadSnapshot {
    return {
      items: this.items.slice(),
      compressEnabled: this.compressEnabled,
      summary: this.computeSummary()
    };
  }

  setFiles(files: File[]): void {
    if (this.disposed) return;
    this.abortAll();
    this.items = files.map((file) => this.buildItem(file, `upload-file-${this.nextId++}`));
    this.emit();
    this.pump();
  }

  addFiles(files: File[]): void {
    if (this.disposed || files.length === 0) return;
    const appended = files.map((file) => this.buildItem(file, `upload-file-${this.nextId++}`));
    this.items = [...this.items, ...appended];
    this.emit();
    this.pump();
  }

  removeFile(id: string): void {
    if (this.disposed) return;
    const active = this.activeControllers.get(id);
    if (active) {
      this.activeControllers.delete(id);
      active.abort();
    }
    const nextItems = this.items.filter((item) => item.id !== id);
    if (nextItems.length === this.items.length) return;
    this.items = nextItems;
    this.emit();
    this.pump();
  }

  clear(): void {
    this.abortAll();
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  setCompressEnabled(enabled: boolean): void {
    if (this.disposed || this.compressEnabled === enabled) return;
    this.compressEnabled = enabled;

    if (!enabled) {
      this.abortAll();
      this.items = this.items.map((item) => ({
        ...item,
        uploadFile: item.originalFile,
        status: "idle"
      }));
      this.emit();
      return;
    }

    this.items = this.items.map((item) => this.buildItem(item.originalFile, item.id));
    this.emit();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.abortAll();
    this.listeners.clear();
  }

  private buildItem(originalFile: File, id: string): PreparedUploadItem {
    const cached = this.cache.get(originalFile);
    const cachedSmaller = cached && cached.size < originalFile.size ? cached : undefined;

    if (!this.compressEnabled) {
      return {
        id,
        originalFile,
        uploadFile: originalFile,
        compressedFile: cachedSmaller,
        status: "idle"
      };
    }

    if (!isCompressibleImageFile(originalFile)) {
      return {
        id,
        originalFile,
        uploadFile: originalFile,
        status: "skipped"
      };
    }

    if (cached !== undefined) {
      if (cachedSmaller) {
        return {
          id,
          originalFile,
          uploadFile: cachedSmaller,
          compressedFile: cachedSmaller,
          status: "compressed"
        };
      }
      return {
        id,
        originalFile,
        uploadFile: originalFile,
        status: "unchanged"
      };
    }

    return {
      id,
      originalFile,
      uploadFile: originalFile,
      status: "queued"
    };
  }

  private abortAll(): void {
    if (this.activeControllers.size === 0) return;
    const controllers = Array.from(this.activeControllers.values());
    this.activeControllers.clear();
    for (const controller of controllers) {
      controller.abort();
    }
  }

  private pump(): void {
    if (this.disposed || !this.compressEnabled) return;

    let startedAny = false;
    while (this.activeControllers.size < this.concurrency) {
      const idx = this.items.findIndex((item) => item.status === "queued");
      if (idx === -1) break;

      const item = this.items[idx];
      if (!item) break;
      const controller = new AbortController();
      this.activeControllers.set(item.id, controller);
      this.items = this.items.map((entry, entryIdx) =>
        entryIdx === idx ? { ...entry, status: "compressing" } : entry
      );
      startedAny = true;
      void this.runItemCompression(item.id, item.originalFile, controller);
    }

    if (startedAny) {
      this.emit();
    }
  }

  private async runItemCompression(
    id: string,
    originalFile: File,
    controller: AbortController
  ): Promise<void> {
    let result = originalFile;
    try {
      result = await this.compressor(originalFile, { signal: controller.signal });
    } catch {
      result = originalFile;
    }

    if (this.activeControllers.get(id) === controller) {
      this.activeControllers.delete(id);
    }

    if (this.disposed || controller.signal.aborted || !this.compressEnabled) {
      if (!this.disposed && this.compressEnabled) {
        this.pump();
      }
      return;
    }

    const idx = this.items.findIndex(
      (item) => item.id === id && item.originalFile === originalFile
    );
    if (idx === -1) {
      this.pump();
      return;
    }

    this.cache.set(originalFile, result);
    const shrank = result.size < originalFile.size;
    this.items = this.items.map((item, entryIdx) =>
      entryIdx === idx
        ? {
            ...item,
            uploadFile: shrank ? result : originalFile,
            compressedFile: shrank ? result : undefined,
            status: shrank ? "compressed" : "unchanged"
          }
        : item
    );
    this.emit();
    this.pump();
  }

  private computeSummary(): PreparedUploadSummary {
    const totalFiles = this.items.length;
    if (!this.compressEnabled) {
      return {
        totalFiles,
        compressibleCount: 0,
        completedCount: 0,
        compressingCount: 0,
        queuedCount: 0,
        skippedCount: 0,
        percent: 100,
        isCompressing: false,
        originalBytes: 0,
        compressedBytes: 0,
        savedBytes: 0,
        savedPercent: 0,
        unchangedImages: 0,
        compressionSummary: null
      };
    }

    let compressibleCount = 0;
    let completedCount = 0;
    let compressingCount = 0;
    let queuedCount = 0;
    let skippedCount = 0;
    let originalBytes = 0;
    let compressedBytes = 0;
    let unchangedImages = 0;

    for (const item of this.items) {
      if (item.status === "skipped") {
        skippedCount += 1;
        continue;
      }
      compressibleCount += 1;
      if (item.status === "queued") {
        queuedCount += 1;
      } else if (item.status === "compressing") {
        compressingCount += 1;
      } else if (item.status === "compressed" || item.status === "unchanged") {
        completedCount += 1;
        originalBytes += item.originalFile.size;
        compressedBytes += item.uploadFile.size;
        if (item.status === "unchanged") {
          unchangedImages += 1;
        }
      }
    }

    const savedBytes = Math.max(0, originalBytes - compressedBytes);
    const savedPercent = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;
    const isCompressing = queuedCount > 0 || compressingCount > 0;
    const percent =
      compressibleCount === 0 ? 100 : Math.round((completedCount / compressibleCount) * 100);

    return {
      totalFiles,
      compressibleCount,
      completedCount,
      compressingCount,
      queuedCount,
      skippedCount,
      percent,
      isCompressing,
      originalBytes,
      compressedBytes,
      savedBytes,
      savedPercent,
      unchangedImages,
      compressionSummary:
        completedCount > 0
          ? {
              originalBytes,
              uploadedBytes: compressedBytes,
              unchangedImages
            }
          : null
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
