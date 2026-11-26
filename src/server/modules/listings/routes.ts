import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AssetSetKind, DictionaryCategory } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { createRequireAuthHook } from "../../http/security.js";
import { getListingAssetSets, replaceListingAssetSet } from "./asset-sets.js";
import {
  listDictionaries,
  updateDictionaryItem,
  upsertDictionaryItem
} from "./dictionaries.js";
import {
  copyListingPdpTo,
  createListingPdpVersion,
  getListingPdp,
  restoreListingPdpVersion,
  saveListingPdpDraft
} from "./pdp.js";
import {
  createListing,
  duplicateListing,
  getListingDetail,
  listListings,
  softDeleteListing,
  syncListingSkus,
  updateListing
} from "./service.js";
import { createStore, deleteStore, listStores, updateStore } from "./stores.js";

const dictionaryCategorySchema = z.enum(["platform", "market", "language"]);
const assetSetKindSchema = z.enum(["carousel", "detail", "sku", "video"]);

const upsertDictionarySchema = z.object({
  category: dictionaryCategorySchema,
  code: z.string().trim().min(1, "编码不能为空").max(40),
  label: z.string().trim().min(1, "名称不能为空").max(80),
  isActive: z.boolean().optional(),
  position: z.number().int().min(0).max(9999).optional()
});

const updateDictionarySchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
  position: z.number().int().min(0).max(9999).optional()
});

const listStoresQuerySchema = z.object({
  q: z.string().max(120).optional(),
  platform: z.string().max(40).optional(),
  market: z.string().max(40).optional(),
  status: z.enum(["active", "archived"]).optional()
});

const createStoreSchema = z.object({
  name: z.string().trim().min(1, "店铺名称不能为空").max(120),
  platform: z.string().trim().min(1, "请选择平台").max(40),
  market: z.string().trim().min(1, "请选择市场").max(40),
  defaultLanguage: z.string().trim().min(1, "请选择默认语言").max(40),
  status: z.enum(["active", "archived"]).optional(),
  notes: z.string().max(1000).optional()
});

const updateStoreSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(40).optional(),
  market: z.string().trim().min(1).max(40).optional(),
  defaultLanguage: z.string().trim().min(1).max(40).optional(),
  status: z.enum(["active", "archived"]).optional(),
  notes: z.string().max(1000).optional()
});

const listListingsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  productId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  platform: z.string().max(40).optional(),
  market: z.string().max(40).optional(),
  status: z.enum(["draft", "ready", "published", "archived"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24)
});

const createListingSchema = z.object({
  productId: z.string().uuid(),
  storeId: z.string().uuid(),
  displayName: z.string().trim().min(1, "上架展示名称不能为空").max(200),
  language: z.string().trim().min(1).max(40).optional(),
  externalId: z.string().max(120).nullable().optional(),
  externalUrl: z.string().max(500).nullable().optional(),
  status: z.enum(["draft", "ready", "published", "archived"]).optional(),
  notes: z.string().max(2000).optional(),
  skuIds: z.array(z.string().uuid()).max(200).optional()
});

const updateListingSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  language: z.string().trim().min(1).max(40).optional(),
  externalId: z.string().max(120).nullable().optional(),
  externalUrl: z.string().max(500).nullable().optional(),
  status: z.enum(["draft", "ready", "published", "archived"]).optional(),
  notes: z.string().max(2000).optional()
});

const duplicateListingSchema = z
  .object({
    storeId: z.string().uuid().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    language: z.string().trim().min(1).max(40).optional()
  })
  .optional();

const syncListingSkusSchema = z.object({
  items: z
    .array(
      z.object({
        skuId: z.string().uuid(),
        channelCode: z.string().max(80).optional(),
        displayName: z.string().max(200).optional()
      })
    )
    .max(200)
});

const replaceAssetSetSchema = z.object({
  items: z
    .array(
      z.object({
        assetVersionId: z.string().uuid(),
        listingSkuId: z.string().uuid().nullable().optional()
      })
    )
    .max(200)
});

const pdpSpecRowSchema = z.object({
  specKey: z.string().max(120),
  specValue: z.string().max(500),
  unit: z.string().max(40).default("")
});

const pdpContentSchema = z.object({
  title: z.string().max(1000).default(""),
  shortDescription: z.string().max(4000).default(""),
  bullets: z.array(z.string().max(1000)).max(50).default([]),
  fullDescription: z.string().max(30000).default(""),
  specs: z.array(pdpSpecRowSchema).max(100).default([]),
  packageList: z.string().max(4000).default(""),
  usageInstructions: z.string().max(8000).default(""),
  seoKeywords: z.string().max(2000).default(""),
  notes: z.string().max(4000).default("")
});

const savePdpDraftSchema = z.object({
  language: z.string().trim().min(1).max(40).optional(),
  content: pdpContentSchema
});

