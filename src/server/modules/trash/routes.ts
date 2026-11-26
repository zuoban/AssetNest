import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import { listTrash, restoreFromTrash } from "./service.js";

const restoreSchema = z.object({
  type: z.enum(["asset", "product"]),
  ids: z.array(z.string().uuid()).min(1).max(200)
});

export function registerTrashRoutes(app: FastifyInstance, db: AppDatabase): void {
  const requireAuth = createRequireAuthHook(db);

  app.get("/api/v1/trash", { preHandler: requireAuth }, async () => {
    return listTrash(db);
  });

  app.post("/api/v1/trash/restore", { preHandler: requireAuth }, async (request) => {
    const body = restoreSchema.parse(request.body);
    return restoreFromTrash(db, request.authUser!.id, body);
  });
}
