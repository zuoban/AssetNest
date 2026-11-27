import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import type { BackupKind, BackupRecord } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { getCurrentSchemaVersion } from "../../db/migrator.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { enqueueJob } from "../jobs/service.js";
import { JobCancelledError, type JobContext, type JobWorker } from "../jobs/worker.js";
import { recordActivity } from "../system/activity.js";

interface BackupRow {
  id: string;
  kind: BackupKind;
  job_id: string | null;
  file_path: string;
  size_bytes: number;
  sha256: string | null;
  schema_version: number;
  file_count: number;
  status: BackupRecord["status"];
  last_error: string | null;
  created_at: string;
}

function mapBackupRow(row: BackupRow): BackupRecord {
  return {
    id: row.id,
    kind: row.kind,
    jobId: row.job_id,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    schemaVersion: Number(row.schema_version),
    fileCount: Number(row.file_count),
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at
  };
}

function getBackupsDir(config: ResolvedAppConfig): string {
  return path.resolve(config.app.dataDir, "backups");
}

function resolveBackupZipPath(config: ResolvedAppConfig, relativeName: string): string {
  const root = getBackupsDir(config);
  const resolved = path.resolve(root, relativeName);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError(400, "VALIDATION_ERROR", "备份文件路径越界");
  }
  return resolved;
}

interface BackupSourceFileRow {
  id: string;
  storage_id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
}

function destroyReadableSafely(stream: NodeJS.ReadableStream): void {
  const candidate = stream as NodeJS.ReadableStream & {
    destroyed?: boolean;
    destroy?: () => void;
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    listenerCount?: (event: string) => number;
  };
  if (
    typeof candidate.on === "function" &&
    (typeof candidate.listenerCount !== "function" || candidate.listenerCount("error") === 0)
  ) {
    candidate.on("error", () => {});
  }
  if (typeof candidate.destroy === "function" && !candidate.destroyed) {
    candidate.destroy();
  }
}

function readReadyFilesFromSnapshot(snapshotDbPath: string): BackupSourceFileRow[] {
  const snapshotDb = new DatabaseSync(snapshotDbPath, { readOnly: true });
  try {
    return snapshotDb
      .prepare(
        `SELECT id, storage_id, object_key, sha256, size_bytes, mime_type
         FROM files
         WHERE state = 'ready'
         ORDER BY storage_id ASC, object_key ASC`
      )
      .all() as unknown as BackupSourceFileRow[];
  } finally {
    snapshotDb.close();
  }
}

async function hashFileSha256(
  filePath: string,
  throwIfCancelled?: () => void
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      throwIfCancelled?.();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      sizeBytes += buf.length;
      hash.update(buf);
    }
  } finally {
    destroyReadableSafely(stream);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

export function listBackups(db: AppDatabase): BackupRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT id, kind, job_id, file_path, size_bytes, sha256,
              schema_version, file_count, status, last_error, created_at
       FROM backups
       WHERE status != 'deleted'
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all() as unknown as BackupRow[];
  return rows.map(mapBackupRow);
}

export function getBackupDownloadInfo(
  db: AppDatabase,
  config: ResolvedAppConfig,
  backupId: string
): { absPath: string; filename: string; sizeBytes: number; backup: BackupRecord } {
  const row = db.raw
    .prepare(
      `SELECT id, kind, job_id, file_path, size_bytes, sha256,
              schema_version, file_count, status, last_error, created_at
       FROM backups
       WHERE id = ?`
    )
    .get(backupId) as BackupRow | undefined;

  if (!row || row.status === "deleted") {
    throw new AppError(404, "NOT_FOUND", "指定的备份记录不存在");
  }
  if (row.status !== "ready") {
    throw new AppError(409, "CONFLICT", `该备份当前状态为 ${row.status}，暂不可下载`);
  }

  const absPath = resolveBackupZipPath(config, row.file_path);
  if (!fs.existsSync(absPath)) {
    throw new AppError(404, "NOT_FOUND", "备份文件已在磁盘上丢失，请重新创建备份");
  }
  const stat = fs.statSync(absPath);
  return {
    absPath,
    filename: `assetnest-backup-${row.kind}-${row.id.slice(0, 8)}.zip`,
    sizeBytes: stat.size,
    backup: mapBackupRow(row)
  };
}

