import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import type { StorageRegistry } from "../../storage/registry.js";
import type { JobWorker } from "../jobs/worker.js";
import { recordActivity } from "../system/activity.js";
import {
  buildStandardOpenExportStream,
  enqueueReleaseExport,
  getExportDownloadInfo
} from "./exporter.js";
import {
  createRelease,
  getReleaseDetail,
  listListingReleases,
  restoreReleaseToNewDraft
} from "./service.js";
import {
  createExportTemplate,
  exportTemplateRulesSchema,
  getExportTemplate,
  listExportTemplates,
  updateExportTemplate
} from "./templates.js";
import { validateListingForRelease } from "./validator.js";

function toAsciiHeaderFilename(fileName: string): string {
  const sanitized = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\;]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "download.zip";
}

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(64),
  market: z.string().trim().min(1).max(32),
  isDefault: z.boolean().optional(),
  rules: exportTemplateRulesSchema
});

const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(64).optional(),
  market: z.string().trim().min(1).max(32).optional(),
  isDefault: z.boolean().optional(),
  rules: exportTemplateRulesSchema.optional()
});

const validateListingSchema = z.object({
  templateId: z.string().trim().min(1).optional()
});

const createReleaseSchema = z.object({
  templateId: z.string().trim().min(1).optional(),
  isDraftPackage: z.boolean().optional().default(false),
  note: z.string().max(1000).optional()
});

const restoreDraftSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  storeId: z.string().trim().min(1).optional()
});

const standardExportSchema = z.object({
  productId: z.string().trim().min(1).optional(),
  assetIds: z.array(z.string().trim().min(1)).max(5000).optional(),
  includeAllVersions: z.boolean().optional().default(false)
});

export function registerReleaseRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  worker: JobWorker
): void {
  const requireAuth = createRequireAuthHook(db);

  // Export Templates
  app.get("/api/v1/export-templates", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { platform?: string; market?: string };
    return {
      items: listExportTemplates(db, {
        platform: query.platform?.trim() || undefined,
        market: query.market?.trim() || undefined
      })
    };
  });

  app.get("/api/v1/export-templates/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getExportTemplate(db, id);
  });

  app.post("/api/v1/export-templates", { preHandler: requireAuth }, async (request, reply) => {
    const body = createTemplateSchema.parse(request.body);
    const created = createExportTemplate(db, request.authUser!.id, body);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/export-templates/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateTemplateSchema.parse(request.body);
    return updateExportTemplate(db, request.authUser!.id, id, body);
  });

  // Listing Preflight Validation
  app.post("/api/v1/listings/:id/validate", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = validateListingSchema.parse(request.body ?? {});
    const result = await validateListingForRelease(db, storageRegistry, id, body.templateId);
    return result.validation;
  });

  // Immutable Releases
  app.post("/api/v1/listings/:id/releases", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createReleaseSchema.parse(request.body ?? {});
    const created = await createRelease(db, storageRegistry, request.authUser!.id, id, body);
    return reply.status(201).send(created);
  });

  app.get("/api/v1/listings/:id/releases", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return { items: listListingReleases(db, id) };
  });

  app.get("/api/v1/releases/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getReleaseDetail(db, id);
  });

  app.post(
    "/api/v1/releases/:id/restore-draft",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = restoreDraftSchema.parse(request.body ?? {});
      const listing = restoreReleaseToNewDraft(db, request.authUser!.id, id, body);
      return reply.status(201).send(listing);
    }
  );

  // Release ZIP Exports
  app.post(
    "/api/v1/releases/:id/exports",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = enqueueReleaseExport(db, worker, request.authUser!.id, id);
      return reply.status(202).send(result);
    }
  );

  app.get(
    "/api/v1/exports/:exportId/download",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { exportId } = request.params as { exportId: string };
      const info = getExportDownloadInfo(db, config, exportId);
      reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="${toAsciiHeaderFilename(info.fileName)}"; filename*=UTF-8''${encodeURIComponent(info.fileName)}`
        )
        .header("Content-Length", String(info.sizeBytes))
        .header("Cache-Control", "no-store");
      return reply.send(fs.createReadStream(info.absPath));
    }
  );

  // Open Standard Portable Asset Export
  app.post(
    "/api/v1/assets/export-standard",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = standardExportSchema.parse(request.body ?? {});
      const { stream, fileName, fileCount } = buildStandardOpenExportStream(
        db,
        storageRegistry,
        body
      );
      recordActivity(db, {
        actorUserId: request.authUser!.id,
        action: "asset.export_standard",
        objectType: "asset",
        objectId: body.productId ?? null,
        details: { fileName, fileCount, includeAllVersions: body.includeAllVersions }
      });
      reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="${toAsciiHeaderFilename(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
        )
        .header("Cache-Control", "no-store");
      return reply.send(stream);
    }
  );
}
