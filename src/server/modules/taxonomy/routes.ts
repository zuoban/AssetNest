import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import {
  createFolder,
  createTag,
  deleteFolder,
  deleteTag,
  listFolders,
  listTags,
  updateFolder,
  updateTag
} from "./service.js";

const tagDimensionEnum = z.enum(["market", "platform", "purpose", "color", "scene", "custom"]);

const createFolderSchema = z.object({
  name: z.string().trim().min(1, "目录名称不能为空").max(80),
  parentId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).optional()
});

const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  parentId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).optional()
});

const createTagSchema = z.object({
  dimension: tagDimensionEnum,
  name: z.string().trim().min(1, "标签名称不能为空").max(60),
  parentId: z.string().trim().min(1).max(120).nullable().optional()
});

const updateTagSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  parentId: z.string().trim().min(1).max(120).nullable().optional()
});

export function registerTaxonomyRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig
): void {
  const requireAuth = createRequireAuthHook(db, config);

  app.get("/api/v1/folders", { preHandler: requireAuth }, async () => {
    return { items: listFolders(db) };
  });

  app.post("/api/v1/folders", { preHandler: requireAuth }, async (request, reply) => {
    const body = createFolderSchema.parse(request.body);
    const folder = createFolder(db, request.authUser!.id, body);
    return reply.status(201).send(folder);
  });

  app.patch("/api/v1/folders/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateFolderSchema.parse(request.body);
    return updateFolder(db, request.authUser!.id, id, body);
  });

  app.delete("/api/v1/folders/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const query = z
      .object({
        recursive: z
          .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
          .optional()
          .transform((val) => val === true || val === "true" || val === "1")
      })
      .parse(request.query);
    return deleteFolder(db, request.authUser!.id, id, { recursive: query.recursive });
  });

  app.get("/api/v1/tags", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ dimension: tagDimensionEnum.optional() }).parse(request.query);
    return { items: listTags(db, query.dimension) };
  });

  app.post("/api/v1/tags", { preHandler: requireAuth }, async (request, reply) => {
    const body = createTagSchema.parse(request.body);
    const tag = createTag(db, request.authUser!.id, body);
    return reply.status(201).send(tag);
  });

  app.patch("/api/v1/tags/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateTagSchema.parse(request.body);
    return updateTag(db, request.authUser!.id, id, body);
  });

  app.delete("/api/v1/tags/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return deleteTag(db, request.authUser!.id, id);
  });
}
