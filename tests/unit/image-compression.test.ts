import { afterEach, describe, expect, it, vi } from "vitest";
import { compressImageForUpload } from "../../src/web/utils/imageCompression";

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
});
