import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiClientError,
  uploadFormJson,
  type CompressionBatchProgress,
  type UploadTransferProgress
} from "../../src/web/api/client";
import {
  compressFilesWithProgress,
  UploadPreparationController,
  type ImageCompressorFn
} from "../../src/web/utils/uploadPreparation";

function makeFile(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1000 });
}

interface DeferredTask {
  file: File;
  signal?: AbortSignal;
  resolve: (result: File) => void;
}

function createControlledCompressor() {
  const pending: DeferredTask[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: File[] = [];

  const compressor: ImageCompressorFn = vi.fn((file, options) => {
    calls.push(file);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);

    return new Promise<File>((resolve) => {
      let done = false;
      const finish = (result: File) => {
        if (done) return;
        done = true;
        inFlight -= 1;
        resolve(result);
      };
      if (options?.signal?.aborted) {
        finish(file);
        return;
      }
      options?.signal?.addEventListener("abort", () => finish(file), { once: true });
      pending.push({ file, signal: options?.signal, resolve: finish });
    });
  });

  return {
    compressor,
    pending,
    calls,
    getMaxInFlight: () => maxInFlight
  };
}

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];
  method = "";
  url = "";
  async = true;
  headers = new Map<string, string>();
  sentBody: FormData | null = null;
  status = 200;
  responseText = "{}";
  upload: {
    onloadstart: ((event: ProgressEvent) => void) | null;
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: ((event: ProgressEvent) => void) | null;
  } = {
    onloadstart: null,
    onprogress: null,
    onload: null
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string, async = true) {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: FormData) {
    this.sentBody = body;
  }
}

afterEach(() => {
  MockXMLHttpRequest.instances = [];
  vi.unstubAllGlobals();
});

