import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import type { JobWorker } from "../jobs/worker.js";
import { createBackupJob, getBackupDownloadInfo, listBackups } from "./service.js";

const createBackupSchema = z.object({
  kind: z.enum(["metadata", "full"]).default("metadata")
});

export function registerBackupRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  worker: JobWorker
): void {
  const requireAuth = createRequireAuthHook(db);

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
}