const createPdpVersionSchema = z
  .object({
    note: z.string().max(500).optional()
  })
  .optional();

const copyPdpToSchema = z.object({
  targetListingId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  keepTargetLanguage: z.boolean().optional()
});

export function registerListingRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig
): void {
  const requireAuth = createRequireAuthHook(db, config);

  // Dictionaries
  app.get("/api/v1/dictionaries", { preHandler: requireAuth }, async (request) => {
    const query = z
      .object({
        category: dictionaryCategorySchema.optional(),
        activeOnly: z
          .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
          .optional()
          .transform((val) => val === true || val === "true" || val === "1")
      })
      .parse(request.query);
    return listDictionaries(db, query);
  });

  app.post("/api/v1/dictionaries", { preHandler: requireAuth }, async (request, reply) => {
    const body = upsertDictionarySchema.parse(request.body);
    const item = upsertDictionaryItem(db, request.authUser!.id, body);
    return reply.status(201).send(item);
  });

  app.patch(
    "/api/v1/dictionaries/:category/:code",
    { preHandler: requireAuth },
    async (request) => {
      const params = request.params as { category: string; code: string };
      const category = dictionaryCategorySchema.parse(params.category) as DictionaryCategory;
      const body = updateDictionarySchema.parse(request.body);
      return updateDictionaryItem(db, request.authUser!.id, category, params.code, body);
    }
  );

  // Stores
  app.get("/api/v1/stores", { preHandler: requireAuth }, async (request) => {
    const query = listStoresQuerySchema.parse(request.query);
    return { items: listStores(db, query) };
  });

  app.post("/api/v1/stores", { preHandler: requireAuth }, async (request, reply) => {
    const body = createStoreSchema.parse(request.body);
    const created = createStore(db, request.authUser!.id, body);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/stores/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateStoreSchema.parse(request.body);
    return updateStore(db, request.authUser!.id, id, body);
  });

  app.delete("/api/v1/stores/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return deleteStore(db, request.authUser!.id, id);
  });

  // Listings
  app.get("/api/v1/listings", { preHandler: requireAuth }, async (request) => {
    const query = listListingsQuerySchema.parse(request.query);
    return listListings(db, query);
  });

  app.post("/api/v1/listings", { preHandler: requireAuth }, async (request, reply) => {
    const body = createListingSchema.parse(request.body);
    const created = createListing(db, request.authUser!.id, body);
    return reply.status(201).send(created);
  });

  app.get("/api/v1/listings/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getListingDetail(db, id);
  });

  app.patch("/api/v1/listings/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateListingSchema.parse(request.body);
    return updateListing(db, request.authUser!.id, id, body);
  });

  app.delete("/api/v1/listings/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return softDeleteListing(db, request.authUser!.id, id);
  });

  app.post("/api/v1/listings/:id/duplicate", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = duplicateListingSchema.parse(request.body ?? {});
    const duplicated = duplicateListing(db, request.authUser!.id, id, body ?? {});
    return reply.status(201).send(duplicated);
  });

  app.put("/api/v1/listings/:id/skus", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = syncListingSkusSchema.parse(request.body);
    return syncListingSkus(db, request.authUser!.id, id, body.items);
  });

  // Listing Asset Sets
  app.get("/api/v1/listings/:id/asset-sets", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getListingAssetSets(db, id);
  });

  app.put(
    "/api/v1/listings/:id/asset-sets/:kind",
    { preHandler: requireAuth },
    async (request) => {
      const params = request.params as { id: string; kind: string };
      const kind = assetSetKindSchema.parse(params.kind) as AssetSetKind;
      const body = replaceAssetSetSchema.parse(request.body);
      return replaceListingAssetSet(db, request.authUser!.id, params.id, kind, body.items);
    }
  );

  // Listing PDP
  app.get("/api/v1/listings/:id/pdp", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getListingPdp(db, id);
  });

  app.put("/api/v1/listings/:id/pdp/draft", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = savePdpDraftSchema.parse(request.body);
    return saveListingPdpDraft(db, request.authUser!.id, id, body);
  });

  app.post(
    "/api/v1/listings/:id/pdp/versions",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = createPdpVersionSchema.parse(request.body ?? {});
      const created = createListingPdpVersion(db, request.authUser!.id, id, body ?? {});
      return reply.status(201).send(created);
    }
  );

  app.post(
    "/api/v1/listings/:id/pdp/restore/:versionId",
    { preHandler: requireAuth },
    async (request) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      return restoreListingPdpVersion(db, request.authUser!.id, id, versionId);
    }
  );

  app.post("/api/v1/listings/:id/pdp/copy-to", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = copyPdpToSchema.parse(request.body);
    return copyListingPdpTo(db, request.authUser!.id, id, body);
  });
}