describe("UploadPreparationController", () => {
  it("immediately compresses added files with concurrency 2, skips non-compressible files, and updates progress", async () => {
    const { compressor, pending, getMaxInFlight } = createControlledCompressor();
    const controller = new UploadPreparationController({
      compressEnabled: true,
      concurrency: 2,
      compressor
    });

    const f1 = makeFile("a.png", 1000, "image/png");
    const f2 = makeFile("b.jpg", 2000, "image/jpeg");
    const f3 = makeFile("c.png", 3000, "image/png");
    const pdf = makeFile("doc.pdf", 500, "application/pdf");

    controller.setFiles([f1, f2, f3, pdf]);

    let snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual([
      "compressing",
      "compressing",
      "queued",
      "skipped"
    ]);
    expect(snap.summary).toMatchObject({
      totalFiles: 4,
      compressibleCount: 3,
      completedCount: 0,
      compressingCount: 2,
      queuedCount: 1,
      skippedCount: 1,
      percent: 0,
      isCompressing: true
    });
    expect(getMaxInFlight()).toBe(2);

    // Finish f1 with smaller output
    const f1Small = makeFile("a.png", 300, "image/png");
    pending[0]!.resolve(f1Small);
    await Promise.resolve();
    await Promise.resolve();

    snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual([
      "compressed",
      "compressing",
      "compressing",
      "skipped"
    ]);
    expect(snap.items[0]!.uploadFile).toBe(f1Small);
    expect(snap.items[0]!.compressedFile).toBe(f1Small);
    expect(snap.summary).toMatchObject({
      completedCount: 1,
      percent: 33,
      isCompressing: true,
      originalBytes: 1000,
      compressedBytes: 300,
      savedBytes: 700
    });
    expect(getMaxInFlight()).toBe(2);

    // Finish f2 unchanged and f3 compressed
    pending[1]!.resolve(f2);
    const f3Small = makeFile("c.png", 1000, "image/png");
    pending[2]!.resolve(f3Small);
    await Promise.resolve();
    await Promise.resolve();

    snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual([
      "compressed",
      "unchanged",
      "compressed",
      "skipped"
    ]);
    expect(snap.summary).toMatchObject({
      completedCount: 3,
      compressibleCount: 3,
      percent: 100,
      isCompressing: false,
      originalBytes: 6000,
      compressedBytes: 3300,
      savedBytes: 2700,
      unchangedImages: 1,
      compressionSummary: {
        originalBytes: 6000,
        uploadedBytes: 3300,
        unchangedImages: 1
      }
    });
  });

  it("aborts in-flight work when switched off and reuses cache without re-running WASM when switched back on", async () => {
    const { compressor, pending, calls } = createControlledCompressor();
    const controller = new UploadPreparationController({
      compressEnabled: true,
      concurrency: 2,
      compressor
    });

    const f1 = makeFile("done.png", 1000, "image/png");
    const f2 = makeFile("same.png", 800, "image/png");
    const f3 = makeFile("inflight.png", 2000, "image/png");

    controller.setFiles([f1, f2, f3]);

    // Finish f1 (compressed) and f2 (unchanged); f3 starts compressing
    const f1Small = makeFile("done.png", 400, "image/png");
    pending[0]!.resolve(f1Small);
    pending[1]!.resolve(f2);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([f1, f2, f3]);
    expect(pending[2]!.signal?.aborted).toBe(false);

    // Toggle compression OFF while f3 is in flight
    controller.setCompressEnabled(false);
    expect(pending[2]!.signal?.aborted).toBe(true);

    let snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual(["idle", "idle", "idle"]);
    expect(snap.items.map((i) => i.uploadFile)).toEqual([f1, f2, f3]);
    expect(snap.items[0]!.compressedFile).toBe(f1Small);
    expect(snap.summary.compressionSummary).toBeNull();
    expect(snap.summary.isCompressing).toBe(false);

    // Toggle compression back ON: f1 & f2 use cache immediately; only f3 runs compressor again
    controller.setCompressEnabled(true);
    snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual(["compressed", "unchanged", "compressing"]);
    expect(snap.items[0]!.uploadFile).toBe(f1Small);
    expect(snap.items[1]!.uploadFile).toBe(f2);
    expect(calls).toEqual([f1, f2, f3, f3]);

    const f3Small = makeFile("inflight.png", 600, "image/png");
    pending[3]!.resolve(f3Small);
    await Promise.resolve();
    await Promise.resolve();

    snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual(["compressed", "unchanged", "compressed"]);
    expect(snap.items[2]!.uploadFile).toBe(f3Small);
  });

  it("aborts active worker on removeFile, clear, and dispose, and advances queued items", async () => {
    const { compressor, pending } = createControlledCompressor();
    const controller = new UploadPreparationController({
      compressEnabled: true,
      concurrency: 1,
      compressor
    });

    const f1 = makeFile("1.png", 1000, "image/png");
    const f2 = makeFile("2.png", 1000, "image/png");
    controller.setFiles([f1, f2]);

    const [firstItem] = controller.getSnapshot().items;
    expect(pending[0]!.signal?.aborted).toBe(false);

    controller.removeFile(firstItem!.id);
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(controller.getSnapshot().items).toHaveLength(1);
    expect(controller.getSnapshot().items[0]!.status).toBe("compressing");
    expect(pending[1]!.file).toBe(f2);

    controller.clear();
    expect(pending[1]!.signal?.aborted).toBe(true);
    expect(controller.getSnapshot().items).toHaveLength(0);

    controller.setFiles([f1]);
    expect(pending[2]!.signal?.aborted).toBe(false);
    controller.dispose();
    expect(pending[2]!.signal?.aborted).toBe(true);
  });

  it("appends files via addFiles without aborting existing compressed or in-flight items", async () => {
    const { compressor, pending, calls } = createControlledCompressor();
    const controller = new UploadPreparationController({
      compressEnabled: true,
      concurrency: 2,
      compressor
    });

    const f1 = makeFile("first.png", 1000, "image/png");
    const f2 = makeFile("second.png", 2000, "image/png");
    const f3 = makeFile("third.png", 1500, "image/png");

    controller.addFiles([f1, f2]);
    const f1Small = makeFile("first.png", 300, "image/png");
    pending[0]!.resolve(f1Small);
    await Promise.resolve();
    await Promise.resolve();

    expect(pending[1]!.signal?.aborted).toBe(false);

    controller.addFiles([]);
    controller.addFiles([f3]);

    // f1 stays compressed, f2 is NOT aborted, f3 starts compressing in the freed slot
    expect(pending[1]!.signal?.aborted).toBe(false);
    let snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.originalFile)).toEqual([f1, f2, f3]);
    expect(snap.items.map((i) => i.status)).toEqual(["compressed", "compressing", "compressing"]);
    expect(calls).toEqual([f1, f2, f3]);

    const f2Small = makeFile("second.png", 600, "image/png");
    const f3Small = makeFile("third.png", 500, "image/png");
    pending[1]!.resolve(f2Small);
    pending[2]!.resolve(f3Small);
    await Promise.resolve();
    await Promise.resolve();

    snap = controller.getSnapshot();
    expect(snap.items.map((i) => i.status)).toEqual(["compressed", "compressed", "compressed"]);
    expect(snap.summary).toMatchObject({
      totalFiles: 3,
      completedCount: 3,
      originalBytes: 4500,
      compressedBytes: 1400,
      savedBytes: 3100,
      isCompressing: false
    });
  });
});

describe("compressFilesWithProgress", () => {
  it("reports progress and preserves original file order", async () => {
    const f1 = makeFile("first.png", 1000, "image/png");
    const pdf = makeFile("doc.pdf", 500, "application/pdf");
    const f2 = makeFile("second.jpg", 2000, "image/jpeg");
    const progressEvents: CompressionBatchProgress[] = [];

    const { prepared, compression } = await compressFilesWithProgress([f1, pdf, f2], {
      concurrency: 2,
      onProgress: (p) => progressEvents.push(p),
      compressor: async (file) =>
        file === f1 ? makeFile("first.png", 400, "image/png") : file
    });

    expect(prepared.map((p) => p.original)).toEqual([f1, pdf, f2]);
    expect(prepared[0]!.upload.size).toBe(400);
    expect(prepared[1]!.upload).toBe(pdf);
    expect(prepared[2]!.upload).toBe(f2);
    expect(progressEvents[0]).toMatchObject({ completed: 0, total: 2, percent: 0 });
    expect(progressEvents[progressEvents.length - 1]).toMatchObject({
      completed: 2,
      total: 2,
      percent: 100,
      savedBytes: 600
    });
    expect(compression).toEqual({
      originalBytes: 3000,
      uploadedBytes: 2400,
      unchangedImages: 1
    });
  });
});

