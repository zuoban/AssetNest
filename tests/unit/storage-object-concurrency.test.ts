import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";
import {
  appendAssetVersion,
  ingestStagedFile,
  type StagedUploadFile
} from "../../src/server/modules/assets/service.js";
import {
  acquireJobLock,
  enqueueJob,
  releaseJobLock
} from "../../src/server/modules/jobs/service.js";
import { JobCancelledError, type JobContext } from "../../src/server/modules/jobs/worker.js";
import { executeStorageCleanupJob } from "../../src/server/modules/storage-ops/service.js";
import { executeGcJob } from "../../src/server/modules/trash/gc.js";
import { StorageRegistry } from "../../src/server/storage/registry.js";
import type { StorageProvider } from "../../src/server/storage/types.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wrapProvider(
  inner: StorageProvider,
  hooks: {
    beforeDelete?: (key: string) => Promise<void>;
    beforePut?: (key: string) => Promise<void>;
    beforeExists?: (key: string) => Promise<void>;
  }
): StorageProvider {
  return {
    id: inner.id,
    name: inner.name,
    type: inner.type,
    capabilities: inner.capabilities,
    async put(key, body, options) {
      await hooks.beforePut?.(key);
      return inner.put(key, body, options);
    },
    get(key, options) {
      return inner.get(key, options);
    },
    stat(key) {
      return inner.stat(key);
    },
    async exists(key) {
      await hooks.beforeExists?.(key);
      return inner.exists(key);
    },
    async delete(key) {
      await hooks.beforeDelete?.(key);
      return inner.delete(key);
    },
    testConnection() {
      return inner.testConnection();
    }
  };
}

function createJobContext(runtime: AppRuntime, type: "gc" | "storage_cleanup"): JobContext {
  const job = enqueueJob(runtime.db, { type, payload: {} });
  const ac = new AbortController();
  return {
    jobId: job.id,
    type,
    attempts: 1,
    maxAttempts: 3,
    signal: ac.signal,
    isCancelled: () => ac.signal.aborted,
    throwIfCancelled: () => {
      if (ac.signal.aborted) {
        throw new JobCancelledError();
      }
    },
    updateProgress: () => {},
    acquireLock: (key) => acquireJobLock(runtime.db, key, job.id),
    releaseLock: (key) => releaseJobLock(runtime.db, key, job.id)
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
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.length,
    header: content.subarray(0, 8192)
  };
}

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];

async function makeRuntime(): Promise<{ runtime: AppRuntime; dir: string; actorUserId: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-concurrency-"));
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

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("StorageRegistry object locks", () => {
  it("serializes same (storageId, objectKey), avoids deadlock on reversed multi-locks, and supports AbortSignal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-lock-unit-"));
    tempDirs.push(dir);
    const registry = new StorageRegistry(
      loadConfig({
        cwd: dir,
        env: { ASSETNEST_DATA_DIR: path.join(dir, "data") }
      })
    );

    // 1. Same key serializes while different key runs concurrently
    const events: string[] = [];
    const gate = createDeferred();
    const first = registry.withObjectLock("local", "originals/aa/a", async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = registry.withObjectLock("local", "originals/aa/a", async () => {
      events.push("second:start");
    });
    const otherKey = registry.withObjectLock("local", "originals/bb/b", async () => {
      events.push("other:start");
    });

    await otherKey;
    expect(events).toEqual(["first:start", "other:start"]);

    // 2. Abort waiting caller without leaking queue or blocking subsequent waiters
    const ac = new AbortController();
    const abortedWaiter = registry.withObjectLock(
      "local",
      "originals/aa/a",
      async () => {
        events.push("aborted:should-not-run");
      },
      { signal: ac.signal }
    );
    const third = registry.withObjectLock("local", "originals/aa/a", async () => {
      events.push("third:start");
    });

    ac.abort();
    await expect(abortedWaiter).rejects.toThrow();

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(events).toEqual([
      "first:start",
      "other:start",
      "first:end",
      "second:start",
      "third:start"
    ]);

    // 3. Reversed multi-lock order never deadlocks
    const a = { storageId: "local", objectKey: "originals/11/x" };
    const b = { storageId: "s3", objectKey: "originals/11/x" };
    let completed = 0;
    await Promise.all([
      registry.withObjectLocks([a, b], async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        completed += 1;
      }),
      registry.withObjectLocks([b, a], async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        completed += 1;
      })
    ]);
    expect(completed).toBe(2);
  });
});

