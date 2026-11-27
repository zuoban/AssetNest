import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  CacheClearResult,
  JobRecord,
  MigrationPreviewResponse,
  MigrationScopeInput,
  StorageCleanupItem,
  StorageCleanupQueueResponse,
  StorageProviderStatus,
  StorageProviderSummary,
  StorageTestResponse
} from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { buildStorageObjectJobLockKey, type StorageRegistry } from "../../storage/registry.js";
import type { StorageProvider } from "../../storage/types.js";
import { enqueueJob } from "../jobs/service.js";
import { NonRetryableJobError, type JobContext, type JobWorker } from "../jobs/worker.js";
import { recordActivity } from "../system/activity.js";
import { listStorageProviders } from "../system/service.js";

function findProviderSummary(db: AppDatabase, providerId: string): StorageProviderSummary {
  const found = listStorageProviders(db).find((item) => item.id === providerId);
  if (!found) {
    throw new AppError(404, "NOT_FOUND", `存储空间 "${providerId}" 不存在`);
  }
  return found;
}

async function verifyProviderObjectHash(
  provider: StorageProvider,
  objectKey: string,
  expectedSha256: string,
  expectedSize: number,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const result = await provider.get(objectKey, { signal });
    const hash = crypto.createHash("sha256");
    let byteCount = 0;
    for await (const chunk of result.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      byteCount += buf.length;
      hash.update(buf);
    }
    return byteCount === expectedSize && hash.digest("hex") === expectedSha256;
  } catch {
    return false;
  }
}

export async function testStorageProvider(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  actorUserId: string,
  providerId: string
): Promise<StorageTestResponse> {
  const dbRow = db.raw
    .prepare("SELECT id, name, type, enabled, status FROM storage_providers WHERE id = ?")
    .get(providerId) as
    | { id: string; name: string; type: string; enabled: number; status: StorageProviderStatus }
    | undefined;

  if (!dbRow) {
    throw new AppError(404, "NOT_FOUND", `存储空间 "${providerId}" 不存在`);
  }

  const now = new Date().toISOString();
  const provider = storageRegistry.get(providerId);
  if (!provider) {
    const message =
      dbRow.enabled === 0
        ? `存储空间 "${providerId}" 当前已禁用或配置文件中缺少连接参数`
        : `存储空间 "${providerId}" 在当前配置中未初始化适配器`;
    const nextStatus: StorageProviderStatus =
      dbRow.status === "missing_config" ? "missing_config" : "offline";
    db.transaction(() => {
      db.raw
        .prepare(
          `UPDATE storage_providers
           SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(nextStatus, now, message, now, providerId);
      recordActivity(db, {
        actorUserId,
        action: "storage.test",
        objectType: "storage_provider",
        objectId: providerId,
        details: { ok: false, code: "INVALID_CONFIG", message }
      });
    });
    return {
      provider: findProviderSummary(db, providerId),
      result: {
        ok: false,
        latencyMs: 0,
        code: "INVALID_CONFIG",
        message
      }
    };
  }

  const result = await provider.testConnection();
  const nextStatus: StorageProviderStatus = result.ok ? "healthy" : "offline";

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE storage_providers
         SET status = ?,
             capabilities_json = ?,
             last_tested_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextStatus,
        JSON.stringify(provider.capabilities),
        now,
        result.ok ? null : result.message,
        now,
        providerId
      );

    recordActivity(db, {
      actorUserId,
      action: "storage.test",
      objectType: "storage_provider",
      objectId: providerId,
      details: {
        ok: result.ok,
        code: result.code,
        latencyMs: result.latencyMs,
        message: result.message
      }
    });
  });

  return {
    provider: findProviderSummary(db, providerId),
    result
  };
}

export async function switchDefaultStorage(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  actorUserId: string,
  storageId: string
): Promise<{ defaultStorageId: string; provider: StorageProviderSummary }> {
  const dbRow = db.raw
    .prepare("SELECT id, enabled, status FROM storage_providers WHERE id = ?")
    .get(storageId) as
    | { id: string; enabled: number; status: StorageProviderStatus }
    | undefined;

  if (!dbRow) {
    throw new AppError(404, "NOT_FOUND", `目标存储空间 "${storageId}" 不存在`);
  }
  if (dbRow.enabled !== 1 || dbRow.status === "missing_config") {
    throw new AppError(409, "CONFLICT", `存储空间 "${storageId}" 未启用或缺少配置，不能设为默认存储`);
  }

  const provider = storageRegistry.get(storageId);
  if (!provider) {
    throw new AppError(503, "STORAGE_OFFLINE", `存储空间 "${storageId}" 当前不可用`);
  }

  const probe = await provider.testConnection();
  const now = new Date().toISOString();

  if (!probe.ok) {
    db.raw
      .prepare(
        `UPDATE storage_providers
         SET status = 'offline', last_tested_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now, probe.message, now, storageId);
    throw new AppError(
      503,
      "STORAGE_OFFLINE",
      `目标存储连通性验证未通过，拒绝切换默认存储：${probe.message}`
    );
  }

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE storage_providers
         SET status = 'healthy',
             capabilities_json = ?,
             last_tested_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(provider.capabilities), now, now, storageId);

    db.raw
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('default_storage_id', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(storageId), now);

    recordActivity(db, {
      actorUserId,
      action: "storage.default.switch",
      objectType: "storage_provider",
      objectId: storageId,
      details: { latencyMs: probe.latencyMs }
    });
  });

  return {
    defaultStorageId: storageId,
    provider: findProviderSummary(db, storageId)
  };
}

