import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { BackupKind, RestoreBackupResult } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { getDefaultMigrationsDir, runMigrations } from "../../db/migrator.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import type { JobWorker } from "../jobs/worker.js";
import { rebuildAllSearchDocuments } from "../search/service.js";
import { recordActivity } from "../system/activity.js";
import { syncSystemBootstrapState } from "../system/service.js";

interface BackupManifestFileEntry {
  fileId: string;
  storageId: string;
  objectKey: string;
  zipPath: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

interface BackupManifest {
  formatVersion: number;
  backupId: string;
  kind: BackupKind;
  appVersion?: string;
  schemaVersion: number;
  createdAt: string;
  database: {
    zipPath: string;
    sha256: string;
    sizeBytes: number;
  };
  fileCount: number;
  files: BackupManifestFileEntry[];
}

function getMaxSupportedSchemaVersion(): number {
  const migrationsDir = getDefaultMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f));
  return files.reduce((max, name) => Math.max(max, Number(name.split("_")[0])), 0);
}

function assertSafeZipEntryPath(entryName: string): string {
  if (
    !entryName ||
    entryName.includes("\0") ||
    entryName.includes("\\") ||
    entryName.startsWith("/") ||
    /^[A-Za-z]:/.test(entryName)
  ) {
    throw new AppError(400, "PATH_TRAVERSAL", `备份包包含非法路径条目 "${entryName}"，已中止恢复`);
  }
  const segments = entryName.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new AppError(400, "PATH_TRAVERSAL", `备份包包含路径穿越条目 "${entryName}"，已中止恢复`);
    }
  }
  return entryName;
}

function isSymlinkZipEntry(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
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

async function hashReadableSha256(
  stream: NodeJS.ReadableStream
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk);
    sizeBytes += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function extractZipSafely(zipPath: string, stagingDir: string): Promise<Set<string>> {
  const extracted = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(
          new AppError(
            400,
            "VALIDATION_ERROR",
            `无法打开备份 ZIP 文件，文件可能已损坏：${openErr?.message ?? "unknown error"}`
          )
        );
        return;
      }

      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          // ignore
        }
        reject(err);
      };

      zipfile.on("error", (err) => {
        fail(new AppError(400, "VALIDATION_ERROR", `备份 ZIP 解析失败：${err.message}`));
      });

      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (settled) return;
        try {
          const safeName = assertSafeZipEntryPath(entry.fileName);
          if (isSymlinkZipEntry(entry)) {
            fail(
              new AppError(
                400,
                "PATH_TRAVERSAL",
                `备份包包含符号链接条目 "${safeName}"，出于安全限制已拒绝恢复`
              )
            );
            return;
          }

          const targetPath = path.resolve(stagingDir, safeName);
          const rel = path.relative(stagingDir, targetPath);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            fail(
              new AppError(
                400,
                "PATH_TRAVERSAL",
                `备份包条目 "${safeName}" 解析超出临时目录边界，已中止恢复`
              )
            );
            return;
          }

          if (safeName.endsWith("/")) {
            fs.mkdirSync(targetPath, { recursive: true });
            zipfile.readEntry();
            return;
          }

          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              fail(
                new AppError(
                  400,
                  "VALIDATION_ERROR",
                  `无法读取备份包内文件 "${safeName}"：${streamErr?.message ?? "unknown"}`
                )
              );
              return;
            }
            const out = fs.createWriteStream(targetPath);
            pipeline(readStream, out)
              .then(() => {
                extracted.add(safeName);
                zipfile.readEntry();
              })
              .catch((pipeErr) => {
                fail(
                  new AppError(
                    400,
                    "VALIDATION_ERROR",
                    `解压备份包条目 "${safeName}" 失败：${
                      pipeErr instanceof Error ? pipeErr.message : String(pipeErr)
                    }`
                  )
                );
              });
          });
        } catch (err) {
          fail(err);
        }
      });

      zipfile.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      zipfile.readEntry();
    });
  });

  return extracted;
}

function validateManifestObject(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== "object") {
    throw new AppError(400, "VALIDATION_ERROR", "备份清单 manifest.json 格式无效");
  }
  const obj = raw as Partial<BackupManifest>;
  if (obj.formatVersion !== 1) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `不支持的备份清单格式版本：${String(obj.formatVersion)}`
    );
  }
  if (obj.kind !== "metadata" && obj.kind !== "full") {
    throw new AppError(400, "VALIDATION_ERROR", `无效的备份类型：${String(obj.kind)}`);
  }
  if (typeof obj.schemaVersion !== "number" || !Number.isInteger(obj.schemaVersion) || obj.schemaVersion < 1) {
    throw new AppError(400, "VALIDATION_ERROR", "备份清单缺少有效的 schemaVersion");
  }
  if (
    !obj.database ||
    typeof obj.database.zipPath !== "string" ||
    typeof obj.database.sha256 !== "string" ||
    typeof obj.database.sizeBytes !== "number"
  ) {
    throw new AppError(400, "VALIDATION_ERROR", "备份清单缺少数据库校验信息");
  }
  if (!Array.isArray(obj.files)) {
    throw new AppError(400, "VALIDATION_ERROR", "备份清单缺少 files 列表");
  }
  return obj as BackupManifest;
}