describe("Concurrent upload vs GC / storage cleanup", () => {
  it("prevents GC delete from removing a file concurrently re-uploaded with the same SHA-256", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    const payload = Buffer.from("%PDF-1.4\nconcurrent-gc-reupload-payload\n%%EOF");
    const uploadOpts = {
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

    // Upload initial asset, then delete asset so the physical file becomes an unreferenced orphan
    const initialStaged = await createStagedUpload(dir, "spec.pdf", payload);
    const initial = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      initialStaged,
      uploadOpts
    );
    const fileRow = runtime.db.raw
      .prepare("SELECT id, object_key FROM files WHERE sha256 = ?")
      .get(initialStaged.sha256) as { id: string; object_key: string };

    runtime.db.raw.prepare("UPDATE assets SET current_version_id = NULL WHERE id = ?").run(initial.asset.id);
    runtime.db.raw.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(initial.asset.id);
    runtime.db.raw.prepare("DELETE FROM assets WHERE id = ?").run(initial.asset.id);

    const deleteEntered = createDeferred();
    const releaseDelete = createDeferred();
    const order: string[] = [];
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, {
        async beforeDelete(key) {
          if (key === fileRow.object_key) {
            order.push("gc:delete:enter");
            deleteEntered.resolve();
            await releaseDelete.promise;
            order.push("gc:delete:proceed");
          }
        },
        async beforePut(key) {
          if (key === fileRow.object_key) {
            order.push("upload:put");
          }
        }
      })
    );

    const gcCtx = createJobContext(runtime, "gc");
    const gcPromise = executeGcJob(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      { forceIgnoreRetention: true },
      gcCtx
    );

    // Wait until GC is actively inside provider.delete()
    await deleteEntered.promise;

    // Trigger concurrent re-upload of the exact same content while GC is mid-delete
    const reuploadStaged = await createStagedUpload(dir, "spec-reupload.pdf", payload);
    const uploadPromise = ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      reuploadStaged,
      uploadOpts
    );

    // Give upload microtasks time to attempt entry; it must wait on the object lock
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["gc:delete:enter"]);

    // Let GC finish deleting and commit 'deleted'; upload must then put & restore 'ready'
    releaseDelete.resolve();
    const [gcResult, uploaded] = await Promise.all([gcPromise, uploadPromise]);

    expect(gcResult.deletedFiles).toBe(1);
    expect(uploaded.deduplicated).toBe(false);
    expect(order).toEqual(["gc:delete:enter", "gc:delete:proceed", "upload:put"]);

    const updatedFile = runtime.db.raw
      .prepare("SELECT state, last_error FROM files WHERE id = ?")
      .get(fileRow.id) as { state: string; last_error: string | null };
    expect(updatedFile.state).toBe("ready");
    expect(updatedFile.last_error).toBeNull();
    expect(await baseProvider.exists(fileRow.object_key)).toBe(true);
  });

  it("causes GC to skip deletion when a concurrent upload claims the object first", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    const payload = Buffer.from("%PDF-1.4\nupload-before-gc-payload\n%%EOF");
    const uploadOpts = {
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

    const initialStaged = await createStagedUpload(dir, "doc.pdf", payload);
    const initial = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      initialStaged,
      uploadOpts
    );
    const fileRow = runtime.db.raw
      .prepare("SELECT id, object_key FROM files WHERE sha256 = ?")
      .get(initialStaged.sha256) as { id: string; object_key: string };

    // Orphan the file while keeping it in state='ready'
    runtime.db.raw.prepare("UPDATE assets SET current_version_id = NULL WHERE id = ?").run(initial.asset.id);
    runtime.db.raw.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(initial.asset.id);
    runtime.db.raw.prepare("DELETE FROM assets WHERE id = ?").run(initial.asset.id);

    const existsEntered = createDeferred();
    const releaseExists = createDeferred();
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, {
        async beforeExists(key) {
          if (key === fileRow.object_key) {
            existsEntered.resolve();
            await releaseExists.promise;
          }
        }
      })
    );

    // Start upload first (it acquires object lock and pauses inside exists() dedup check)
    const reuploadStaged = await createStagedUpload(dir, "doc-reupload.pdf", payload);
    const uploadPromise = ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      reuploadStaged,
      uploadOpts
    );
    await existsEntered.promise;

    // Start GC while upload holds the lock
    const gcCtx = createJobContext(runtime, "gc");
    const gcPromise = executeGcJob(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      { forceIgnoreRetention: true },
      gcCtx
    );

    releaseExists.resolve();
    const [uploaded, gcResult] = await Promise.all([uploadPromise, gcPromise]);

    expect(uploaded.deduplicated).toBe(true);
    expect(gcResult.deletedFiles).toBe(0);
    expect(await baseProvider.exists(fileRow.object_key)).toBe(true);
    const updatedFile = runtime.db.raw
      .prepare("SELECT state FROM files WHERE id = ?")
      .get(fileRow.id) as { state: string };
    expect(updatedFile.state).toBe("ready");
  });

  it("serializes storage cleanup and concurrent appendAssetVersion on the same object", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    const payloadV1 = Buffer.from("%PDF-1.4\nversion-one-content\n%%EOF");
    const payloadV2 = Buffer.from("%PDF-1.4\nversion-two-cleanup-race\n%%EOF");
    const uploadOpts = {
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

    // Create target asset (v1) and a second file (v2 content) that becomes pending_delete + queued in cleanup
    const v1Staged = await createStagedUpload(dir, "v1.pdf", payloadV1);
    const assetRes = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      v1Staged,
      uploadOpts
    );

    const v2SeedStaged = await createStagedUpload(dir, "v2-seed.pdf", payloadV2);
    const v2Seed = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      v2SeedStaged,
      uploadOpts
    );
    const v2FileRow = runtime.db.raw
      .prepare("SELECT id, object_key, sha256, size_bytes FROM files WHERE sha256 = ?")
      .get(v2SeedStaged.sha256) as { id: string; object_key: string; sha256: string; size_bytes: number };

    // Remove seed asset and mark file pending_delete with a queued storage_cleanup_queue item
    runtime.db.raw.prepare("UPDATE assets SET current_version_id = NULL WHERE id = ?").run(v2Seed.asset.id);
    runtime.db.raw.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(v2Seed.asset.id);
    runtime.db.raw.prepare("DELETE FROM assets WHERE id = ?").run(v2Seed.asset.id);
    const now = new Date().toISOString();
    runtime.db.raw
      .prepare("UPDATE files SET state = 'pending_delete', updated_at = ? WHERE id = ?")
      .run(now, v2FileRow.id);

    const cleanupItemId = crypto.randomUUID();
    runtime.db.raw
      .prepare(
        `INSERT INTO storage_cleanup_queue (
           id, storage_id, object_key, sha256, size_bytes,
           reason, source_job_id, status, last_error, created_at, updated_at
         ) VALUES (?, 'local', ?, ?, ?, 'migration_source', NULL, 'queued', NULL, ?, ?)`
      )
      .run(cleanupItemId, v2FileRow.object_key, v2FileRow.sha256, v2FileRow.size_bytes, now, now);

    const deleteEntered = createDeferred();
    const releaseDelete = createDeferred();
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, {
        async beforeDelete(key) {
          if (key === v2FileRow.object_key) {
            deleteEntered.resolve();
            await releaseDelete.promise;
          }
        }
      })
    );

    const cleanupCtx = createJobContext(runtime, "storage_cleanup");
    const cleanupPromise = executeStorageCleanupJob(
      runtime.db,
      runtime.storageRegistry,
      { itemIds: [cleanupItemId] },
      cleanupCtx
    );
    await deleteEntered.promise;

    // Concurrently append version with identical payload while cleanup is mid-delete
    const v2AppendStaged = await createStagedUpload(dir, "v2.pdf", payloadV2);
    const appendPromise = appendAssetVersion(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      assetRes.asset.id,
      v2AppendStaged,
      {
        storageId: "local",
        changeNote: "race check",
        promptText: "",
        referenceAssetVersionId: null,
        setAsCurrent: true
      }
    );

    releaseDelete.resolve();
    const [cleanupResult, appended] = await Promise.all([cleanupPromise, appendPromise]);

    expect(cleanupResult.deletedCount).toBe(1);
    expect(appended.version.versionNo).toBe(2);
    expect(appended.deduplicated).toBe(false);
    expect(await baseProvider.exists(v2FileRow.object_key)).toBe(true);

    const finalFile = runtime.db.raw
      .prepare("SELECT state, last_error FROM files WHERE id = ?")
      .get(v2FileRow.id) as { state: string; last_error: string | null };
    expect(finalFile.state).toBe("ready");
    expect(finalFile.last_error).toBeNull();
  });

  it("keeps GC delete_failed error handling inside the object lock so a subsequent re-upload stays ready", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    const payload = Buffer.from("%PDF-1.4\ngc-delete-fail-then-reupload\n%%EOF");
    const uploadOpts = {
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

    const initialStaged = await createStagedUpload(dir, "fail.pdf", payload);
    const initial = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      initialStaged,
      uploadOpts
    );
    const fileRow = runtime.db.raw
      .prepare("SELECT id, object_key FROM files WHERE sha256 = ?")
      .get(initialStaged.sha256) as { id: string; object_key: string };

    runtime.db.raw.prepare("UPDATE assets SET current_version_id = NULL WHERE id = ?").run(initial.asset.id);
    runtime.db.raw.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(initial.asset.id);
    runtime.db.raw.prepare("DELETE FROM assets WHERE id = ?").run(initial.asset.id);

    const deleteEntered = createDeferred();
    const releaseDelete = createDeferred();
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, {
        async beforeDelete(key) {
          if (key === fileRow.object_key) {
            deleteEntered.resolve();
            await releaseDelete.promise;
            throw new Error("Simulated remote storage delete outage");
          }
        }
      })
    );

    const gcCtx = createJobContext(runtime, "gc");
    const gcPromise = executeGcJob(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      { forceIgnoreRetention: true },
      gcCtx
    );
    await deleteEntered.promise;

    const reuploadStaged = await createStagedUpload(dir, "recovered.pdf", payload);
    const uploadPromise = ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      reuploadStaged,
      uploadOpts
    );

    releaseDelete.resolve();
    const [gcSettled, uploaded] = await Promise.allSettled([gcPromise, uploadPromise]);

    expect(gcSettled.status).toBe("rejected");
    expect(uploaded.status).toBe("fulfilled");
    if (uploaded.status === "fulfilled") {
      expect(uploaded.value.deduplicated).toBe(false);
    }

    const finalFile = runtime.db.raw
      .prepare("SELECT state, last_error FROM files WHERE id = ?")
      .get(fileRow.id) as { state: string; last_error: string | null };
    expect(finalFile.state).toBe("ready");
    expect(finalFile.last_error).toBeNull();
    expect(await baseProvider.exists(fileRow.object_key)).toBe(true);
  });

  it("skips storage cleanup when appendAssetVersion acquires the object lock first", async () => {
    const { runtime, dir, actorUserId } = await makeRuntime();
    const payloadV1 = Buffer.from("%PDF-1.4\ncleanup-protected-v1\n%%EOF");
    const payloadV2 = Buffer.from("%PDF-1.4\ncleanup-protected-v2\n%%EOF");
    const uploadOpts = {
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

    const assetRes = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      await createStagedUpload(dir, "v1.pdf", payloadV1),
      uploadOpts
    );

    const seedStaged = await createStagedUpload(dir, "v2-seed.pdf", payloadV2);
    const seedAsset = await ingestStagedFile(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      seedStaged,
      uploadOpts
    );
    const v2FileRow = runtime.db.raw
      .prepare("SELECT id, object_key, sha256, size_bytes FROM files WHERE sha256 = ?")
      .get(seedStaged.sha256) as { id: string; object_key: string; sha256: string; size_bytes: number };

    runtime.db.raw.prepare("UPDATE assets SET current_version_id = NULL WHERE id = ?").run(seedAsset.asset.id);
    runtime.db.raw.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(seedAsset.asset.id);
    runtime.db.raw.prepare("DELETE FROM assets WHERE id = ?").run(seedAsset.asset.id);
    const now = new Date().toISOString();
    runtime.db.raw
      .prepare("UPDATE files SET state = 'pending_delete', updated_at = ? WHERE id = ?")
      .run(now, v2FileRow.id);

    const cleanupItemId = crypto.randomUUID();
    runtime.db.raw
      .prepare(
        `INSERT INTO storage_cleanup_queue (
           id, storage_id, object_key, sha256, size_bytes,
           reason, source_job_id, status, last_error, created_at, updated_at
         ) VALUES (?, 'local', ?, ?, ?, 'migration_source', NULL, 'queued', NULL, ?, ?)`
      )
      .run(cleanupItemId, v2FileRow.object_key, v2FileRow.sha256, v2FileRow.size_bytes, now, now);

    const putEntered = createDeferred();
    const releasePut = createDeferred();
    let deleteCalled = false;
    const baseProvider = runtime.storageRegistry.require("local");
    runtime.storageRegistry.register(
      wrapProvider(baseProvider, {
        async beforePut(key) {
          if (key === v2FileRow.object_key) {
            putEntered.resolve();
            await releasePut.promise;
          }
        },
        async beforeDelete(key) {
          if (key === v2FileRow.object_key) {
            deleteCalled = true;
          }
        }
      })
    );

    const appendPromise = appendAssetVersion(
      runtime.db,
      runtime.config,
      runtime.storageRegistry,
      actorUserId,
      assetRes.asset.id,
      await createStagedUpload(dir, "v2.pdf", payloadV2),
      {
        storageId: "local",
        changeNote: "protect from cleanup",
        promptText: "",
        referenceAssetVersionId: null,
        setAsCurrent: true
      }
    );
    await putEntered.promise;

    const cleanupCtx = createJobContext(runtime, "storage_cleanup");
    const cleanupPromise = executeStorageCleanupJob(
      runtime.db,
      runtime.storageRegistry,
      { itemIds: [cleanupItemId] },
      cleanupCtx
    );

    releasePut.resolve();
    const [appended, cleanupResult] = await Promise.all([appendPromise, cleanupPromise]);

    expect(appended.version.versionNo).toBe(2);
    expect(deleteCalled).toBe(false);
    expect(cleanupResult.deletedCount).toBe(0);
    expect(cleanupResult.skippedProtectedCount).toBe(1);
    expect(await baseProvider.exists(v2FileRow.object_key)).toBe(true);
  });
});