export function deleteStorageProvider(
  db: AppDatabase,
  actorUserId: string,
  providerId: string
): { deleted: true; id: string } {
  const existing = db.raw
    .prepare("SELECT id, name, enabled FROM storage_providers WHERE id = ?")
    .get(providerId) as { id: string; name: string; enabled: number } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `存储空间 "${providerId}" 不存在`);
  }

  const defaultRow = db.raw
    .prepare("SELECT value_json FROM settings WHERE key = 'default_storage_id'")
    .get() as { value_json: string } | undefined;
  const defaultId = defaultRow ? (JSON.parse(defaultRow.value_json) as string) : "local";
  if (defaultId === providerId) {
    throw new AppError(409, "CONFLICT", "当前存储空间为默认存储，禁止删除");
  }

  const fileRefRow = db.raw
    .prepare("SELECT COUNT(*) AS count FROM files WHERE storage_id = ?")
    .get(providerId) as { count: number };
  if (Number(fileRefRow.count) > 0) {
    throw new AppError(
      409,
      "CONFLICT",
      `存储空间 "${providerId}" 仍存在 ${fileRefRow.count} 条物理文件记录引用，禁止删除`
    );
  }

  const cleanupRefRow = db.raw
    .prepare("SELECT COUNT(*) AS count FROM storage_cleanup_queue WHERE storage_id = ?")
    .get(providerId) as { count: number };
  if (Number(cleanupRefRow.count) > 0) {
    throw new AppError(
      409,
      "CONFLICT",
      `存储空间 "${providerId}" 仍存在 ${cleanupRefRow.count} 条清理队列记录，禁止删除`
    );
  }

  db.transaction(() => {
    db.raw.prepare("DELETE FROM storage_providers WHERE id = ?").run(providerId);
    recordActivity(db, {
      actorUserId,
      action: "storage.delete",
      objectType: "storage_provider",
      objectId: providerId,
      details: { name: existing.name }
    });
  });

  return { deleted: true, id: providerId };
}

interface CandidateMigrationFile {
  id: string;
  storage_id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
}

function resolveCandidateMigrationFiles(
  db: AppDatabase,
  sourceStorageId: string,
  scope?: MigrationScopeInput
): CandidateMigrationFile[] {
  const mode = scope?.mode ?? "all";
  if (mode === "all") {
    return db.raw
      .prepare(
        `SELECT id, storage_id, object_key, sha256, size_bytes, mime_type
         FROM files
         WHERE storage_id = ? AND state = 'ready'
         ORDER BY created_at ASC`
      )
      .all(sourceStorageId) as unknown as CandidateMigrationFile[];
  }

  if (mode === "product") {
    if (!scope?.productId) {
      throw new AppError(400, "VALIDATION_ERROR", "按商品迁移时必须指定 productId");
    }
    return db.raw
      .prepare(
        `SELECT DISTINCT f.id, f.storage_id, f.object_key, f.sha256, f.size_bytes, f.mime_type
         FROM files f
         JOIN asset_versions av ON av.file_id = f.id
         JOIN product_assets pa ON pa.asset_id = av.asset_id
         WHERE f.storage_id = ? AND f.state = 'ready' AND pa.product_id = ?
         ORDER BY f.created_at ASC`
      )
      .all(sourceStorageId, scope.productId) as unknown as CandidateMigrationFile[];
  }

  const assetIds = Array.from(new Set(scope?.assetIds ?? []));
  if (assetIds.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "按素材列表迁移时必须提供至少一个 assetId");
  }
  const placeholders = assetIds.map(() => "?").join(", ");
  return db.raw
    .prepare(
      `SELECT DISTINCT f.id, f.storage_id, f.object_key, f.sha256, f.size_bytes, f.mime_type
       FROM files f
       JOIN asset_versions av ON av.file_id = f.id
       WHERE f.storage_id = ? AND f.state = 'ready' AND av.asset_id IN (${placeholders})
       ORDER BY f.created_at ASC`
    )
    .all(sourceStorageId, ...assetIds) as unknown as CandidateMigrationFile[];
}

