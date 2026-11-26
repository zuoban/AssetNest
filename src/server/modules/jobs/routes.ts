import type { FastifyInstance } from "fastify";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import { cancelJob, getJobById, retryJob } from "./service.js";
import type { JobWorker } from "./worker.js";

export function registerJobRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  worker: JobWorker
): void {
  const requireAuth = createRequireAuthHook(db, config);

  app.get("/api/v1/jobs/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getJobById(db, id);
  });

  app.post("/api/v1/jobs/:id/retry", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const job = retryJob(db, request.authUser!.id, id);
    worker.wake();
    return job;
  });

  app.post("/api/v1/jobs/:id/cancel", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelJob(db, request.authUser!.id, id);
  });
}
