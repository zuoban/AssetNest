import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import type { StorageRegistry } from "../../storage/registry.js";
import type { JobWorker } from "../jobs/worker.js";
import {
  clearThumbnailCache,
  confirmCleanupQueue,
  createStorageMigrationJob,
  deleteStorageProvider,
  listCleanupQueue,
  previewStorageMigration,
  switchDefaultStorage,
  testStorageProvider
} from "./service.js";

const switchDefaultSchema = z.object({
  storageId: z.string().min(1).max(64)
});

const migrationScopeSchema = z
  .object({
    mode: z.enum(["all", "product", "asset_ids"]).default("all"),
    productId: z.string().uuid().optional(),
    assetIds: z.array(z.string().uuid()).max(500).optional()
  })
  .optional();

const migrationRequestSchema = z.object({
  sourceStorageId: z.string().min(1).max(64),
  targetStorageId: z.string().min(1).max(64),
  scope: migrationScopeSchema
});

const cleanupQuerySchema = z.object({
  status: z.enum(["awaiting_confirmation", "queued", "deleted", "failed"]).optional()
});

const cleanupConfirmSchema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
  allAwaiting: z.boolean().optional()
});

export function registerStorageOpsRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  worker: JobWorker
): void {
  const requireAuth = createRequireAuthHook(db);

  app.post("/api/v1/storage/providers/:id/test", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return testStorageProvider(db, storageRegistry, request.authUser!.id, id);
  });

  app.delete("/api/v1/storage/providers/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return deleteStorageProvider(db, request.authUser!.id, id);
  });

  app.post("/api/v1/storage/default", { preHandler: requireAuth }, async (request) => {
    const body = switchDefaultSchema.parse(request.body);
    return switchDefaultStorage(db, storageRegistry, request.authUser!.id, body.storageId);
  });

  app.post("/api/v1/storage/migrations/preview", { preHandler: requireAuth }, async (request) => {
    const body = migrationRequestSchema.parse(request.body);
    return previewStorageMigration(db, storageRegistry, body);
  });

  app.post("/api/v1/storage/migrations", { preHandler: requireAuth }, async (request, reply) => {
    const body = migrationRequestSchema.parse(request.body);
    const result = await createStorageMigrationJob(
      db,
      storageRegistry,
      worker,
      request.authUser!.id,
      body
    );
    return reply.status(202).send(result);
  });

  app.get("/api/v1/storage/cleanup-queue", { preHandler: requireAuth }, async (request) => {
    const query = cleanupQuerySchema.parse(request.query);
    return listCleanupQueue(db, query.status);
  });

  app.post("/api/v1/storage/cleanup-queue/confirm", { preHandler: requireAuth }, async (request, reply) => {
    const body = cleanupConfirmSchema.parse(request.body);
    const result = confirmCleanupQueue(db, worker, request.authUser!.id, body);
    return reply.status(202).send(result);
  });

  app.post("/api/v1/cache/clear", { preHandler: requireAuth }, async (request) => {
    return clearThumbnailCache(db, config, request.authUser!.id);
  });
}