export function previewStorageMigration(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  input: {
    sourceStorageId: string;
    targetStorageId: string;
    scope?: MigrationScopeInput;
  }
): MigrationPreviewResponse {
  const { sourceStorageId, targetStorageId, scope } = input;
  if (sourceStorageId === targetStorageId) {
    throw new AppError(400, "VALIDATION_ERROR", "来源存储与目标存储不能相同");
  }

  const sourceRow = db.raw
    .prepare("SELECT id, name, enabled, status FROM storage_providers WHERE id = ?")
    .get(sourceStorageId) as
    | { id: string; name: string; enabled: number; status: StorageProviderStatus }
    | undefined;
  const targetRow = db.raw
    .prepare("SELECT id, name, enabled, status FROM storage_providers WHERE id = ?")
    .get(targetStorageId) as
    | { id: string; name: string; enabled: number; status: StorageProviderStatus }
    | undefined;

  if (!sourceRow) {
    throw new AppError(404, "NOT_FOUND", `来源存储 "${sourceStorageId}" 不存在`);
  }
  if (!targetRow) {
    throw new AppError(404, "NOT_FOUND", `目标存储 "${targetStorageId}" 不存在`);
  }
  if (!storageRegistry.get(sourceStorageId)) {
    throw new AppError(503, "STORAGE_OFFLINE", `来源存储 "${sourceStorageId}" 当前不可用`);
  }
  if (targetRow.enabled !== 1 || !storageRegistry.get(targetStorageId)) {
    throw new AppError(503, "STORAGE_OFFLINE", `目标存储 "${targetStorageId}" 未启用或不可用`);
  }

  const files = resolveCandidateMigrationFiles(db, sourceStorageId, scope);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size_bytes), 0);

  if (files.length === 0) {
    return {
      sourceStorageId,
      targetStorageId,
      fileCount: 0,
      totalBytes: 0,
      alreadyOnTargetCount: 0,
      affectedAssetCount: 0,
      affectedProductCount: 0,
      sharedFileCount: 0,
      affectedAssets: [],
      affectedProducts: []
    };
  }

  const fileIds = files.map((file) => file.id);
  const filePlaceholders = fileIds.map(() => "?").join(", ");

  const shas = Array.from(new Set(files.map((file) => file.sha256)));
  const shaPlaceholders = shas.map(() => "?").join(", ");
  const targetExistingRow = db.raw
    .prepare(
      `SELECT COUNT(*) AS count
       FROM files
       WHERE storage_id = ? AND state = 'ready' AND sha256 IN (${shaPlaceholders})`
    )
    .get(targetStorageId, ...shas) as { count: number };

  const sharedRows = db.raw
    .prepare(
      `SELECT av.file_id, COUNT(DISTINCT av.asset_id) AS asset_count
       FROM asset_versions av
       WHERE av.file_id IN (${filePlaceholders})
       GROUP BY av.file_id
       HAVING COUNT(DISTINCT av.asset_id) > 1`
    )
    .all(...fileIds) as Array<{ file_id: string; asset_count: number }>;

  const affectedAssets = db.raw
    .prepare(
      `SELECT DISTINCT a.id, a.name, a.original_filename, a.deleted_at
       FROM assets a
       JOIN asset_versions av ON av.asset_id = a.id
       WHERE av.file_id IN (${filePlaceholders})
       ORDER BY a.created_at DESC
       LIMIT 100`
    )
    .all(...fileIds) as Array<{
    id: string;
    name: string;
    original_filename: string;
    deleted_at: string | null;
  }>;

  const affectedAssetCountRow = db.raw
    .prepare(
      `SELECT COUNT(DISTINCT av.asset_id) AS count
       FROM asset_versions av
       WHERE av.file_id IN (${filePlaceholders})`
    )
    .get(...fileIds) as { count: number };

  const affectedProducts = db.raw
    .prepare(
      `SELECT DISTINCT p.id, p.spu, p.name_zh, p.name_en
       FROM products p
       JOIN product_assets pa ON pa.product_id = p.id
       JOIN asset_versions av ON av.asset_id = pa.asset_id
       WHERE av.file_id IN (${filePlaceholders})
       ORDER BY p.spu ASC
       LIMIT 100`
    )
    .all(...fileIds) as Array<{
    id: string;
    spu: string;
    name_zh: string;
    name_en: string;
  }>;

  const affectedProductCountRow = db.raw
    .prepare(
      `SELECT COUNT(DISTINCT pa.product_id) AS count
       FROM product_assets pa
       JOIN asset_versions av ON av.asset_id = pa.asset_id
       WHERE av.file_id IN (${filePlaceholders})`
    )
    .get(...fileIds) as { count: number };

  return {
    sourceStorageId,
    targetStorageId,
    fileCount: files.length,
    totalBytes,
    alreadyOnTargetCount: Number(targetExistingRow.count),
    affectedAssetCount: Number(affectedAssetCountRow.count),
    affectedProductCount: Number(affectedProductCountRow.count),
    sharedFileCount: sharedRows.length,
    affectedAssets: affectedAssets.map((row) => ({
      id: row.id,
      name: row.name,
      originalFilename: row.original_filename,
      deletedAt: row.deleted_at
    })),
    affectedProducts: affectedProducts.map((row) => ({
      id: row.id,
      spu: row.spu,
      nameZh: row.name_zh,
      nameEn: row.name_en
    }))
  };
}