describe("uploadFormJson and api upload methods", () => {
  it("reports uploading and processing phases, sends X-AssetNest-Request, and omits Content-Type", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const events: UploadTransferProgress[] = [];
    const form = new FormData();
    form.append("files", makeFile("sku.png", 1000, "image/png"), "sku.png");

    const promise = uploadFormJson<{ ok: boolean }>(
      "/api/v1/assets/upload",
      form,
      (p) => events.push(p),
      1000
    );

    const xhr = MockXMLHttpRequest.instances[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/v1/assets/upload");
    expect(xhr.headers.get("X-AssetNest-Request")).toBe("1");
    expect(xhr.headers.has("Content-Type")).toBe(false);

    xhr.upload.onloadstart?.({ lengthComputable: true, loaded: 0, total: 1200 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 600, total: 1200 } as ProgressEvent);
    xhr.upload.onload?.({ lengthComputable: true, loaded: 1200, total: 1200 } as ProgressEvent);

    xhr.status = 200;
    xhr.responseText = JSON.stringify({ ok: true });
    xhr.onload?.();

    expect(await promise).toEqual({ ok: true });
    expect(events).toEqual([
      { loaded: 0, total: 1200, percent: 0, phase: "uploading" },
      { loaded: 600, total: 1200, percent: 50, phase: "uploading" },
      { loaded: 1200, total: 1200, percent: 100, phase: "processing" }
    ]);
  });

  it("parses API error responses into ApiClientError", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const promise = uploadFormJson("/api/v1/assets/upload", new FormData());
    const xhr = MockXMLHttpRequest.instances[0]!;
    xhr.status = 413;
    xhr.responseText = JSON.stringify({
      error: { code: "FILE_TOO_LARGE", message: "文件超过上传上限" }
    });
    xhr.onload?.();

    await expect(promise).rejects.toMatchObject({
      name: "ApiClientError",
      status: 413,
      code: "FILE_TOO_LARGE",
      message: "文件超过上传上限"
    });
    await expect(promise).rejects.toBeInstanceOf(ApiClientError);
  });

  it("skips re-compression when preparedFiles are passed to api.uploadAssets and api.appendAssetVersion", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const createWorker = vi.fn();
    vi.stubGlobal("Worker", createWorker);

    const original = makeFile("sku.png", 1600, "image/png");
    const compressed = makeFile("sku.png", 450, "image/png");
    const summary = { originalBytes: 1600, uploadedBytes: 450, unchangedImages: 0 };
    const uploadEvents: UploadTransferProgress[] = [];

    const uploadPromise = api.uploadAssets([original], {
      compressImages: true,
      preparedFiles: [{ original, upload: compressed }],
      compressionSummary: summary,
      onUploadProgress: (p) => uploadEvents.push(p)
    });

    await Promise.resolve();
    const xhr1 = MockXMLHttpRequest.instances[0]!;
    const sentFile1 = xhr1.sentBody?.get("files") as File;
    expect(sentFile1.size).toBe(450);
    expect(sentFile1.name).toBe("sku.png");

    xhr1.upload.onprogress?.({ lengthComputable: true, loaded: 450, total: 450 } as ProgressEvent);
    xhr1.upload.onload?.({ lengthComputable: true, loaded: 450, total: 450 } as ProgressEvent);
    xhr1.status = 200;
    xhr1.responseText = JSON.stringify({ items: [], uploadedCount: 1, deduplicatedCount: 0 });
    xhr1.onload?.();

    const uploadRes = await uploadPromise;
    expect(uploadRes.compression).toEqual(summary);
    expect(uploadEvents).toHaveLength(2);
    expect(createWorker).not.toHaveBeenCalled();

    // Also verify appendAssetVersion skips re-compression when preparedFiles are provided
    const versionPromise = api.appendAssetVersion("asset-1", original, {
      compressImages: true,
      preparedFiles: [{ original, upload: compressed }],
      compressionSummary: summary
    });

    await Promise.resolve();
    const xhr2 = MockXMLHttpRequest.instances[1]!;
    const sentFile2 = xhr2.sentBody?.get("file") as File;
    expect(sentFile2.size).toBe(450);
    expect(sentFile2.name).toBe("sku.png");

    xhr2.status = 200;
    xhr2.responseText = JSON.stringify({ asset: {}, version: { versionNo: 2 }, deduplicated: false });
    xhr2.onload?.();

    const versionRes = await versionPromise;
    expect(versionRes.compression).toEqual(summary);
    expect(createWorker).not.toHaveBeenCalled();
  });
});
