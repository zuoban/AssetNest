import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/server/http/errors.js";
import {
  parseHttpRange,
  stageMultipartFileToTemp,
  type MultipartFileStream
} from "../../src/server/modules/assets/routes.js";

describe("parseHttpRange", () => {
  it("parses valid byte ranges, open-ended ranges, clamped ends, and suffix ranges", () => {
    expect(parseHttpRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseHttpRange("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseHttpRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseHttpRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseHttpRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("rejects ranges on empty files and malformed/non-digit range values", () => {
    expect(parseHttpRange("bytes=-10", 0)).toBeNull();
    expect(parseHttpRange("bytes=0-0", 0)).toBeNull();
    expect(parseHttpRange("bytes=0-", 0)).toBeNull();
    expect(parseHttpRange("bytes=10abc-20", 100)).toBeNull();
    expect(parseHttpRange("bytes=0-20xyz", 100)).toBeNull();
    expect(parseHttpRange("bytes=-10abc", 100)).toBeNull();
    expect(parseHttpRange("bytes=0-10-20", 100)).toBeNull();
    expect(parseHttpRange("bytes=-0", 100)).toBeNull();
    expect(parseHttpRange("bytes=20-10", 100)).toBeNull();
    expect(parseHttpRange("bytes=100-120", 100)).toBeNull();
    expect(parseHttpRange("items=0-10", 100)).toBeNull();
    expect(parseHttpRange(undefined, 100)).toBeNull();
  });
});

describe("stageMultipartFileToTemp", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "assetnest-stage-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("stages stream content, computes SHA-256, and captures up to 8192 header bytes", async () => {
    const tempDir = await makeTempDir();
    const payload = Buffer.alloc(12_000, 0x61);
    const stream = Readable.from([payload.subarray(0, 5000), payload.subarray(5000)]) as MultipartFileStream;

    const staged = await stageMultipartFileToTemp(stream, {
      tempDir,
      originalFilename: "sample.bin",
      declaredMime: "application/octet-stream",
      maxFileBytes: 64 * 1024,
      maxFileSizeMB: 1
    });

    expect(staged.sizeBytes).toBe(payload.length);
    expect(staged.sha256).toBe(crypto.createHash("sha256").update(payload).digest("hex"));
    expect(staged.header.length).toBe(8192);
    expect(staged.header.equals(payload.subarray(0, 8192))).toBe(true);
    const onDisk = await fsp.readFile(staged.tempPath);
    expect(onDisk.equals(payload)).toBe(true);
  });

  it("rejects oversized stream with 413 and cleans up temp file", async () => {
    const tempDir = await makeTempDir();
    const stream = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]) as MultipartFileStream;

    await expect(
      stageMultipartFileToTemp(stream, {
        tempDir,
        originalFilename: "too-big.bin",
        declaredMime: "application/octet-stream",
        maxFileBytes: 1000,
        maxFileSizeMB: 1
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE"
    } satisfies Partial<AppError>);

    expect(await fsp.readdir(tempDir)).toEqual([]);
  });

  it("rejects truncated multipart stream with 413 and cleans up temp file", async () => {
    const tempDir = await makeTempDir();
    const stream = Readable.from([Buffer.from("partial")]) as MultipartFileStream;
    stream.truncated = true;

    await expect(
      stageMultipartFileToTemp(stream, {
        tempDir,
        originalFilename: "truncated.bin",
        declaredMime: "application/octet-stream",
        maxFileBytes: 1024,
        maxFileSizeMB: 1
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE"
    } satisfies Partial<AppError>);

    expect(await fsp.readdir(tempDir)).toEqual([]);
  });

  it("rejects cleanly when destination write stream fails under backpressure and cleans up temp file", async () => {
    const tempDir = await makeTempDir();
    const chunks = [Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32)];
    const stream = Readable.from(chunks) as MultipartFileStream;

    await expect(
      stageMultipartFileToTemp(stream, {
        tempDir,
        originalFilename: "disk-full.bin",
        declaredMime: "application/octet-stream",
        maxFileBytes: 1024,
        maxFileSizeMB: 1,
        createWriteStream: (tempPath) => {
          let writes = 0;
          return new Writable({
            highWaterMark: 16,
            async write(_chunk, _encoding, callback) {
              writes += 1;
              if (writes === 1) {
                await fsp.writeFile(tempPath, Buffer.from("partial"));
                callback();
                return;
              }
              const err = Object.assign(new Error("ENOSPC: no space left on device"), {
                code: "ENOSPC"
              });
              callback(err);
            }
          });
        }
      })
    ).rejects.toThrow("ENOSPC");

    expect(await fsp.readdir(tempDir)).toEqual([]);
  });
});