export async function createStorageMigrationJob(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  worker: JobWorker,
  actorUserId: string,
  input: {
    sourceStorageId: string;
    targetStorageId: string;
    scope?: MigrationScopeInput;
  }
): Promise<{ job: JobRecord; preview: MigrationPreviewResponse }> {
  const preview = previewStorageMigration(db, storageRegistry, input);
  if (preview.fileCount === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "所选范围内没有可迁移的物理文件");
  }

  const targetProvider = storageRegistry.require(input.targetStorageId);
  const probe = await targetProvider.testConnection();
  const now = new Date().toISOString();

  if (!probe.ok) {
    db.raw
      .prepare(
        `UPDATE storage_providers
         SET status = 'offline', last_tested_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now, probe.message, now, input.targetStorageId);
    throw new AppError(
      503,
      "STORAGE_OFFLINE",
      `目标存储 "${input.targetStorageId}" 探针检查未通过，无法发起迁移：${probe.message}`
    );
  }

  const candidateFiles = resolveCandidateMigrationFiles(db, input.sourceStorageId, input.scope);

  const job = db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE storage_providers
         SET status = 'healthy', last_tested_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, input.targetStorageId);

    const createdJob = enqueueJob(db, {
      type: "storage_migrate",
      payload: {
        sourceStorageId: input.sourceStorageId,
        targetStorageId: input.targetStorageId,
        scope: input.scope ?? { mode: "all" }
      },
      priority: 50,
      maxAttempts: 5,
      progressStage: "queued",
      progressTotal: candidateFiles.length
    });

    const insertItem = db.raw.prepare(
      `INSERT INTO storage_migration_items (
         id, job_id, file_id, source_storage_id, target_storage_id,
         status, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    );

    for (const file of candidateFiles) {
      insertItem.run(
        crypto.randomUUID(),
        createdJob.id,
        file.id,
        input.sourceStorageId,
        input.targetStorageId,
        now
      );
    }

    recordActivity(db, {
      actorUserId,
      action: "storage.migrate.start",
      objectType: "job",
      objectId: createdJob.id,
      details: {
        sourceStorageId: input.sourceStorageId,
        targetStorageId: input.targetStorageId,
        fileCount: candidateFiles.length,
        totalBytes: preview.totalBytes
      }
    });

    return createdJob;
  });

  worker.wake();
  return { job, preview };
}

