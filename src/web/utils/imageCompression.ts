const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TIME_BUDGET_MS = 5000;

export async function compressImageForUpload(file: File): Promise<File> {
  const png = file.type === "image/png" && /\.png$/i.test(file.name);
  const jpeg = file.type === "image/jpeg" && /\.jpe?g$/i.test(file.name);
  if ((!png && !jpeg) || !file.size || file.size > MAX_FILE_BYTES) return file;

  try {
    const worker = new Worker(new URL("./imageCompression.worker.ts", import.meta.url), { type: "module" });
    const compressed = await new Promise<Blob | null>((resolve) => {
      // Terminating the worker also interrupts synchronous WASM work on slow devices.
      const finish = (result: Blob | null) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), TIME_BUDGET_MS);
      worker.onmessage = (event: MessageEvent<Blob | null>) => finish(event.data);
      worker.onerror = () => finish(null);
      worker.onmessageerror = () => finish(null);
      try {
        worker.postMessage(file);
      } catch {
        finish(null);
      }
    }).finally(() => worker.terminate());
    if (!compressed || compressed.type !== file.type || !compressed.size || compressed.size >= file.size) {
      return file;
    }
    return new File([compressed], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}
