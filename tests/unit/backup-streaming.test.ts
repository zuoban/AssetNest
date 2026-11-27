import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { getCurrentSchemaVersion } from "../../src/server/db/migrator.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";
import { ingestStagedFile, type StagedUploadFile } from "../../src/server/modules/assets/service.js";
import { executeBackupJob } from "../../src/server/modules/backups/service.js";
import {
  acquireJobLock,
  enqueueJob,
  releaseJobLock
} from "../../src/server/modules/jobs/service.js";
import { JobCancelledError, type JobContext } from "../../src/server/modules/jobs/worker.js";
import type { StorageGetOptions, StorageGetResult, StorageProvider } from "../../src/server/storage/types.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("failed to open zip"));
        return;
      }
      zipfile.on("error", reject);
      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (sErr, stream) => {
          if (sErr || !stream) {
            reject(sErr ?? new Error("failed to open zip entry stream"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.readEntry();
    });
  });
}

function wrapProvider(
  inner: StorageProvider,
  onGet: (
    key: string,
    options: StorageGetOptions | undefined,
    fallback: () => Promise<StorageGetResult>
  ) => Promise<StorageGetResult>
): StorageProvider {
  return {
    id: inner.id,
    name: inner.name,
    type: inner.type,
    capabilities: inner.capabilities,
    put(key, body, options) {
      return inner.put(key, body, options);
    },
    get(key, options) {
      return onGet(key, options, () => inner.get(key, options));
    },
    stat(key) {
      return inner.stat(key);
    },
    exists(key) {
      return inner.exists(key);
    },
    delete(key) {
      return inner.delete(key);
    },
    testConnection() {
      return inner.testConnection();
    }
  };
}

async function createStagedUpload(
  dir: string,
  filename: string,
  content: Buffer
): Promise<StagedUploadFile> {
  const tempPath = path.join(dir, `${crypto.randomUUID()}.upload`);
  await fsp.writeFile(tempPath, content);
  return {
    tempPath,
    originalFilename: filename,
    declaredMime: "application/pdf",
    sha256: sha256Hex(content),
    sizeBytes: content.length,
    header: content.subarray(0, 8192)
  };
}

function insertBackupRecord(runtime: AppRuntime, kind: "metadata" | "full"): string {
  const backupId = crypto.randomUUID();
  const now = new Date().toISOString();
  const schemaVersion = getCurrentSchemaVersion(runtime.db);
  runtime.db.raw
    .prepare(
      `INSERT INTO backups (
         id, kind, job_id, file_path, size_bytes, sha256,
         schema_version, file_count, status, last_error, created_at
       ) VALUES (?, ?, NULL, ?, 0, NULL, ?, 0, 'creating', NULL, ?)`
    )
    .run(backupId, kind, `${backupId}.zip`, schemaVersion, now);
  return backupId;
}

function createBackupJobContext(runtime: AppRuntime): {
  ctx: JobContext;
  abortController: AbortController;
  progressHistory: Array<{ stage?: string; current?: number; total?: number | null }>;
} {
  const job = enqueueJob(runtime.db, { type: "backup", payload: {} });
  const abortController = new AbortController();
  const progressHistory: Array<{ stage?: string; current?: number; total?: number | null }> = [];
  const ctx: JobContext = {
    jobId: job.id,
    type: "backup",
    attempts: 1,
    maxAttempts: 2,
    signal: abortController.signal,
    isCancelled: () => abortController.signal.aborted,
    throwIfCancelled: () => {
      if (abortController.signal.aborted) {
        throw new JobCancelledError();
      }
    },
    updateProgress: (update) => {
      progressHistory.push(update);
    },
    acquireLock: (key) => acquireJobLock(runtime.db, key, job.id),
    releaseLock: (key) => releaseJobLock(runtime.db, key, job.id)
  };
  return { ctx, abortController, progressHistory };
}

