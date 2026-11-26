import init, { compress_png } from "wasm-imagequant";
import wasmUrl from "wasm-imagequant/wasm_imagequant_bg.wasm?url";

const MAX_PIXELS = 12_000_000;
const JPEG_QUALITY = 0.85;

function pngHeader(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (view.byteLength < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null; // IHDR

  let hasTransparency = false;
  for (let offset = 33; offset + 12 <= view.byteLength;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const next = offset + 12 + length;
    if (next > view.byteLength) return null;
    if (type === 0x6163544c || type === 0x6663544c || type === 0x66644154) return null; // APNG
    if (type === 0x74524e53) hasTransparency = length > 0; // tRNS
    if (type === 0x49454e44 && length === 0 && next === view.byteLength) {
      return {
        width: view.getUint32(16), height: view.getUint32(20), colorType: view.getUint8(25), hasTransparency
      };
    }
    offset = next;
  }
  return null;
}

function jpegDimensions(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let dimensions: { width: number; height: number } | null = null;
  for (let offset = 2; offset + 4 <= view.byteLength;) {
    if (view.getUint8(offset++) !== 0xff) return null;
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
    if (offset + 3 > view.byteLength) return null;
    const marker = view.getUint8(offset++);
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) return null;
    if (marker === 0xda) return dimensions; // Start of scan
    if (marker === 0xe2 && length >= 6 && view.getUint32(offset + 2) === 0x4d504600) return null; // MPO
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return null;
      dimensions = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += length;
  }
  return null;
}

async function quantizePng(context: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  await init({ module_or_path: wasmUrl });
  const { data } = context.getImageData(0, 0, width, height);
  // Keep the full RGBA palette and use error diffusion to reduce banding in gradients.
  const result = compress_png(new Uint8Array(data.buffer), width, height, 256, 0.85);
  try {
    const bytes = new Uint8Array(result.data);
    const header = pngHeader(bytes.buffer);
    if (header?.width !== width || header.height !== height || header.colorType !== 3) return null;
    if (!header.hasTransparency) {
      for (let alpha = 3; alpha < data.length; alpha += 4) {
        if (data[alpha] !== 255) return null;
      }
    }
    return new Blob([bytes], { type: "image/png" });
  } finally {
    result.free();
  }
}

async function encodeImage(file: File): Promise<Blob | null> {
  const isPng = file.type === "image/png";
  const bytes = await file.arrayBuffer();
  const dimensions = isPng ? pngHeader(bytes) : jpegDimensions(bytes);
  if (!dimensions || !dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_PIXELS) {
    return null;
  }

  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = image;
  try {
    const sameDimensions = width === dimensions.width && height === dimensions.height;
    const swappedDimensions = width === dimensions.height && height === dimensions.width;
    if (!sameDimensions && !swappedDimensions) return null;

    // The oriented bitmap determines the canvas geometry, including EXIF rotations that swap the axes.
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: isPng });
    if (!context) return null;
    context.drawImage(image, 0, 0);
    if (isPng) return await quantizePng(context, width, height);

    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    if (jpeg.type !== file.type || jpeg.size >= file.size) return null;
    const output = jpegDimensions(await jpeg.arrayBuffer());
    return output?.width === width && output.height === height ? jpeg : null;
  } finally {
    image.close();
  }
}

self.onmessage = async (event: MessageEvent<File>) => {
  const result = await encodeImage(event.data).catch(() => null);
  self.postMessage(result);
};
