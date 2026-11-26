import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { createRequireAuthHook } from "../../http/security.js";
import type { StorageRegistry } from "../../storage/registry.js";
import type { JobWorker } from "../jobs/worker.js";
import { restoreFromBackupZip } from "./restore.js";
import { createBackupJob, getBackupDownloadInfo, listBackups } from "./service.js";

const createBackupSchema = z.object({
  kind: z.enum(["metadata", "full"]).default("metadata")
});

const restoreByIdSchema = z.object({
  backupId: z.string().trim().min(1),
  targetStorageMapping: z.record(z.string(), z.string()).optional()
});

export function registerBackupRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  worker: JobWorker,
  setMaintenanceMode: (enabled: boolean) => void
): void {
  const requireAuth = createRequireAuthHook(db, config);

  app.get("/api/v1/backups", { preHandler: requireAuth }, async () => {
    return { items: listBackups(db) };
  });

  app.post("/api/v1/backups", { preHandler: requireAuth }, async (request, reply) => {
    const body = createBackupSchema.parse(request.body ?? {});
    const created = createBackupJob(db, worker, request.authUser!.id, body.kind);
    return reply.status(202).send(created);
  });

  app.get("/api/v1/backups/:id/download", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const info = getBackupDownloadInfo(db, config, id);
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${info.filename}"`)
      .header("Content-Length", String(info.sizeBytes))
      .header("Cache-Control", "no-store");
    return reply.send(fs.createReadStream(info.absPath));
  });

  app.post("/api/v1/backups/restore", { preHandler: requireAuth }, async (request) => {
    if (request.isMultipart()) {
      await fsp.mkdir(config.uploads.tempDir, { recursive: true });
      const tempZipPath = path.join(
        config.uploads.tempDir,
        `restore-upload-${crypto.randomUUID()}.zip`
      );
      let receivedFile = false;
      let targetStorageMapping: Record<string, string> | undefined;

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === "file") {
            if (receivedFile) {
              part.file.resume();
              continue;
            }
            receivedFile = true;
            await pipeline(part.file, fs.createWriteStream(tempZipPath));
            if (part.file.truncated) {
              throw new AppError(413, "PAYLOAD_TOO_LARGE", "上传的备份文件超出最大限制");
            }
          } else if (part.fieldname === "targetStorageMapping" && typeof part.value === "string") {
            try {
              const parsed = JSON.parse(part.value) as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                targetStorageMapping = parsed as Record<string, string>;
              }
            } catch {
              throw new AppError(400, "VALIDATION_ERROR", "targetStorageMapping JSON 格式无效");
            }
          }
        }

        if (!receivedFile) {
          throw new AppError(400, "VALIDATION_ERROR", "请上传 .zip 格式的备份文件");
        }

        return await restoreFromBackupZip({
          db,
          config,
          storageRegistry,
          worker,
          setMaintenanceMode,
          actorUserId: request.authUser!.id,
          zipPath: tempZipPath,
          targetStorageMapping
        });
      } finally {
        await fsp.rm(tempZipPath, { force: true }).catch(() => {});
      }
    }

    const body = restoreByIdSchema.parse(request.body ?? {});
    const info = getBackupDownloadInfo(db, config, body.backupId);
    return await restoreFromBackupZip({
      db,
      config,
      storageRegistry,
      worker,
      setMaintenanceMode,
      actorUserId: request.authUser!.id,
      zipPath: info.absPath,
      targetStorageMapping: body.targetStorageMapping
    });
  });
}
