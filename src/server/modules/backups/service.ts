import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import type { BackupKind, BackupRecord } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { getCurrentSchemaVersion } from "../../db/migrator.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { enqueueJob } from "../jobs/service.js";
import type { JobContext, JobWorker } from "../jobs/worker.js";
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

async function hashFileSha256(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    sizeBytes += buf.length;
    hash.update(buf);
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
  const stagedTempFiles: string[] = [];

  try {
    ctx.throwIfCancelled();
    ctx.updateProgress({ stage: "snapshotting_database", current: 0, total: 1 });

    // SQLite consistent snapshot via VACUUM INTO (must run outside transaction)
    const escapedSnapshotPath = snapshotDbPath.replace(/'/g, "''");
    db.raw.exec(`VACUUM INTO '${escapedSnapshotPath}';`);

    const dbHashInfo = await hashFileSha256(snapshotDbPath);

    const filesToInclude =
      kind === "full"
        ? (db.raw
            .prepare(
              `SELECT id, storage_id, object_key, sha256, size_bytes, mime_type
               FROM files
               WHERE state = 'ready'
               ORDER BY storage_id ASC, object_key ASC`
            )
            .all() as Array<{
            id: string;
            storage_id: string;
            object_key: string;
            sha256: string;
            size_bytes: number;
            mime_type: string;
          }>)
        : [];

    const totalSteps = filesToInclude.length + 2;
    ctx.updateProgress({ stage: "packaging_backup", current: 1, total: totalSteps });

    const manifestFiles: Array<{
      fileId: string;
      storageId: string;
      objectKey: string;
      zipPath: string;
      sha256: string;
      sizeBytes: number;
      mimeType: string;
    }> = [];

    const zipFile = new yazl.ZipFile();
    const zipOutputDone = (async () => {
      const hash = crypto.createHash("sha256");
      let zipSize = 0;
      const pass = new PassThrough();
      pass.on("data", (chunk: Buffer) => {
        zipSize += chunk.length;
        hash.update(chunk);
      });
      const writer = fs.createWriteStream(tempZipPath);
      await pipeline(zipFile.outputStream, pass, writer);
      return { sha256: hash.digest("hex"), sizeBytes: zipSize };
    })();

    zipFile.addFile(snapshotDbPath, "assetnest.db");

    for (let index = 0; index < filesToInclude.length; index += 1) {
      const file = filesToInclude[index]!;
      ctx.throwIfCancelled();

      const provider = storageRegistry.get(file.storage_id);
      if (!provider) {
        throw new Error(
          `完整备份失败：文件 ${file.id} 所在存储空间 "${file.storage_id}" 当前离线或缺少配置`
        );
      }

      // Stage each remote/local file into temp while verifying SHA-256 so corrupted objects fail early
      const stagedPath = path.join(
        config.uploads.tempDir,
        `backup-file-${backupId}-${index}-${crypto.randomUUID()}.part`
      );
      stagedTempFiles.push(stagedPath);

      const readRes = await provider.get(file.object_key, { signal: ctx.signal });
      const fileHash = crypto.createHash("sha256");
      let byteCount = 0;
      const out = fs.createWriteStream(stagedPath);
      readRes.stream.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
        fileHash.update(chunk);
      });
      await pipeline(readRes.stream, out);

      const actualSha = fileHash.digest("hex");
      if (byteCount !== Number(file.size_bytes) || actualSha !== file.sha256) {
        throw new Error(
          `完整备份完整性校验失败（file=${file.id}, expected=${file.sha256}, actual=${actualSha}）`
        );
      }

      const zipEntryPath = `files/${file.storage_id}/${file.object_key}`;
      zipFile.addFile(stagedPath, zipEntryPath, { compress: false });
      manifestFiles.push({
        fileId: file.id,
        storageId: file.storage_id,
        objectKey: file.object_key,
        zipPath: zipEntryPath,
        sha256: file.sha256,
        sizeBytes: Number(file.size_bytes),
        mimeType: file.mime_type
      });

      ctx.updateProgress({
        stage: "packaging_backup",
        current: index + 2,
        total: totalSteps
      });
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

    const zipInfo = await zipOutputDone;
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
    const message = err instanceof Error ? err.message : String(err);
    db.raw
      .prepare("UPDATE backups SET status = 'failed', last_error = ? WHERE id = ?")
      .run(message, backupId);
    await fsp.rm(tempZipPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fsp.rm(snapshotDbPath, { force: true }).catch(() => {});
    for (const staged of stagedTempFiles) {
      await fsp.rm(staged, { force: true }).catch(() => {});
    }
  }
}