function verifyStagedSqliteDatabase(stagedDbPath: string): void {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(stagedDbPath, { readOnly: true });
    const integrity = probe.prepare("PRAGMA integrity_check;").get() as
      | { integrity_check: string }
      | undefined;
    if (!integrity || integrity.integrity_check !== "ok") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `备份数据库 SQLite 完整性校验失败：${integrity?.integrity_check ?? "unknown"}`
      );
    }

    const requiredTables = [
      "schema_migrations",
      "users",
      "settings",
      "storage_providers",
      "files",
      "assets",
      "asset_versions",
      "products"
    ];
    const existing = new Set(
      (
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
    );
    for (const table of requiredTables) {
      if (!existing.has(table)) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `备份数据库缺少核心表 "${table}"，已拒绝恢复`
        );
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `备份数据库无法打开或已损坏：${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      probe?.close();
    } catch {
      // ignore
    }
  }
}

async function clearDirectoryContents(dirPath: string): Promise<void> {
  if (!fs.existsSync(dirPath)) return;
  const entries = await fsp.readdir(dirPath);
  for (const entry of entries) {
    await fsp.rm(path.join(dirPath, entry), { recursive: true, force: true }).catch(() => {});
  }
}

export interface RestoreFromBackupZipParams {
  db: AppDatabase;
  config: ResolvedAppConfig;
  storageRegistry: StorageRegistry;
  worker: JobWorker;
  setMaintenanceMode: (enabled: boolean) => void;
  actorUserId: string;
  zipPath: string;
  targetStorageMapping?: Record<string, string>;
}

export async function restoreFromBackupZip(
  params: RestoreFromBackupZipParams
): Promise<RestoreBackupResult> {
  const {
    db,
    config,
    storageRegistry,
    worker,
    setMaintenanceMode,
    actorUserId,
    zipPath,
    targetStorageMapping
  } = params;

  if (!fs.existsSync(zipPath)) {
    throw new AppError(404, "NOT_FOUND", "指定的备份压缩包不存在");
  }

  const stagingRoot = path.join(
    config.uploads.tempDir,
    `restore-staging-${crypto.randomUUID()}`
  );
  await fsp.mkdir(stagingRoot, { recursive: true });

  try {
    const extracted = await extractZipSafely(zipPath, stagingRoot);

    if (!extracted.has("manifest.json")) {
      throw new AppError(400, "VALIDATION_ERROR", "备份包缺少 manifest.json 清单文件");
    }
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(await fsp.readFile(path.join(stagingRoot, "manifest.json"), "utf8"));
    } catch {
      throw new AppError(400, "VALIDATION_ERROR", "备份包内 manifest.json JSON 解析失败");
    }
    const manifest = validateManifestObject(manifestRaw);

    const maxSupported = getMaxSupportedSchemaVersion();
    if (manifest.schemaVersion > maxSupported) {
      throw new AppError(
        409,
        "CONFLICT",
        `备份数据库 Schema 版本（v${manifest.schemaVersion}）高于当前程序支持版本（v${maxSupported}），无法恢复`
      );
    }

    const dbZipEntry = assertSafeZipEntryPath(manifest.database.zipPath);
    if (!extracted.has(dbZipEntry)) {
      throw new AppError(400, "VALIDATION_ERROR", `备份包缺少数据库文件 "${dbZipEntry}"`);
    }
    const stagedDbPath = path.resolve(stagingRoot, dbZipEntry);
    const dbHash = await hashFileSha256(stagedDbPath);
    if (dbHash.sizeBytes !== manifest.database.sizeBytes || dbHash.sha256 !== manifest.database.sha256) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "备份数据库 SHA-256 或字节大小校验失败，备份文件可能已损坏或被篡改，现网数据未受影响"
      );
    }
    verifyStagedSqliteDatabase(stagedDbPath);

    const verifiedFiles: Array<{
      entry: BackupManifestFileEntry;
      stagedPath: string;
      targetStorageId: string;
    }> = [];

    if (manifest.kind === "full") {
      const checkedTargets = new Set<string>();

      for (const fileEntry of manifest.files) {
        const safeZipPath = assertSafeZipEntryPath(fileEntry.zipPath);
        if (!extracted.has(safeZipPath)) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            `完整备份缺少物理文件条目 "${safeZipPath}"，已中止恢复且未改动现网数据`
          );
        }
        const stagedFilePath = path.resolve(stagingRoot, safeZipPath);
        const fileHash = await hashFileSha256(stagedFilePath);
        if (fileHash.sizeBytes !== fileEntry.sizeBytes || fileHash.sha256 !== fileEntry.sha256) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            `备份文件 "${safeZipPath}" SHA-256 校验失败，备份已损坏，现网数据保持不变`
          );
        }

        const targetStorageId =
          targetStorageMapping?.[fileEntry.storageId] ?? fileEntry.storageId;
        const provider = storageRegistry.get(targetStorageId);
        if (!provider) {
          throw new AppError(
            503,
            "STORAGE_OFFLINE",
            `恢复目标存储空间 "${targetStorageId}" 当前不可用或未在配置中启用，请先配置该存储或指定映射`
          );
        }

        if (!checkedTargets.has(targetStorageId)) {
          const probe = await provider.testConnection();
          if (!probe.ok) {
            throw new AppError(
              503,
              "STORAGE_OFFLINE",
              `恢复目标存储空间 "${targetStorageId}" 写入权限或连通性校验失败：${probe.message}`
            );
          }
          checkedTargets.add(targetStorageId);
        }

        verifiedFiles.push({
          entry: fileEntry,
          stagedPath: stagedFilePath,
          targetStorageId
        });
      }
    }

    const wasWorkerRunning = worker.isRunning();
    setMaintenanceMode(true);
    try {
      await worker.stop();

      let restoredFileCount = 0;
      let reusedFileCount = 0;

      for (const item of verifiedFiles) {
        const provider = storageRegistry.require(item.targetStorageId);
        let shouldWrite = true;

        if (await provider.exists(item.entry.objectKey)) {
          try {
            const existingStat = await provider.stat(item.entry.objectKey);
            if (existingStat.size === item.entry.sizeBytes) {
              const existingRead = await provider.get(item.entry.objectKey);
              const existingHash = await hashReadableSha256(existingRead.stream);
              if (
                existingHash.sizeBytes === item.entry.sizeBytes &&
                existingHash.sha256 === item.entry.sha256
              ) {
                shouldWrite = false;
                reusedFileCount += 1;
              }
            }
          } catch {
            shouldWrite = true;
          }
        }

        if (shouldWrite) {
          await provider.put(item.entry.objectKey, fs.createReadStream(item.stagedPath), {
            contentLength: item.entry.sizeBytes,
            contentType: item.entry.mimeType,
            sha256: item.entry.sha256
          });
          const afterStat = await provider.stat(item.entry.objectKey);
          if (afterStat.size !== item.entry.sizeBytes) {
            throw new AppError(
              500,
              "INTERNAL_ERROR",
              `文件 "${item.entry.objectKey}" 写入目标存储 "${item.targetStorageId}" 后字节数核对失败`
            );
          }
          restoredFileCount += 1;
        }
      }

      if (targetStorageMapping && Object.keys(targetStorageMapping).length > 0) {
        const stagedDb = new DatabaseSync(stagedDbPath);
        try {
          stagedDb.exec("PRAGMA foreign_keys = OFF;");
          stagedDb.exec("BEGIN IMMEDIATE;");
          for (const [oldId, newId] of Object.entries(targetStorageMapping)) {
            if (oldId === newId) continue;
            stagedDb
              .prepare("UPDATE files SET storage_id = ? WHERE storage_id = ?")
              .run(newId, oldId);
          }
          stagedDb.exec("COMMIT;");
        } catch (err) {
          try {
            stagedDb.exec("ROLLBACK;");
          } catch {
            // ignore
          }
          throw err;
        } finally {
          stagedDb.close();
        }
      }

      db.replaceFileAndReopen(stagedDbPath);

      runMigrations(db);
      syncSystemBootstrapState(db, config);

      const reindexed = rebuildAllSearchDocuments(db);
      await clearDirectoryContents(config.cache.path);

      const actorExists = db.raw
        .prepare("SELECT id FROM users WHERE id = ?")
        .get(actorUserId) as { id: string } | undefined;

      recordActivity(db, {
        actorUserId: actorExists ? actorUserId : null,
        action: "backup.restore",
        objectType: "backup",
        objectId: manifest.backupId,
        details: {
          kind: manifest.kind,
          schemaVersion: manifest.schemaVersion,
          restoredFileCount,
          reusedFileCount,
          reindexed
        }
      });

      return {
        backupId: manifest.backupId,
        kind: manifest.kind,
        schemaVersion: manifest.schemaVersion,
        restoredFileCount,
        reusedFileCount,
        reindexed,
        restoredAt: new Date().toISOString()
      };
    } finally {
      if (wasWorkerRunning) {
        worker.start();
      }
      setMaintenanceMode(false);
    }
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}
