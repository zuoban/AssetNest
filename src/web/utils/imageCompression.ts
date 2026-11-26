const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TIME_BUDGET_MS = 5000;

export function isCompressibleImageFile(file: File): boolean {
  const png = file.type === "image/png" && /\.png$/i.test(file.name);
  const jpeg = file.type === "image/jpeg" && /\.jpe?g$/i.test(file.name);
  return (png || jpeg) && file.size > 0 && file.size <= MAX_FILE_BYTES;
}

export interface CompressImageOptions {
  signal?: AbortSignal;
}

export async function compressImageForUpload(
  file: File,
  options?: CompressImageOptions
): Promise<File> {
  const signal = options?.signal;
  if (signal?.aborted || !isCompressibleImageFile(file)) return file;

  try {
    const worker = new Worker(new URL("./imageCompression.worker.ts", import.meta.url), {
      type: "module"
    });
    let terminated = false;
    const terminateWorker = () => {
      if (!terminated) {
        terminated = true;
        worker.terminate();
      }
    };

    const compressed = await new Promise<Blob | null>((resolve) => {
      let settled = false;
      const onAbort = () => {
        terminateWorker();
        finish(null);
      };
      // Terminating the worker also interrupts synchronous WASM work on slow devices.
      const finish = (result: Blob | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), TIME_BUDGET_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.onmessage = (event: MessageEvent<Blob | null>) => finish(event.data);
      worker.onerror = () => finish(null);
      worker.onmessageerror = () => finish(null);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        worker.postMessage(file);
      } catch {
        finish(null);
      }
    }).finally(() => terminateWorker());

    if (
      signal?.aborted ||
      !compressed ||
      compressed.type !== file.type ||
      !compressed.size ||
      compressed.size >= file.size
    ) {
      return file;
    }
    return new File([compressed], file.name, {
      type: file.type,
      lastModified: file.lastModified
    });
  } catch {
    return file;
  }
}
