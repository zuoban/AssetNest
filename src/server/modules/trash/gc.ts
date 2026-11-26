import crypto from "node:crypto";
import fsp from "node:fs/promises";
import type { JobRecord } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { enqueueJob } from "../jobs/service.js";
import type { JobContext, JobWorker } from "../jobs/worker.js";
import { buildThumbnailRelPath, resolveThumbnailAbsPath } from "../media/thumbnail.js";
import { removeSearchDocument } from "../search/service.js";
import { recordActivity } from "../system/activity.js";

function tableExists(db: AppDatabase, tableName: string): boolean {
  const row = db.raw
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row);
}

function getTrashRetentionDays(db: AppDatabase): number {
  const row = db.raw
    .prepare("SELECT value_json FROM settings WHERE key = 'trash_retention_days'")
    .get() as { value_json: string } | undefined;
  if (!row) {
    return 30;
  }
  try {
    const parsed = Number(JSON.parse(row.value_json));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
  } catch {
    return 30;
  }
}

function hasProtectedVersionReferences(db: AppDatabase, assetId: string): boolean {
  const versionRows = db.raw
    .prepare("SELECT id FROM asset_versions WHERE asset_id = ?")
    .all(assetId) as Array<{ id: string }>;
  if (versionRows.length === 0) {
    return false;
  }
  const versionIds = versionRows.map((row) => row.id);
  const placeholders = versionIds.map(() => "?").join(", ");

  const protectedChecks: Array<{ table: string; column: string }> = [
    { table: "release_assets", column: "asset_version_id" },
    { table: "asset_set_items", column: "asset_version_id" },
    { table: "product_master_images", column: "asset_version_id" }
  ];

  for (const check of protectedChecks) {
    if (!tableExists(db, check.table)) {
      continue;
    }
    const ref = db.raw
      .prepare(
        `SELECT 1 AS ok FROM ${check.table} WHERE ${check.column} IN (${placeholders}) LIMIT 1`
      )
      .get(...versionIds) as { ok: number } | undefined;
    if (ref) {
      return true;
    }
  }

  return false;
}

function hasProtectedProductReferences(db: AppDatabase, productId: string): boolean {
  if (tableExists(db, "product_master_images")) {
    const ref = db.raw
      .prepare("SELECT 1 AS ok FROM product_master_images WHERE product_id = ? LIMIT 1")
      .get(productId) as { ok: number } | undefined;
    if (ref) {
      return true;
    }
  }
  if (tableExists(db, "listings")) {
    const ref = db.raw
      .prepare("SELECT 1 AS ok FROM listings WHERE product_id = ? LIMIT 1")
      .get(productId) as { ok: number } | undefined;
    if (ref) {
      return true;
    }
  }
  if (tableExists(db, "listing_skus")) {
    const ref = db.raw
      .prepare(
        `SELECT 1 AS ok
         FROM listing_skus ls
         JOIN skus s ON s.id = ls.sku_id
         WHERE s.product_id = ?
         LIMIT 1`
      )
      .get(productId) as { ok: number } | undefined;
    if (ref) {
      return true;
    }
  }
  return false;
}

export function enqueueTrashGcJob(
  db: AppDatabase,
  worker: JobWorker,
  actorUserId: string,
  options: { forceIgnoreRetention?: boolean } = {}
): JobRecord {
  const forceIgnoreRetention = Boolean(options.forceIgnoreRetention);
  const job = db.transaction(() => {
    const created = enqueueJob(db, {
      type: "gc",
      payload: { forceIgnoreRetention },
      priority: 90,
      maxAttempts: 3,
      progressStage: "queued"
    });
    recordActivity(db, {
      actorUserId,
      action: "trash.gc.start",
      objectType: "job",
      objectId: created.id,
      details: { forceIgnoreRetention }
    });
    return created;
  });
  worker.wake();
  return job;
}

