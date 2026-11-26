import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import type { JobWorker } from "../jobs/worker.js";
import { enqueueTrashGcJob } from "./gc.js";
import { listTrash, restoreFromTrash } from "./service.js";

const restoreSchema = z.object({
  type: z.enum(["asset", "product", "listing"]),
  ids: z.array(z.string().uuid()).min(1).max(200)
});

const gcRequestSchema = z
  .object({
    forceIgnoreRetention: z.boolean().default(false)
  })
  .optional();

export function registerTrashRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  worker: JobWorker
): void {
  const requireAuth = createRequireAuthHook(db, config);

  app.get("/api/v1/trash", { preHandler: requireAuth }, async () => {
    return listTrash(db);
  });

  app.post("/api/v1/trash/restore", { preHandler: requireAuth }, async (request) => {
    const body = restoreSchema.parse(request.body);
    return restoreFromTrash(db, request.authUser!.id, body);
  });

  app.post("/api/v1/trash/gc", { preHandler: requireAuth }, async (request, reply) => {
    const body = gcRequestSchema.parse(request.body ?? {});
    const job = enqueueTrashGcJob(db, worker, request.authUser!.id, {
      forceIgnoreRetention: body?.forceIgnoreRetention ?? false
    });
    return reply.status(202).send({ job });
  });
}