async function listDirSafe(dirPath: string): Promise<string[]> {
  if (!fs.existsSync(dirPath)) return [];
  return fsp.readdir(dirPath);
}

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];

async function makeRuntime(): Promise<{ runtime: AppRuntime; dir: string; actorUserId: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-backup-stream-"));
  tempDirs.push(dir);
  const dataDir = path.join(dir, "data");
  const config = loadConfig({
    cwd: dir,
    env: { ASSETNEST_DATA_DIR: dataDir }
  });
  const runtime = await createApp({
    config,
    acquireInstanceLock: false,
    logger: false
  });
  await runtime.worker.stop();
  runtimes.push(runtime);
  const user = runtime.db.raw.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  return { runtime, dir, actorUserId: user.id };
}

const defaultUploadOptions = {
  productIds: [],
  folderId: null,
  storageId: "local",
  purpose: "other",
  tagIds: [],
  source: "",
  sourceUrl: null,
  notes: "",
  promptText: ""
};

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Full backup streaming ZIP & exception stream cleanup", () => {
  it("streams files sequentially into the ZIP without writing per-file .part copies to uploads.tempDir", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();

    const payloads = [
      Buffer.from("%PDF-1.4\n" + "A".repeat(48 * 1024) + "\n%%EOF"),
      Buffer.from("%PDF-1.4\n" + "B".repeat(64 * 1024) + "\n%%EOF"),
      Buffer.from("%PDF-1.4\n" + "C".repeat(32 * 1024) + "\n%%EOF")
    ];

    for (let i = 0; i < payloads.length; i += 1) {
      await ingestStagedFile(
        runtime.db,
        runtime.config,
        runtime.storageRegistry,
        actorUserId,
        await createStagedUpload(dir, `doc-${i}.pdf`, payloads[i]!),
        defaultUploadOptions
      );
    }

    const baseProvider = runtime.storageRegistry.require("local");
    let inFlightReads = 0;
    let maxConcurrentReads = 0;
    const observedPartFilesDuringBackup: string[] = [];

    runtime.storageRegistry.register(
      wrapProvider(baseProvider, async (key, _opts, fallback) => {
        inFlightReads += 1;
        maxConcurrentReads = Math.max(maxConcurrentReads, inFlightReads);

        const tempFiles = await listDirSafe(runtime.config.uploads.tempDir);
        observedPartFilesDuringBackup.push(
          ...tempFiles.filter((name) => name.endsWith(".part") || name.startsWith("backup-file-"))
        );

        const res = await fallback();
        res.stream.once("close", () => {
          inFlightReads -= 1;
        });
        return res;
      })
    );

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx } = createBackupJobContext(runtime);

    const result = await executeBackupJob(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      "0.2.0",
      { backupId, kind: "full" },
      ctx
    );

    expect(result.fileCount).toBe(3);
    expect(maxConcurrentReads).toBe(1);
    expect(observedPartFilesDuringBackup).toEqual([]);

    // No temp snapshot or .part files left behind in uploads.tempDir
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);

    // Only final .zip file exists in backupsDir (no .zip.tmp remnants)
    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    const backupFiles = await listDirSafe(backupsDir);
    expect(backupFiles).toEqual([`${backupId}.zip`]);

    // Verify ZIP entries & manifest hashes
    const zipEntries = await readZipEntries(path.join(backupsDir, `${backupId}.zip`));
    expect(zipEntries.has("assetnest.db")).toBe(true);
    expect(zipEntries.has("manifest.json")).toBe(true);
    const manifest = JSON.parse(zipEntries.get("manifest.json")!.toString("utf8")) as {
      database: { sha256: string; sizeBytes: number };
      files: Array<{ zipPath: string; sha256: string; sizeBytes: number }>;
    };
    expect(manifest.files).toHaveLength(3);
    expect(sha256Hex(zipEntries.get("assetnest.db")!)).toBe(manifest.database.sha256);
    for (const fileEntry of manifest.files) {
      const archived = zipEntries.get(fileEntry.zipPath);
      expect(archived).toBeDefined();
      expect(archived!.length).toBe(fileEntry.sizeBytes);
      expect(sha256Hex(archived!)).toBe(fileEntry.sha256);
    }
  });

  it("aborts cleanly on SHA-256 mismatch without reading remaining files, leaking temp files, or causing unhandled rejections", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();

    const payloads = [
      Buffer.from("%PDF-1.4\nfirst-file-ok\n%%EOF"),
      Buffer.from("%PDF-1.4\nsecond-file-tampered\n%%EOF"),
      Buffer.from("%PDF-1.4\nthird-file-should-not-be-read\n%%EOF")
    ];
    for (let i = 0; i < payloads.length; i += 1) {
      await ingestStagedFile(
        runtime.db,
        runtime.config,
        runtime.storageRegistry,
        actorUserId,
        await createStagedUpload(dir, `sha-${i}.pdf`, payloads[i]!),
        defaultUploadOptions
      );
    }

    const orderedFiles = runtime.db.raw
      .prepare("SELECT id, object_key, size_bytes FROM files WHERE state = 'ready' ORDER BY storage_id ASC, object_key ASC")
      .all() as Array<{ id: string; object_key: string; size_bytes: number }>;
    expect(orderedFiles).toHaveLength(3);

    const fetchedKeys: string[] = [];
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, async (key, _opts, fallback) => {
        fetchedKeys.push(key);
        if (key === orderedFiles[1]!.object_key) {
          // Return same byte length with corrupted bytes so SHA-256 check fails after streaming
          const badBuf = Buffer.alloc(orderedFiles[1]!.size_bytes, 0x58);
          return {
            stream: Readable.from([badBuf]),
            contentLength: badBuf.length
          };
        }
        return fallback();
      })
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx } = createBackupJobContext(runtime);

    try {
      await expect(
        executeBackupJob(
          runtime.db,
          runtime.config,
          runtime.storageRegistry,
          "0.2.0",
          { backupId, kind: "full" },
          ctx
        )
      ).rejects.toThrow(/完整备份完整性校验失败/);

      // Wait a couple ticks to ensure no delayed unhandled rejections fire from torn-down streams
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // File #3 must never have been requested after File #2 failed
    expect(fetchedKeys).toEqual([orderedFiles[0]!.object_key, orderedFiles[1]!.object_key]);

    const backupRow = runtime.db.raw
      .prepare("SELECT status, last_error FROM backups WHERE id = ?")
      .get(backupId) as { status: string; last_error: string | null };
    expect(backupRow.status).toBe("failed");
    expect(backupRow.last_error).toMatch(/完整备份完整性校验失败/);

    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    expect(await listDirSafe(backupsDir)).toEqual([]);
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);
  });

  it("destroys active streams and removes partial temp ZIP when a storage read stream errors mid-transfer", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();

    for (let i = 0; i < 2; i += 1) {
      await ingestStagedFile(
        runtime.db,
        runtime.config,
        runtime.storageRegistry,
        actorUserId,
        await createStagedUpload(dir, `stream-err-${i}.pdf`, Buffer.from(`%PDF-1.4\nfile-${i}-${"Z".repeat(2048)}\n%%EOF`)),
        defaultUploadOptions
      );
    }

    const orderedFiles = runtime.db.raw
      .prepare("SELECT id, object_key FROM files WHERE state = 'ready' ORDER BY storage_id ASC, object_key ASC")
      .all() as Array<{ id: string; object_key: string }>;

    const fetchedKeys: string[] = [];
    let erroredStreamDestroyed = false;
    const baseProvider = runtime.storageRegistry.require("local");

    runtime.storageRegistry.register(
      wrapProvider(baseProvider, async (key, _opts, fallback) => {
        fetchedKeys.push(key);
        if (key === orderedFiles[0]!.object_key) {
          let emittedFirstChunk = false;
          const failingStream = new Readable({
            read() {
              if (!emittedFirstChunk) {
                emittedFirstChunk = true;
                this.push(Buffer.from("%PDF-1.4\npartial-chunk"));
              } else {
                this.destroy(new Error("Simulated mid-stream S3 disconnect"));
              }
            }
          });
          failingStream.once("close", () => {
            erroredStreamDestroyed = true;
          });
          return { stream: failingStream };
        }
        return fallback();
      })
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx } = createBackupJobContext(runtime);

    try {
      await expect(
        executeBackupJob(
          runtime.db,
          runtime.config,
          runtime.storageRegistry,
          "0.2.0",
          { backupId, kind: "full" },
          ctx
        )
      ).rejects.toThrow(/Simulated mid-stream S3 disconnect/);

      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(erroredStreamDestroyed).toBe(true);
    expect(fetchedKeys).toEqual([orderedFiles[0]!.object_key]);

    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    expect(await listDirSafe(backupsDir)).toEqual([]);
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);
  });

  it("aborts in-flight storage read, destroys active stream, and cleans temp files when job is cancelled mid-backup", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();

    for (let i = 0; i < 2; i += 1) {
      await ingestStagedFile(
        runtime.db,
        runtime.config,
        runtime.storageRegistry,
        actorUserId,
        await createStagedUpload(dir, `cancel-${i}.pdf`, Buffer.from(`%PDF-1.4\ncancel-file-${i}\n%%EOF`)),
        defaultUploadOptions
      );
    }

    const orderedFiles = runtime.db.raw
      .prepare("SELECT id, object_key FROM files WHERE state = 'ready' ORDER BY storage_id ASC, object_key ASC")
      .all() as Array<{ id: string; object_key: string }>;

    const streamStarted = createDeferred();
    let providerSignalAborted = false;
    let sourceStreamClosed = false;
    const fetchedKeys: string[] = [];

    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, async (key, options, fallback) => {
        fetchedKeys.push(key);
        if (key === orderedFiles[0]!.object_key) {
          options?.signal?.addEventListener("abort", () => {
            providerSignalAborted = true;
          });
          let sentFirst = false;
          const stalledStream = new Readable({
            read() {
              if (!sentFirst) {
                sentFirst = true;
                this.push(Buffer.from("%PDF-1.4\n"));
                streamStarted.resolve();
              }
              // Intentionally stall until destroyed by cancellation
            }
          });
          stalledStream.once("close", () => {
            sourceStreamClosed = true;
          });
          return { stream: stalledStream };
        }
        return fallback();
      })
    );

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx, abortController } = createBackupJobContext(runtime);

    const backupPromise = executeBackupJob(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      "0.2.0",
      { backupId, kind: "full" },
      ctx
    );

    await streamStarted.promise;
    abortController.abort();

    await expect(backupPromise).rejects.toBeInstanceOf(JobCancelledError);
    await new Promise((r) => setTimeout(r, 30));

    expect(providerSignalAborted).toBe(true);
    expect(sourceStreamClosed).toBe(true);
    expect(fetchedKeys).toEqual([orderedFiles[0]!.object_key]);

    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    expect(await listDirSafe(backupsDir)).toEqual([]);
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);
  });

  it("fails fast before creating temp ZIP when a referenced storage provider is offline and recovers cleanly on retry", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();

    await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      await createStagedUpload(dir, "offline-check.pdf", Buffer.from("%PDF-1.4\noffline-test\n%%EOF")),
      defaultUploadOptions
    );

    const baseProvider = runtime.storageRegistry.require("local");
    // Temporarily unregister 'local' to simulate missing/offline provider
    (runtime.storageRegistry as unknown as { providers: Map<string, StorageProvider> }).providers.delete("local");

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx: firstCtx } = createBackupJobContext(runtime);

    await expect(
      executeBackupJob(
        runtime.db,
        runtime.config,
        runtime.storageRegistry,
        "0.2.0",
        { backupId, kind: "full" },
        firstCtx
      )
    ).rejects.toThrow(/当前离线或缺少配置/);

    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    expect(await listDirSafe(backupsDir)).toEqual([]);
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);

    const failedRow = runtime.db.raw
      .prepare("SELECT status, last_error FROM backups WHERE id = ?")
      .get(backupId) as { status: string; last_error: string | null };
    expect(failedRow.status).toBe("failed");
    expect(failedRow.last_error).toMatch(/当前离线或缺少配置/);

    // Re-register provider and retry the same backupId -> should recover to 'ready'
    runtime.storageRegistry.register(baseProvider);
    const { ctx: retryCtx } = createBackupJobContext(runtime);
    const retryResult = await executeBackupJob(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      "0.2.0",
      { backupId, kind: "full" },
      retryCtx
    );
    expect(retryResult.fileCount).toBe(1);

    const readyRow = runtime.db.raw
      .prepare("SELECT status, last_error, file_count FROM backups WHERE id = ?")
      .get(backupId) as { status: string; last_error: string | null; file_count: number };
    expect(readyRow.status).toBe("ready");
    expect(readyRow.last_error).toBeNull();
    expect(readyRow.file_count).toBe(1);
    expect(await listDirSafe(backupsDir)).toEqual([`${backupId}.zip`]);
  });

  it("fails fast on oversized corrupted object stream without consuming remaining chunks", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    const original = Buffer.from("%PDF-1.4\nsmall-expected-payload\n%%EOF");
    await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      await createStagedUpload(dir, "small.pdf", original),
      defaultUploadOptions
    );

    let chunksEmitted = 0;
    let sourceClosed = false;
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, async () => {
        const oversized = new Readable({
          read() {
            chunksEmitted += 1;
            if (chunksEmitted <= 20) {
              this.push(Buffer.alloc(1024, 0x41));
            } else {
              this.push(null);
            }
          }
        });
        oversized.once("close", () => {
          sourceClosed = true;
        });
        return { stream: oversized };
      })
    );

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx } = createBackupJobContext(runtime);

    await expect(
      executeBackupJob(
        runtime.db,
        runtime.config,
        runtime.storageRegistry,
        "0.2.0",
        { backupId, kind: "full" },
        ctx
      )
    ).rejects.toThrow(/完整备份完整性校验失败/);

    await new Promise((r) => setTimeout(r, 20));
    expect(sourceClosed).toBe(true);
    expect(chunksEmitted).toBeLessThan(20);

    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    expect(await listDirSafe(backupsDir)).toEqual([]);
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);
  });

  it("tears down active input streams cleanly when the temp ZIP output writer fails", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      await createStagedUpload(dir, "writer-fail.pdf", Buffer.from("%PDF-1.4\nwriter-fail\n%%EOF")),
      defaultUploadOptions
    );

    const backupsDir = path.resolve(runtime.config.app.dataDir, "backups");
    await fsp.mkdir(backupsDir, { recursive: true });
    // Make backups directory read-only so creating tempZipPath fails on writer open
    await fsp.chmod(backupsDir, 0o555);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const backupId = insertBackupRecord(runtime, "full");
    const { ctx } = createBackupJobContext(runtime);

    try {
      await expect(
        executeBackupJob(
          runtime.db,
          runtime.config,
          runtime.storageRegistry,
          "0.2.0",
          { backupId, kind: "full" },
          ctx
        )
      ).rejects.toThrow();

      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await fsp.chmod(backupsDir, 0o755).catch(() => {});
    }

    expect(unhandled).toEqual([]);
    expect(await listDirSafe(backupsDir)).toEqual([]);
    expect(await listDirSafe(runtime.config.uploads.tempDir)).toEqual([]);

    const row = runtime.db.raw
      .prepare("SELECT status, last_error FROM backups WHERE id = ?")
      .get(backupId) as { status: string; last_error: string | null };
    expect(row.status).toBe("failed");
    expect(row.last_error).toBeTruthy();
  });
});