export function createBackupJob(
  db: AppDatabase,
  worker: JobWorker,
  actorUserId: string,
  kind: BackupKind
): { backup: BackupRecord; job: ReturnType<typeof enqueueJob> } {
  const backupId = crypto.randomUUID();
  const now = new Date().toISOString();
  const schemaVersion = getCurrentSchemaVersion(db);
  const filename = `${backupId}.zip`;

  const result = db.transaction(() => {
    const job = enqueueJob(db, {
      type: "backup",
      payload: { backupId, kind },
      priority: 60,
      maxAttempts: 2,
      progressStage: "queued"
    });

    db.raw
      .prepare(
        `INSERT INTO backups (
           id, kind, job_id, file_path, size_bytes, sha256,
           schema_version, file_count, status, last_error, created_at
         ) VALUES (?, ?, ?, ?, 0, NULL, ?, 0, 'creating', NULL, ?)`
      )
      .run(backupId, kind, job.id, filename, schemaVersion, now);

    recordActivity(db, {
      actorUserId,
      action: "backup.create",
      objectType: "backup",
      objectId: backupId,
      details: { kind, jobId: job.id }
    });

    const backupRow = db.raw
      .prepare(
        `SELECT id, kind, job_id, file_path, size_bytes, sha256,
                schema_version, file_count, status, last_error, created_at
         FROM backups WHERE id = ?`
      )
      .get(backupId) as unknown as BackupRow;

    return { backup: mapBackupRow(backupRow), job };
  });

  worker.wake();
  return result;
}

