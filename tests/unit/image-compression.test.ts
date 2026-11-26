import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compressImageForUpload,
  isCompressibleImageFile
} from "../../src/web/utils/imageCompression";

function mockWorker(result?: Blob | null) {
  const worker = {
    onmessage: null as ((event: { data: Blob | null }) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: vi.fn(() => {
      if (result !== undefined) worker.onmessage?.({ data: result });
    }),
    terminate: vi.fn()
  };
  const createWorker = vi.fn(() => worker);
  vi.stubGlobal("Worker", createWorker);
  return { worker, createWorker };
}

const pngFile = () => new File([new Uint8Array(1024)], "sku.PNG", { type: "image/png", lastModified: 1234 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("compressImageForUpload", () => {
  it("uses a smaller PNG even for files below the old minimum and keeps file metadata", async () => {
    const { worker } = mockWorker(new Blob([new Uint8Array(1023)], { type: "image/png" }));
    const file = pngFile();
    expect(await compressImageForUpload(file)).toMatchObject({
      size: 1023, name: file.name, type: file.type, lastModified: file.lastModified
    });
    expect(worker.postMessage).toHaveBeenCalledWith(file);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    new Blob([], { type: "image/png" }),
    new Blob([new Uint8Array(1024)], { type: "image/png" }),
    new Blob([new Uint8Array(2048)], { type: "image/png" }),
    new Blob(["wrong format"], { type: "image/jpeg" })
  ])("uses the original when compression yields an unusable result (%s)", async (result) => {
    const { worker } = mockWorker(result);
    const file = pngFile();
    expect(await compressImageForUpload(file)).toBe(file);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("stops the worker at the time budget and uses the original", async () => {
    vi.useFakeTimers();
    const { worker } = mockWorker();
    const file = pngFile();
    const upload = compressImageForUpload(file);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await upload).toBe(file);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("uses the original if the worker fails to load", async () => {
    const { worker } = mockWorker();
    const file = pngFile();
    const upload = compressImageForUpload(file);
    worker.onerror?.();
    expect(await upload).toBe(file);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("skips unsupported types, inconsistent extensions, and files over the byte budget", async () => {
    const { createWorker } = mockWorker();
    const files = [
      new File(["gif"], "motion.gif", { type: "image/gif" }),
      new File(["png"], "wrong.jpg", { type: "image/png" }),
      new File([new Uint8Array(32 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" })
    ];
    for (const file of files) expect(await compressImageForUpload(file)).toBe(file);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("returns original immediately without spawning a worker when signal is already aborted", async () => {
    const { createWorker } = mockWorker(new Blob([new Uint8Array(512)], { type: "image/png" }));
    const controller = new AbortController();
    controller.abort();
    const file = pngFile();

    expect(await compressImageForUpload(file, { signal: controller.signal })).toBe(file);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("immediately terminates the worker and returns original when aborted in flight", async () => {
    vi.useFakeTimers();
    const { worker } = mockWorker();
    const controller = new AbortController();
    const file = pngFile();

    const upload = compressImageForUpload(file, { signal: controller.signal });
    expect(worker.postMessage).toHaveBeenCalledWith(file);
    expect(worker.terminate).not.toHaveBeenCalled();

    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(await upload).toBe(file);

    // Ensure cleared timer does not terminate again or throw later
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("isCompressibleImageFile", () => {
  it("accepts PNG and JPEG files with matching extension within byte budget", () => {
    expect(isCompressibleImageFile(pngFile())).toBe(true);
    expect(
      isCompressibleImageFile(new File([new Uint8Array(64)], "photo.jpeg", { type: "image/jpeg" }))
    ).toBe(true);
    expect(
      isCompressibleImageFile(new File([new Uint8Array(64)], "PHOTO.JPG", { type: "image/jpeg" }))
    ).toBe(true);
  });

  it("rejects non-PNG/JPEG formats, mismatched extensions, empty files, and oversized files", () => {
    expect(isCompressibleImageFile(new File(["gif"], "a.gif", { type: "image/gif" }))).toBe(false);
    expect(isCompressibleImageFile(new File(["pdf"], "a.pdf", { type: "application/pdf" }))).toBe(false);
    expect(isCompressibleImageFile(new File(["mp4"], "a.mp4", { type: "video/mp4" }))).toBe(false);
    expect(isCompressibleImageFile(new File(["png"], "a.jpg", { type: "image/png" }))).toBe(false);
    expect(isCompressibleImageFile(new File([], "empty.png", { type: "image/png" }))).toBe(false);
    expect(
      isCompressibleImageFile(
        new File([new Uint8Array(32 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" })
      )
    ).toBe(false);
  });
});