export async function executeGcJob(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  payload: Record<string, unknown>,
  ctx: JobContext
): Promise<Record<string, unknown>> {
  const forceIgnoreRetention = Boolean(payload.forceIgnoreRetention);
  const retentionDays = getTrashRetentionDays(db);
  const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  let purgedAssets = 0;
  let skippedProtectedAssets = 0;
  let purgedProducts = 0;
  let skippedProtectedProducts = 0;
  let deletedFiles = 0;
  let failedFiles = 0;
  let freedBytes = 0;
  let lastFailureMessage: string | null = null;

  ctx.updateProgress({ stage: "scanning_trash", current: 0, total: null });
  ctx.throwIfCancelled();

  // Phase 1: Purge eligible soft-deleted assets
  const expiredAssets = (
    forceIgnoreRetention
      ? db.raw.prepare("SELECT id FROM assets WHERE deleted_at IS NOT NULL").all()
      : db.raw
          .prepare("SELECT id FROM assets WHERE deleted_at IS NOT NULL AND deleted_at <= ?")
          .all(cutoffIso)
  ) as Array<{ id: string }>;

  for (const asset of expiredAssets) {
    ctx.throwIfCancelled();
    if (hasProtectedVersionReferences(db, asset.id)) {
      skippedProtectedAssets += 1;
      continue;
    }
    db.transaction(() => {
      db.raw.prepare("UPDATE assets SET current_version_id = NULL WHERE id = ?").run(asset.id);
      db.raw.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(asset.id);
      db.raw.prepare("DELETE FROM assets WHERE id = ?").run(asset.id);
      removeSearchDocument(db, "asset", asset.id);
    });
    purgedAssets += 1;
  }

  // Phase 2: Purge eligible soft-deleted products
  const expiredProducts = (
    forceIgnoreRetention
      ? db.raw.prepare("SELECT id FROM products WHERE deleted_at IS NOT NULL").all()
      : db.raw
          .prepare("SELECT id FROM products WHERE deleted_at IS NOT NULL AND deleted_at <= ?")
          .all(cutoffIso)
  ) as Array<{ id: string }>;

  for (const product of expiredProducts) {
    ctx.throwIfCancelled();
    if (hasProtectedProductReferences(db, product.id)) {
      skippedProtectedProducts += 1;
      continue;
    }
    db.transaction(() => {
      db.raw.prepare("DELETE FROM skus WHERE product_id = ?").run(product.id);
      db.raw.prepare("DELETE FROM products WHERE id = ?").run(product.id);
      removeSearchDocument(db, "product", product.id);
    });
    purgedProducts += 1;
  }

  // Phase 3: Reclaim unreferenced physical files
  const orphanFiles = db.raw
    .prepare(
      `SELECT f.id, f.storage_id, f.object_key, f.sha256, f.size_bytes
       FROM files f
       WHERE f.state IN ('ready', 'pending_delete', 'delete_failed')
         AND NOT EXISTS (SELECT 1 FROM asset_versions av WHERE av.file_id = f.id)
       ORDER BY f.updated_at ASC`
    )
    .all() as Array<{
    id: string;
    storage_id: string;
    object_key: string;
    sha256: string;
    size_bytes: number;
  }>;

  ctx.updateProgress({ stage: "deleting_unreferenced_files", current: 0, total: orphanFiles.length });

  for (let index = 0; index < orphanFiles.length; index += 1) {
    const file = orphanFiles[index]!;
    ctx.throwIfCancelled();

    const lockKey = `file:${file.id}`;
    if (!ctx.acquireLock(lockKey)) {
      continue;
    }

    try {
      const stillUnreferenced = db.transaction(() => {
        const ref = db.raw
          .prepare("SELECT 1 AS ok FROM asset_versions WHERE file_id = ? LIMIT 1")
          .get(file.id) as { ok: number } | undefined;
        if (ref) {
          return false;
        }
        const now = new Date().toISOString();
        db.raw
          .prepare("UPDATE files SET state = 'pending_delete', updated_at = ? WHERE id = ?")
          .run(now, file.id);
        return true;
      });

      if (!stillUnreferenced) {
        continue;
      }

      const provider = storageRegistry.get(file.storage_id);
      if (!provider) {
        throw new Error(`存储空间 "${file.storage_id}" 当前不可用或离线，物理对象将保留待重试`);
      }

      await provider.delete(file.object_key);

      const now = new Date().toISOString();
      db.transaction(() => {
        db.raw
          .prepare(
            "UPDATE files SET state = 'deleted', last_error = NULL, updated_at = ? WHERE id = ?"
          )
          .run(now, file.id);
        db.raw
          .prepare(
            `UPDATE storage_cleanup_queue
             SET status = 'deleted', last_error = NULL, updated_at = ?
             WHERE storage_id = ? AND object_key = ? AND status IN ('awaiting_confirmation', 'queued', 'failed')`
          )
          .run(now, file.storage_id, file.object_key);
      });

      // Remove local thumbnail cache only if no live file shares this sha256
      const otherShaRef = db.raw
        .prepare("SELECT 1 AS ok FROM files WHERE sha256 = ? AND state = 'ready' LIMIT 1")
        .get(file.sha256) as { ok: number } | undefined;
      if (!otherShaRef) {
        const thumbRel = buildThumbnailRelPath(file.sha256);
        const thumbAbs = resolveThumbnailAbsPath(config.cache.path, thumbRel);
        await fsp.rm(thumbAbs, { force: true }).catch(() => {});
      }

      deletedFiles += 1;
      freedBytes += Number(file.size_bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      db.transaction(() => {
        db.raw
          .prepare(
            "UPDATE files SET state = 'delete_failed', last_error = ?, updated_at = ? WHERE id = ?"
          )
          .run(message, now, file.id);
        const existingQueue = db.raw
          .prepare(
            `SELECT id FROM storage_cleanup_queue
             WHERE storage_id = ? AND object_key = ? AND status IN ('awaiting_confirmation', 'queued', 'failed')`
          )
          .get(file.storage_id, file.object_key) as { id: string } | undefined;
        if (existingQueue) {
          db.raw
            .prepare(
              "UPDATE storage_cleanup_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
            )
            .run(message, now, existingQueue.id);
        } else {
          db.raw
            .prepare(
              `INSERT INTO storage_cleanup_queue (
                 id, storage_id, object_key, sha256, size_bytes,
                 reason, source_job_id, status, last_error, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'gc_unreferenced', ?, 'failed', ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              file.storage_id,
              file.object_key,
              file.sha256,
              Number(file.size_bytes),
              ctx.jobId,
              message,
              now,
              now
            );
        }
      });
      failedFiles += 1;
      lastFailureMessage = message;
    } finally {
      ctx.releaseLock(lockKey);
      ctx.updateProgress({
        stage: "deleting_unreferenced_files",
        current: index + 1,
        total: orphanFiles.length
      });
    }
  }

  if (failedFiles > 0) {
    throw new Error(
      `GC 完成部分回收（已删除 ${deletedFiles} 个物理对象），但有 ${failedFiles} 个远程对象删除失败并已保留待重试：${lastFailureMessage ?? "未知错误"}`
    );
  }

  return {
    retentionDays,
    forceIgnoreRetention,
    purgedAssets,
    skippedProtectedAssets,
    purgedProducts,
    skippedProtectedProducts,
    deletedFiles,
    freedBytes
  };
}
