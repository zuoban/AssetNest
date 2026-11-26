import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import {
  listProductMasterImages,
  lockProductMasterImage,
  setPrimaryMasterImage,
  unlockProductMasterImage
} from "./master-images.js";
import {
  createProduct,
  createSku,
  deleteSku,
  getProductDetail,
  listProducts,
  softDeleteProduct,
  updateProduct,
  updateSku
} from "./service.js";

const specSchema = z.object({
  specKey: z.string().trim().min(1).max(80),
  specValue: z.string().trim().min(1).max(300),
  unit: z.string().trim().max(40).optional(),
  position: z.number().int().min(0).optional()
});

const appearanceConstraintsSchema = z.object({
  structure: z.string().max(1000).optional(),
  proportion: z.string().max(1000).optional(),
  color: z.string().max(1000).optional(),
  dimensions: z.string().max(1000).optional(),
  forbiddenChanges: z.string().max(1000).optional(),
  referenceNotes: z.string().max(2000).optional(),
  referenceAssetVersionIds: z.array(z.string().uuid()).max(20).optional()
});

const listProductsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  category: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24)
});

const createProductSchema = z.object({
  spu: z.string().trim().min(1, "SPU 不能为空").max(80),
  nameZh: z.string().trim().min(1, "商品中文名不能为空").max(200),
  nameEn: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  brandModel: z.string().trim().max(120).optional(),
  supplierName: z.string().trim().max(120).optional(),
  supplierUrl: z.string().trim().max(500).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  notes: z.string().max(4000).optional(),
  appearanceConstraints: appearanceConstraintsSchema.optional(),
  specs: z.array(specSchema).max(100).optional()
});

const updateProductSchema = z.object({
  spu: z.string().trim().min(1).max(80).optional(),
  nameZh: z.string().trim().min(1).max(200).optional(),
  nameEn: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  brandModel: z.string().trim().max(120).optional(),
  supplierName: z.string().trim().max(120).optional(),
  supplierUrl: z.string().trim().max(500).optional(),
  coverVersionId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  notes: z.string().max(4000).optional(),
  appearanceConstraints: appearanceConstraintsSchema.optional(),
  specs: z.array(specSchema).max(100).optional()
});

const createSkuSchema = z.object({
  code: z.string().trim().min(1, "SKU 编码不能为空").max(80),
  name: z.string().trim().min(1, "SKU 名称不能为空").max(200),
  attributes: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
  extraSpecs: z.array(specSchema).max(50).optional(),
  primaryAssetVersionId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional()
});

const updateSkuSchema = z.object({
  code: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  attributes: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
  extraSpecs: z.array(specSchema).max(50).optional(),
  primaryAssetVersionId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional()
});

const lockMasterImageSchema = z.object({
  assetVersionId: z.string().uuid(),
  angle: z.string().trim().min(1).max(60).default("front"),
  isPrimary: z.boolean().optional(),
  lockNote: z.string().max(500).optional()
});

const unlockMasterImageSchema = z.object({
  unlockNote: z.string().trim().min(1, "请填写解除或替换母图的原因备注").max(500),
  replacementAssetVersionId: z.string().uuid().optional(),
  replacementAngle: z.string().trim().min(1).max(60).optional(),
  replacementLockNote: z.string().max(500).optional()
});

export function registerProductRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig
): void {
  const requireAuth = createRequireAuthHook(db, config);

  app.get("/api/v1/products", { preHandler: requireAuth }, async (request) => {
    const query = listProductsQuerySchema.parse(request.query);
    return listProducts(db, query);
  });

  app.post("/api/v1/products", { preHandler: requireAuth }, async (request, reply) => {
    const body = createProductSchema.parse(request.body);
    const created = createProduct(db, request.authUser!.id, body);
    return reply.status(201).send(created);
  });

  app.get("/api/v1/products/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getProductDetail(db, id);
  });

  app.patch("/api/v1/products/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateProductSchema.parse(request.body);
    return updateProduct(db, request.authUser!.id, id, body);
  });

  app.delete("/api/v1/products/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return softDeleteProduct(db, request.authUser!.id, id);
  });

  app.post("/api/v1/products/:id/skus", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createSkuSchema.parse(request.body);
    const sku = createSku(db, request.authUser!.id, id, body);
    return reply.status(201).send(sku);
  });

  app.patch(
    "/api/v1/products/:id/skus/:skuId",
    { preHandler: requireAuth },
    async (request) => {
      const { id, skuId } = request.params as { id: string; skuId: string };
      const body = updateSkuSchema.parse(request.body);
      return updateSku(db, request.authUser!.id, id, skuId, body);
    }
  );

  app.delete(
    "/api/v1/products/:id/skus/:skuId",
    { preHandler: requireAuth },
    async (request) => {
      const { id, skuId } = request.params as { id: string; skuId: string };
      return deleteSku(db, request.authUser!.id, id, skuId);
    }
  );

  app.get("/api/v1/products/:id/master-images", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const query = z
      .object({
        includeHistory: z
          .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
          .optional()
          .transform((val) => val === true || val === "true" || val === "1")
      })
      .parse(request.query);
    return { items: listProductMasterImages(db, id, query.includeHistory) };
  });

  app.post(
    "/api/v1/products/:id/master-images",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = lockMasterImageSchema.parse(request.body);
      const created = lockProductMasterImage(db, request.authUser!.id, id, body);
      return reply.status(201).send(created);
    }
  );

  app.post(
    "/api/v1/products/:id/master-images/:masterId/primary",
    { preHandler: requireAuth },
    async (request) => {
      const { id, masterId } = request.params as { id: string; masterId: string };
      return setPrimaryMasterImage(db, request.authUser!.id, id, masterId);
    }
  );

  app.post(
    "/api/v1/products/:id/master-images/:masterId/unlock",
    { preHandler: requireAuth },
    async (request) => {
      const { id, masterId } = request.params as { id: string; masterId: string };
      const body = unlockMasterImageSchema.parse(request.body);
      return unlockProductMasterImage(db, request.authUser!.id, id, masterId, body);
    }
  );
}
