import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import {
  getAppSettings,
  getDashboardSummary,
  listActivities,
  listJobs,
  listStorageProviders,
  updateAppSettings
} from "./service.js";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

const updateSettingsSchema = z
  .object({
    trashRetentionDays: z.number().int().min(1).max(365).optional(),
    exportTtlHours: z.number().int().min(1).max(720).optional(),
    appTimezone: z
      .string()
      .min(1)
      .max(64)
      .refine((tz) => {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "无效的 IANA 时区名称")
      .optional()
  })
  .refine(
    (obj) =>
      obj.trashRetentionDays !== undefined ||
      obj.exportTtlHours !== undefined ||
      obj.appTimezone !== undefined,
    { message: "请至少提供一个待更新的设置字段" }
  );

export function registerSystemRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig
): void {
  const requireAuth = createRequireAuthHook(db);

  app.get("/api/v1/dashboard", { preHandler: requireAuth }, async () => {
    return getDashboardSummary(db);
  });

  app.get("/api/v1/settings", { preHandler: requireAuth }, async () => {
    return getAppSettings(db, config.app.timezone);
  });

  app.patch("/api/v1/settings", { preHandler: requireAuth }, async (request) => {
    const body = updateSettingsSchema.parse(request.body);
    return updateAppSettings(db, request.authUser!.id, body, config.app.timezone);
  });

  app.get("/api/v1/storage/providers", { preHandler: requireAuth }, async () => {
    return { items: listStorageProviders(db) };
  });

  app.get("/api/v1/jobs", { preHandler: requireAuth }, async (request) => {
    const query = paginationSchema.parse(request.query);
    return listJobs(db, query.page, query.pageSize);
  });

  app.get("/api/v1/activities", { preHandler: requireAuth }, async (request) => {
    const query = paginationSchema.parse(request.query);
    return listActivities(db, query.page, query.pageSize);
  });
}