export async function executeStorageMigrationJob(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  payload: Record<string, unknown>,
  ctx: JobContext
): Promise<Record<string, unknown>> {
  const sourceStorageId = String(payload.sourceStorageId ?? "");
  const targetStorageId = String(payload.targetStorageId ?? "");

  const sourceProvider = storageRegistry.get(sourceStorageId);
  const targetProvider = storageRegistry.get(targetStorageId);
  if (!sourceProvider || !targetProvider) {
    throw new NonRetryableJobError(
      `迁移所需的存储空间不可用（source=${sourceStorageId}, target=${targetStorageId}）`
    );
  }

  const allItems = db.raw
    .prepare(
      `SELECT id, file_id, source_storage_id, target_storage_id, status
       FROM storage_migration_items
       WHERE job_id = ?
       ORDER BY rowid ASC`
    )
    .all(ctx.jobId) as Array<{
    id: string;
    file_id: string;
    source_storage_id: string;
    target_storage_id: string;
    status: string;
  }>;

  const total = allItems.length;
  let completedCount = allItems.filter(
    (item) => item.status === "switched" || item.status === "merged" || item.status === "skipped"
  ).length;
  let switchedCount = allItems.filter((item) => item.status === "switched").length;
  let mergedCount = allItems.filter((item) => item.status === "merged").length;
  let skippedCount = allItems.filter((item) => item.status === "skipped").length;
  let failedCount = 0;
  let lastFailureMessage: string | null = null;

  ctx.updateProgress({
    stage: "migrating_files",
    current: completedCount,
    total
  });

  const pendingItems = allItems.filter(
    (item) => item.status === "pending" || item.status === "copied" || item.status === "failed"
  );

  await fsp.mkdir(config.uploads.tempDir, { recursive: true });

  for (const item of pendingItems) {
    ctx.throwIfCancelled();

    const fileLockKey = `file:${item.file_id}`;
    if (!ctx.acquireLock(fileLockKey)) {
      failedCount += 1;
      lastFailureMessage = `文件 ${item.file_id} 正被其他后台任务锁定`;
      continue;
    }

    const acquiredLocks: string[] = [fileLockKey];
    const stageFilePath = path.join(config.uploads.tempDir, `migrate-${ctx.jobId}-${crypto.randomUUID()}.part`);
    try {
      const initialFileRow = db.raw
        .prepare(
          `SELECT id, storage_id, object_key, sha256, size_bytes, mime_type, state
           FROM files
           WHERE id = ?`
        )
        .get(item.file_id) as
        | {
            id: string;
            storage_id: string;
            object_key: string;
            sha256: string;
            size_bytes: number;
            mime_type: string;
            state: string;
          }
        | undefined;

      if (!initialFileRow || initialFileRow.state !== "ready" || initialFileRow.storage_id !== sourceStorageId) {
        const now = new Date().toISOString();
        db.raw
          .prepare(
            `UPDATE storage_migration_items
             SET status = 'skipped', last_error = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(now, item.id);
        skippedCount += 1;
        completedCount += 1;
        ctx.updateProgress({ stage: "migrating_files", current: completedCount, total });
        continue;
      }

      const objectLockKeys = Array.from(
        new Set([
          buildStorageObjectJobLockKey(sourceStorageId, initialFileRow.object_key),
          buildStorageObjectJobLockKey(targetStorageId, initialFileRow.object_key)
        ])
      ).sort();
      for (const key of objectLockKeys) {
        if (!ctx.acquireLock(key)) {
          throw new Error(`对象 ${initialFileRow.object_key} 正被其他后台任务锁定`);
        }
        acquiredLocks.push(key);
      }

      await storageRegistry.withObjectLocks(
        [
          { storageId: sourceStorageId, objectKey: initialFileRow.object_key },
          { storageId: targetStorageId, objectKey: initialFileRow.object_key }
        ],
        async () => {
          ctx.throwIfCancelled();

          const fileRow = db.raw
            .prepare(
              `SELECT id, storage_id, object_key, sha256, size_bytes, mime_type, state
               FROM files
               WHERE id = ?`
            )
            .get(item.file_id) as
            | {
                id: string;
                storage_id: string;
                object_key: string;
                sha256: string;
                size_bytes: number;
                mime_type: string;
                state: string;
              }
            | undefined;

          if (
            !fileRow ||
            fileRow.state !== "ready" ||
            fileRow.storage_id !== sourceStorageId ||
            fileRow.object_key !== initialFileRow.object_key
          ) {
            const now = new Date().toISOString();
            db.raw
              .prepare(
                `UPDATE storage_migration_items
                 SET status = 'skipped', last_error = NULL, updated_at = ?
                 WHERE id = ?`
              )
              .run(now, item.id);
            skippedCount += 1;
            completedCount += 1;
            ctx.updateProgress({ stage: "migrating_files", current: completedCount, total });
            return;
          }

          const expectedSize = Number(fileRow.size_bytes);
          const targetAlreadyValid =
            (await targetProvider.exists(fileRow.object_key)) &&
            (await verifyProviderObjectHash(
              targetProvider,
              fileRow.object_key,
              fileRow.sha256,
              expectedSize,
              ctx.signal
            ));

          if (!targetAlreadyValid) {
            ctx.throwIfCancelled();
            const sourceRes = await sourceProvider.get(fileRow.object_key, { signal: ctx.signal });
            const sourceHash = crypto.createHash("sha256");
            let sourceBytes = 0;

            const writer = fs.createWriteStream(stageFilePath);
            sourceRes.stream.on("data", (chunk: Buffer) => {
              sourceBytes += chunk.length;
              sourceHash.update(chunk);
            });
            await pipeline(sourceRes.stream, writer);

            const actualSourceSha = sourceHash.digest("hex");
            if (sourceBytes !== expectedSize || actualSourceSha !== fileRow.sha256) {
              throw new Error(
                `来源文件完整性校验失败（file=${fileRow.id}, expected=${fileRow.sha256}, actual=${actualSourceSha}）`
              );
            }

            ctx.throwIfCancelled();
            await targetProvider.put(fileRow.object_key, fs.createReadStream(stageFilePath), {
              contentType: fileRow.mime_type,
              contentLength: expectedSize,
              sha256: fileRow.sha256,
              signal: ctx.signal
            });

            const verifiedAfterPut = await verifyProviderObjectHash(
              targetProvider,
              fileRow.object_key,
              fileRow.sha256,
              expectedSize,
              ctx.signal
            );
            if (!verifiedAfterPut) {
              throw new Error(`目标存储读回校验失败（file=${fileRow.id}, key=${fileRow.object_key}）`);
            }
          }

          const copiedAt = new Date().toISOString();
          db.raw
            .prepare(
              `UPDATE storage_migration_items
               SET status = 'copied', last_error = NULL, updated_at = ?
               WHERE id = ?`
            )
            .run(copiedAt, item.id);

          // Short SQLite transaction to atomically switch or merge metadata
          const switchKind = db.transaction((): "switched" | "merged" => {
            const now = new Date().toISOString();
            const targetConflict = db.raw
              .prepare(
                `SELECT id, state
                 FROM files
                 WHERE storage_id = ? AND sha256 = ? AND id != ?`
              )
              .get(targetStorageId, fileRow.sha256, fileRow.id) as
              | { id: string; state: string }
              | undefined;

            if (targetConflict) {
              if (targetConflict.state !== "ready") {
                db.raw
                  .prepare("UPDATE files SET state = 'ready', last_error = NULL, updated_at = ? WHERE id = ?")
                  .run(now, targetConflict.id);
              }
              db.raw
                .prepare("UPDATE asset_versions SET file_id = ? WHERE file_id = ?")
                .run(targetConflict.id, fileRow.id);
              db.raw
                .prepare("UPDATE files SET state = 'pending_delete', updated_at = ? WHERE id = ?")
                .run(now, fileRow.id);
              db.raw
                .prepare(
                  `UPDATE storage_migration_items
                   SET status = 'merged', merged_into_file_id = ?, last_error = NULL, updated_at = ?
                   WHERE id = ?`
                )
                .run(targetConflict.id, now, item.id);
            } else {
              db.raw
                .prepare("UPDATE files SET storage_id = ?, updated_at = ? WHERE id = ?")
                .run(targetStorageId, now, fileRow.id);
              db.raw
                .prepare(
                  `UPDATE storage_migration_items
                   SET status = 'switched', last_error = NULL, updated_at = ?
                   WHERE id = ?`
                )
                .run(now, item.id);
            }

            db.raw
              .prepare(
                `INSERT OR IGNORE INTO storage_cleanup_queue (
                   id, storage_id, object_key, sha256, size_bytes,
                   reason, source_job_id, status, last_error, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 'migration_source', ?, 'awaiting_confirmation', NULL, ?, ?)`
              )
              .run(
                crypto.randomUUID(),
                sourceStorageId,
                fileRow.object_key,
                fileRow.sha256,
                expectedSize,
                ctx.jobId,
                now,
                now
              );

            return targetConflict ? "merged" : "switched";
          });

          if (switchKind === "merged") {
            mergedCount += 1;
          } else {
            switchedCount += 1;
          }
          completedCount += 1;
          ctx.updateProgress({ stage: "migrating_files", current: completedCount, total });
        },
        { signal: ctx.signal }
      );
    } catch (err) {
      if (err instanceof Error && err.name === "JobCancelledError") {
        throw err;
      }
      if (ctx.isCancelled()) {
        ctx.throwIfCancelled();
      }
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      db.raw
        .prepare(
          `UPDATE storage_migration_items
           SET status = 'failed', last_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(message, now, item.id);
      failedCount += 1;
      lastFailureMessage = message;
    } finally {
      await fsp.rm(stageFilePath, { force: true }).catch(() => {});
      while (acquiredLocks.length > 0) {
        ctx.releaseLock(acquiredLocks.pop()!);
      }
    }
  }

  if (failedCount > 0) {
    throw new Error(
      `跨存储迁移有 ${failedCount}/${total} 个文件失败（已完成 ${completedCount}）：${lastFailureMessage ?? "未知错误"}`
    );
  }

  return {
    sourceStorageId,
    targetStorageId,
    total,
    switchedCount,
    mergedCount,
    skippedCount
  };
}

export function listCleanupQueue(
  db: AppDatabase,
  statusFilter?: StorageCleanupItem["status"]
): StorageCleanupQueueResponse {
  const rows = (
    statusFilter
      ? db.raw
          .prepare(
            `SELECT id, storage_id, object_key, sha256, size_bytes, reason,
                    source_job_id, status, last_error, created_at, updated_at
             FROM storage_cleanup_queue
             WHERE status = ?
             ORDER BY created_at DESC
             LIMIT 200`
          )
          .all(statusFilter)
      : db.raw
          .prepare(
            `SELECT id, storage_id, object_key, sha256, size_bytes, reason,
                    source_job_id, status, last_error, created_at, updated_at
             FROM storage_cleanup_queue
             ORDER BY created_at DESC
             LIMIT 200`
          )
          .all()
  ) as Array<{
    id: string;
    storage_id: string;
    object_key: string;
    sha256: string;
    size_bytes: number;
    reason: StorageCleanupItem["reason"];
    source_job_id: string | null;
    status: StorageCleanupItem["status"];
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const summaryRow = db.raw
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'awaiting_confirmation' THEN 1 ELSE 0 END) AS awaiting_count,
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
         SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted_count,
         COALESCE(SUM(CASE WHEN status IN ('awaiting_confirmation', 'queued', 'failed') THEN size_bytes ELSE 0 END), 0) AS reclaimable_bytes
       FROM storage_cleanup_queue`
    )
    .get() as {
    awaiting_count: number | null;
    queued_count: number | null;
    failed_count: number | null;
    deleted_count: number | null;
    reclaimable_bytes: number | null;
  };

  return {
    items: rows.map((row) => ({
      id: row.id,
      storageId: row.storage_id,
      objectKey: row.object_key,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      reason: row.reason,
      sourceJobId: row.source_job_id,
      status: row.status,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    summary: {
      awaitingCount: Number(summaryRow.awaiting_count ?? 0),
      queuedCount: Number(summaryRow.queued_count ?? 0),
      failedCount: Number(summaryRow.failed_count ?? 0),
      deletedCount: Number(summaryRow.deleted_count ?? 0),
      reclaimableBytes: Number(summaryRow.reclaimable_bytes ?? 0)
    }
  };
}

export function confirmCleanupQueue(
  db: AppDatabase,
  worker: JobWorker,
  actorUserId: string,
  input: { ids?: string[]; allAwaiting?: boolean }
): { job: JobRecord; queuedCount: number } {
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    let targetIds: string[];
    if (input.allAwaiting) {
      const rows = db.raw
        .prepare(
          `SELECT id FROM storage_cleanup_queue
           WHERE status IN ('awaiting_confirmation', 'failed')`
        )
        .all() as Array<{ id: string }>;
      targetIds = rows.map((r) => r.id);
    } else {
      const uniqueIds = Array.from(new Set(input.ids ?? []));
      if (uniqueIds.length === 0) {
        throw new AppError(400, "VALIDATION_ERROR", "请选择至少一条待清理对象或勾选全部待确认项");
      }
      const placeholders = uniqueIds.map(() => "?").join(", ");
      const rows = db.raw
        .prepare(
          `SELECT id FROM storage_cleanup_queue
           WHERE id IN (${placeholders}) AND status IN ('awaiting_confirmation', 'failed')`
        )
        .all(...uniqueIds) as Array<{ id: string }>;
      targetIds = rows.map((r) => r.id);
    }

    if (targetIds.length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "没有处于待确认或失败状态的清理对象");
    }

    const placeholders = targetIds.map(() => "?").join(", ");
    db.raw
      .prepare(
        `UPDATE storage_cleanup_queue
         SET status = 'queued', last_error = NULL, updated_at = ?
         WHERE id IN (${placeholders})`
      )
      .run(now, ...targetIds);

    const job = enqueueJob(db, {
      type: "storage_cleanup",
      payload: { itemIds: targetIds },
      priority: 80,
      maxAttempts: 3,
      progressStage: "queued",
      progressTotal: targetIds.length
    });

    recordActivity(db, {
      actorUserId,
      action: "storage.cleanup.confirm",
      objectType: "job",
      objectId: job.id,
      details: { queuedCount: targetIds.length }
    });

    return { job, queuedCount: targetIds.length };
  });

  worker.wake();
  return result;
}

export async function executeStorageCleanupJob(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  payload: Record<string, unknown>,
  ctx: JobContext
): Promise<Record<string, unknown>> {
  const requestedIds = Array.isArray(payload.itemIds)
    ? payload.itemIds.filter((value): value is string => typeof value === "string")
    : [];

  const items = (
    requestedIds.length > 0
      ? db.raw
          .prepare(
            `SELECT id, storage_id, object_key, sha256, size_bytes
             FROM storage_cleanup_queue
             WHERE id IN (${requestedIds.map(() => "?").join(", ")}) AND status IN ('queued', 'failed')`
          )
          .all(...requestedIds)
      : db.raw
          .prepare(
            `SELECT id, storage_id, object_key, sha256, size_bytes
             FROM storage_cleanup_queue
             WHERE status = 'queued'`
          )
          .all()
  ) as Array<{
    id: string;
    storage_id: string;
    object_key: string;
    sha256: string;
    size_bytes: number;
  }>;

  const total = items.length;
  let deletedCount = 0;
  let skippedProtectedCount = 0;
  let failedCount = 0;
  let lastFailureMessage: string | null = null;

  ctx.updateProgress({ stage: "cleaning_objects", current: 0, total });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    ctx.throwIfCancelled();

    const lockKey = buildStorageObjectJobLockKey(item.storage_id, item.object_key);
    if (!ctx.acquireLock(lockKey)) {
      failedCount += 1;
      lastFailureMessage = `清理对象 ${item.object_key} 正被其他任务锁定`;
      continue;
    }

    try {
      await storageRegistry.withObjectLock(
        item.storage_id,
        item.object_key,
        async () => {
          ctx.throwIfCancelled();
          try {
            const currentQueueRow = db.raw
              .prepare("SELECT status FROM storage_cleanup_queue WHERE id = ?")
              .get(item.id) as { status: string } | undefined;
            if (!currentQueueRow || !["queued", "failed"].includes(currentQueueRow.status)) {
              return;
            }

            // Reference protection: never delete an object that still has a live file or asset_version reference on the same storage
            const liveRef = db.raw
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM files f
                 WHERE f.storage_id = ? AND f.object_key = ?
                   AND (
                     f.state IN ('staging', 'ready')
                     OR EXISTS (SELECT 1 FROM asset_versions av WHERE av.file_id = f.id)
                   )`
              )
              .get(item.storage_id, item.object_key) as { count: number };

            if (Number(liveRef.count) > 0) {
              const now = new Date().toISOString();
              db.raw
                .prepare(
                  `UPDATE storage_cleanup_queue
                   SET status = 'deleted',
                       last_error = '目标对象仍被活跃记录引用，已跳过物理删除保护',
                       updated_at = ?
                   WHERE id = ?`
                )
                .run(now, item.id);
              skippedProtectedCount += 1;
            } else {
              const provider = storageRegistry.get(item.storage_id);
              if (!provider) {
                throw new Error(`存储空间 "${item.storage_id}" 当前不可用或离线，无法删除物理对象`);
              }
              await provider.delete(item.object_key);

              const now = new Date().toISOString();
              db.transaction(() => {
                db.raw
                  .prepare(
                    `UPDATE storage_cleanup_queue
                     SET status = 'deleted', last_error = NULL, updated_at = ?
                     WHERE id = ?`
                  )
                  .run(now, item.id);
                db.raw
                  .prepare(
                    `UPDATE files
                     SET state = 'deleted', last_error = NULL, updated_at = ?
                     WHERE storage_id = ? AND object_key = ? AND state IN ('pending_delete', 'delete_failed')`
                  )
                  .run(now, item.storage_id, item.object_key);
              });
              deletedCount += 1;
            }
          } catch (err) {
            if (err instanceof Error && err.name === "JobCancelledError") {
              throw err;
            }
            if (ctx.isCancelled()) {
              ctx.throwIfCancelled();
            }
            const message = err instanceof Error ? err.message : String(err);
            const now = new Date().toISOString();
            db.transaction(() => {
              db.raw
                .prepare(
                  `UPDATE storage_cleanup_queue
                   SET status = 'failed', last_error = ?, updated_at = ?
                   WHERE id = ?`
                )
                .run(message, now, item.id);
              db.raw
                .prepare(
                  `UPDATE files
                   SET state = 'delete_failed', last_error = ?, updated_at = ?
                   WHERE storage_id = ? AND object_key = ? AND state IN ('pending_delete', 'delete_failed')`
                )
                .run(message, now, item.storage_id, item.object_key);
            });
            failedCount += 1;
            lastFailureMessage = message;
          }
        },
        { signal: ctx.signal }
      );
    } catch (err) {
      if (err instanceof Error && err.name === "JobCancelledError") {
        throw err;
      }
      if (ctx.isCancelled()) {
        ctx.throwIfCancelled();
      }
      throw err;
    } finally {
      ctx.releaseLock(lockKey);
      ctx.updateProgress({ stage: "cleaning_objects", current: index + 1, total });
    }
  }

  if (failedCount > 0) {
    throw new Error(
      `清理队列有 ${failedCount}/${total} 个对象删除失败（已保留重试状态）：${lastFailureMessage ?? "未知错误"}`
    );
  }

  return {
    total,
    deletedCount,
    skippedProtectedCount
  };
}

export async function clearThumbnailCache(
  db: AppDatabase,
  config: ResolvedAppConfig,
  actorUserId: string
): Promise<CacheClearResult> {
  const thumbsRoot = path.join(path.resolve(config.cache.path), "thumbs");
  let clearedFiles = 0;
  let freedBytes = 0;

  async function walkAndDelete(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      return;
    }
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndDelete(fullPath);
        await fsp.rmdir(fullPath).catch(() => {});
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath).catch(() => null);
        await fsp.rm(fullPath, { force: true }).catch(() => {});
        clearedFiles += 1;
        if (stat) {
          freedBytes += stat.size;
        }
      }
    }
  }

  await walkAndDelete(thumbsRoot);
  await fsp.mkdir(thumbsRoot, { recursive: true });

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE asset_versions
         SET thumb_status = 'pending', thumb_key = NULL
         WHERE thumb_status IN ('ready', 'failed')`
      )
      .run();

    recordActivity(db, {
      actorUserId,
      action: "cache.clear",
      objectType: "cache",
      objectId: "thumbnails",
      details: { clearedFiles, freedBytes }
    });
  });

  return { clearedFiles, freedBytes };
}