export async function executeBackupJob(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  appVersion: string,
  payload: Record<string, unknown>,
  ctx: JobContext
): Promise<Record<string, unknown>> {
  const backupId = String(payload.backupId ?? "");
  const kind = (payload.kind === "full" ? "full" : "metadata") as BackupKind;

  const backupRow = db.raw
    .prepare("SELECT id, file_path, schema_version FROM backups WHERE id = ?")
    .get(backupId) as { id: string; file_path: string; schema_version: number } | undefined;

  if (!backupRow) {
    throw new Error(`备份记录 ${backupId} 不存在`);
  }

  const backupsDir = getBackupsDir(config);
  await fsp.mkdir(backupsDir, { recursive: true });
  await fsp.mkdir(config.uploads.tempDir, { recursive: true });

  const finalZipPath = resolveBackupZipPath(config, backupRow.file_path);
  const tempZipPath = path.join(backupsDir, `.${backupId}-${crypto.randomUUID()}.zip.tmp`);
  const snapshotDbPath = path.join(
    config.uploads.tempDir,
    `backup-snapshot-${backupId}-${crypto.randomUUID()}.sqlite`
  );

  let zipPipelinePromise: Promise<{ sha256: string; sizeBytes: number }> | null = null;
  let abortZip: ((err: unknown) => void) | null = null;
  let zipOutputStream: Readable | null = null;

  const onContextAbort = () => {
    abortZip?.(new JobCancelledError());
  };
  ctx.signal.addEventListener("abort", onContextAbort, { once: true });

  try {
    ctx.throwIfCancelled();
    db.raw
      .prepare("UPDATE backups SET status = 'creating', last_error = NULL WHERE id = ?")
      .run(backupId);

    ctx.updateProgress({ stage: "snapshotting_database", current: 0, total: 1 });

    // SQLite consistent snapshot via VACUUM INTO (must run outside transaction)
    const escapedSnapshotPath = snapshotDbPath.replace(/'/g, "''");
    db.raw.exec(`VACUUM INTO '${escapedSnapshotPath}';`);

    const dbHashInfo = await hashFileSha256(snapshotDbPath, () => ctx.throwIfCancelled());
    ctx.throwIfCancelled();

    // Read ready file list from the point-in-time DB snapshot so manifest & DB stay consistent
    const filesToInclude =
      kind === "full" ? readReadyFilesFromSnapshot(snapshotDbPath) : [];

    // Pre-validate storage providers before creating temp ZIP or streaming any objects
    const resolvedFiles = filesToInclude.map((file) => {
      const provider = storageRegistry.get(file.storage_id);
      if (!provider) {
        throw new Error(
          `完整备份失败：文件 ${file.id} 所在存储空间 "${file.storage_id}" 当前离线或缺少配置`
        );
      }
      return {
        file,
        provider,
        zipEntryPath: `files/${file.storage_id}/${file.object_key}`
      };
    });

    const totalSteps = resolvedFiles.length + 2;
    ctx.updateProgress({ stage: "packaging_backup", current: 1, total: totalSteps });

    const manifestFiles = resolvedFiles.map(({ file, zipEntryPath }) => ({
      fileId: file.id,
      storageId: file.storage_id,
      objectKey: file.object_key,
      zipPath: zipEntryPath,
      sha256: file.sha256,
      sizeBytes: Number(file.size_bytes),
      mimeType: file.mime_type
    }));

    const streamAbortController = new AbortController();
    const activeStreams = new Set<NodeJS.ReadableStream>();
    let zipAborted = false;
    let zipAbortError: Error | null = null;

    const zipFile = new yazl.ZipFile();
    const zipOutput = zipFile.outputStream as Readable;
    zipOutputStream = zipOutput;

    abortZip = (rawErr: unknown) => {
      const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      if (zipAborted) {
        return;
      }
      zipAborted = true;
      zipAbortError = err;

      if (!streamAbortController.signal.aborted) {
        streamAbortController.abort(err);
      }

      if (!(zipFile as unknown as { errored?: boolean }).errored) {
        zipFile.emit("error", err);
      }

      const toDestroy = Array.from(activeStreams);
      activeStreams.clear();
      for (const stream of toDestroy) {
        destroyReadableSafely(stream);
      }

      if (!zipOutput.destroyed) {
        zipOutput.destroy(err);
      }
    };

    zipFile.on("error", abortZip);

    ctx.throwIfCancelled();

    const createManagedLazyStream = (
      factory: () => AsyncGenerator<Buffer, void, void>
    ): Readable => {
      const stream = Readable.from(factory());
      activeStreams.add(stream);
      const cleanup = () => {
        activeStreams.delete(stream);
      };
      stream.once("close", cleanup);
      stream.once("end", cleanup);
      stream.on("error", (err) => {
        cleanup();
        abortZip?.(err);
      });
      return stream;
    };

    // Start consuming zipOutput before registering entries so error handlers and backpressure are active immediately
    zipPipelinePromise = (async () => {
      const hash = crypto.createHash("sha256");
      let zipSize = 0;
      const pass = new PassThrough();
      pass.on("data", (chunk: Buffer) => {
        zipSize += chunk.length;
        hash.update(chunk);
      });
      const writer = fs.createWriteStream(tempZipPath);
      try {
        await pipeline(zipOutput, pass, writer);
      } catch (pipeErr) {
        abortZip?.(pipeErr);
        throw zipAbortError ?? pipeErr;
      }
      return { sha256: hash.digest("hex"), sizeBytes: zipSize };
    })();

    // Stream SQLite snapshot lazily so its file descriptor is tracked and closed immediately on abort
    const dbLazyStream = createManagedLazyStream(async function* () {
      if (zipAborted) return;
      ctx.throwIfCancelled();
      const dbStream = fs.createReadStream(snapshotDbPath);
      activeStreams.add(dbStream);
      try {
        for await (const chunk of dbStream) {
          if (zipAborted) return;
          ctx.throwIfCancelled();
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        }
      } finally {
        activeStreams.delete(dbStream);
        destroyReadableSafely(dbStream);
      }
    });
    zipFile.addReadStream(dbLazyStream, "assetnest.db");

    // Lazy sequential streaming: each object is streamed directly from storage into the ZIP
    // while computing SHA-256 and byte count on the fly — avoiding per-file temp copies on disk
    for (let index = 0; index < resolvedFiles.length; index += 1) {
      const { file, provider, zipEntryPath } = resolvedFiles[index]!;
      const expectedSize = Number(file.size_bytes);
      const expectedSha = file.sha256;

      const fileLazyStream = createManagedLazyStream(async function* () {
        if (zipAborted) return;
        ctx.throwIfCancelled();

        const readRes = await provider.get(file.object_key, {
          signal: streamAbortController.signal
        });
        const sourceStream = readRes.stream;
        activeStreams.add(sourceStream);

        const fileHash = crypto.createHash("sha256");
        let byteCount = 0;

        try {
          if (zipAborted) return;
          for await (const chunk of sourceStream) {
            if (zipAborted) return;
            ctx.throwIfCancelled();
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            byteCount += buf.length;
            if (byteCount > expectedSize) {
              throw new Error(
                `完整备份完整性校验失败（file=${file.id}, expectedSize=${expectedSize}, actualSize>${expectedSize}）`
              );
            }
            fileHash.update(buf);
            yield buf;
          }
        } finally {
          activeStreams.delete(sourceStream);
          destroyReadableSafely(sourceStream);
        }

        if (zipAborted) return;
        ctx.throwIfCancelled();

        const actualSha = fileHash.digest("hex");
        if (byteCount !== expectedSize || actualSha !== expectedSha) {
          throw new Error(
            `完整备份完整性校验失败（file=${file.id}, expected=${expectedSha}, actual=${actualSha}）`
          );
        }

        ctx.updateProgress({
          stage: "packaging_backup",
          current: index + 2,
          total: totalSteps
        });
      });

      zipFile.addReadStream(fileLazyStream, zipEntryPath, { compress: false });
    }

    const manifest = {
      formatVersion: 1,
      backupId,
      kind,
      appVersion,
      schemaVersion: backupRow.schema_version,
      createdAt: new Date().toISOString(),
      database: {
        zipPath: "assetnest.db",
        sha256: dbHashInfo.sha256,
        sizeBytes: dbHashInfo.sizeBytes
      },
      fileCount: manifestFiles.length,
      files: manifestFiles
    };

    zipFile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "manifest.json");
    zipFile.end();

    const zipInfo = await zipPipelinePromise;
    ctx.throwIfCancelled();

    await fsp.rename(tempZipPath, finalZipPath);

    db.raw
      .prepare(
        `UPDATE backups
         SET status = 'ready',
             size_bytes = ?,
             sha256 = ?,
             file_count = ?,
             last_error = NULL
         WHERE id = ?`
      )
      .run(zipInfo.sizeBytes, zipInfo.sha256, manifestFiles.length, backupId);

    ctx.updateProgress({ stage: "completed", current: totalSteps, total: totalSteps });

    return {
      backupId,
      kind,
      sizeBytes: zipInfo.sizeBytes,
      sha256: zipInfo.sha256,
      fileCount: manifestFiles.length,
      dbSha256: dbHashInfo.sha256
    };
  } catch (err) {
    abortZip?.(err);
    if (zipPipelinePromise) {
      await zipPipelinePromise.catch(() => {});
    }
    const message = err instanceof Error ? err.message : String(err);
    db.raw
      .prepare("UPDATE backups SET status = 'failed', last_error = ? WHERE id = ?")
      .run(message, backupId);
    await fsp.rm(tempZipPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    ctx.signal.removeEventListener("abort", onContextAbort);
    if (zipPipelinePromise) {
      await zipPipelinePromise.catch(() => {});
    }
    if (zipOutputStream) {
      zipOutputStream.on("error", () => {});
    }
    await fsp.rm(snapshotDbPath, { force: true }).catch(() => {});
  }
}
