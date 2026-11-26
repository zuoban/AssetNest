import crypto from "node:crypto";
import type {
  AppearanceConstraints,
  PaginatedResponse,
  ProductDetail,
  ProductSpec,
  ProductStatus,
  ProductSummary,
  SkuRecord,
  SkuStatus
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import {
  buildEntitySearchClause,
  rebuildProductLinkedAssetSearchDocuments,
  rebuildProductSearchDocument
} from "../search/service.js";
import { recordActivity } from "../system/activity.js";

export interface ProductListQuery {
  q?: string;
  status?: ProductStatus;
  category?: string;
  page: number;
  pageSize: number;
}

export interface CreateProductInput {
  spu: string;
  nameZh: string;
  nameEn?: string;
  category?: string;
  brandModel?: string;
  supplierName?: string;
  supplierUrl?: string;
  status?: ProductStatus;
  notes?: string;
  appearanceConstraints?: AppearanceConstraints;
  specs?: Array<{ specKey: string; specValue: string; unit?: string; position?: number }>;
}

export interface UpdateProductInput {
  spu?: string;
  nameZh?: string;
  nameEn?: string;
  category?: string;
  brandModel?: string;
  supplierName?: string;
  supplierUrl?: string;
  coverVersionId?: string | null;
  status?: ProductStatus;
  notes?: string;
  appearanceConstraints?: AppearanceConstraints;
  specs?: Array<{ specKey: string; specValue: string; unit?: string; position?: number }>;
}

export interface CreateSkuInput {
  code: string;
  name: string;
  attributes: Record<string, string>;
  extraSpecs?: Array<{ specKey: string; specValue: string; unit?: string }>;
  primaryAssetVersionId?: string | null;
  status?: SkuStatus;
}

export interface UpdateSkuInput {
  code?: string;
  name?: string;
  attributes?: Record<string, string>;
  extraSpecs?: Array<{ specKey: string; specValue: string; unit?: string }>;
  primaryAssetVersionId?: string | null;
  status?: SkuStatus;
}

interface ProductRow {
  id: string;
  spu: string;
  name_zh: string;
  name_en: string;
  category: string;
  brand_model: string;
  supplier_name: string;
  supplier_url: string;
  cover_version_id: string | null;
  cover_asset_id: string | null;
  status: ProductStatus;
  notes: string;
  appearance_constraints_json: string;
  sku_count: number;
  asset_count: number;
  created_at: string;
  updated_at: string;
}

interface SkuRow {
  id: string;
  product_id: string;
  code: string;
  name: string;
  attributes_json: string;
  attributes_canonical: string;
  extra_specs_json: string;
  primary_asset_version_id: string | null;
  status: SkuStatus;
  created_at: string;
  updated_at: string;
}

export function canonicalizeSkuAttributes(attributes: Record<string, string>): {
  normalized: Record<string, string>;
  canonical: string;
} {
  const entries = Object.entries(attributes)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey, "en"));

  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    normalized[key] = value;
  }
  const canonical = JSON.stringify(
    entries.map(([key, value]) => [key.toLowerCase(), value.toLowerCase()])
  );
  return { normalized, canonical };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapProductSummary(row: ProductRow): ProductSummary {
  return {
    id: row.id,
    spu: row.spu,
    nameZh: row.name_zh,
    nameEn: row.name_en,
    category: row.category,
    brandModel: row.brand_model,
    supplierName: row.supplier_name,
    supplierUrl: row.supplier_url,
    coverVersionId: row.cover_version_id,
    coverAssetId: row.cover_asset_id,
    status: row.status,
    notes: row.notes,
    skuCount: Number(row.sku_count ?? 0),
    assetCount: Number(row.asset_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSkuRow(row: SkuRow): SkuRecord {
  return {
    id: row.id,
    productId: row.product_id,
    code: row.code,
    name: row.name,
    attributes: safeJsonParse<Record<string, string>>(row.attributes_json, {}),
    attributesCanonical: row.attributes_canonical,
    extraSpecs: safeJsonParse<Array<{ specKey: string; specValue: string; unit?: string }>>(
      row.extra_specs_json,
      []
    ),
    primaryAssetVersionId: row.primary_asset_version_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.toUpperCase().includes("UNIQUE");
}

export function listProducts(
  db: AppDatabase,
  query: ProductListQuery
): PaginatedResponse<ProductSummary> {
  const clauses: string[] = ["p.deleted_at IS NULL"];
  const params: Array<string | number> = [];

  if (query.status) {
    clauses.push("p.status = ?");
    params.push(query.status);
  }
  if (query.category) {
    clauses.push("p.category = ?");
    params.push(query.category);
  }

  if (query.q && query.q.trim().length > 0) {
    const searchPredicate = buildEntitySearchClause(db, "product", "p.id", query.q);
    if (searchPredicate) {
      if (searchPredicate.empty) {
        return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
      }
      clauses.push(searchPredicate.clause);
      params.push(...searchPredicate.params);
    }
  }

  const whereSql = clauses.join(" AND ");
  const countRow = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM products p WHERE ${whereSql}`)
    .get(...params) as { count: number };

  const offset = (query.page - 1) * query.pageSize;
  const rows = db.raw
    .prepare(
      `SELECT
         p.id, p.spu, p.name_zh, p.name_en, p.category, p.brand_model,
         p.supplier_name, p.supplier_url, p.cover_version_id,
         (SELECT av.asset_id FROM asset_versions av WHERE av.id = p.cover_version_id) AS cover_asset_id,
         p.status, p.notes, p.appearance_constraints_json, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id) AS sku_count,
         (SELECT COUNT(*) FROM product_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.product_id = p.id AND a.deleted_at IS NULL) AS asset_count
       FROM products p
       WHERE ${whereSql}
       ORDER BY p.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, query.pageSize, offset) as unknown as ProductRow[];

  return {
    items: rows.map(mapProductSummary),
    total: Number(countRow.count ?? 0),
    page: query.page,
    pageSize: query.pageSize
  };
}

export function getProductDetail(db: AppDatabase, productId: string): ProductDetail {
  const row = db.raw
    .prepare(
      `SELECT
         p.id, p.spu, p.name_zh, p.name_en, p.category, p.brand_model,
         p.supplier_name, p.supplier_url, p.cover_version_id,
         (SELECT av.asset_id FROM asset_versions av WHERE av.id = p.cover_version_id) AS cover_asset_id,
         p.status, p.notes, p.appearance_constraints_json, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id) AS sku_count,
         (SELECT COUNT(*) FROM product_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.product_id = p.id AND a.deleted_at IS NULL) AS asset_count
       FROM products p
       WHERE p.id = ? AND p.deleted_at IS NULL`
    )
    .get(productId) as unknown as ProductRow | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "商品不存在或已进入回收站");
  }

  const specRows = db.raw
    .prepare(
      `SELECT id, spec_key, spec_value, unit, position
       FROM product_specs
       WHERE product_id = ?
       ORDER BY position ASC, rowid ASC`
    )
    .all(productId) as Array<{
    id: string;
    spec_key: string;
    spec_value: string;
    unit: string;
    position: number;
  }>;

  const skuRows = db.raw
    .prepare(
      `SELECT id, product_id, code, name, attributes_json, attributes_canonical,
              extra_specs_json, primary_asset_version_id, status, created_at, updated_at
       FROM skus
       WHERE product_id = ?
       ORDER BY created_at ASC`
    )
    .all(productId) as unknown as SkuRow[];

  const specs: ProductSpec[] = specRows.map((spec) => ({
    id: spec.id,
    specKey: spec.spec_key,
    specValue: spec.spec_value,
    unit: spec.unit,
    position: spec.position
  }));

  return {
    ...mapProductSummary(row),
    appearanceConstraints: safeJsonParse<AppearanceConstraints>(row.appearance_constraints_json, {}),
    specs,
    skus: skuRows.map(mapSkuRow)
  };
}

export function createProduct(
  db: AppDatabase,
  actorUserId: string,
  input: CreateProductInput
): ProductDetail {
  const productId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      db.raw
        .prepare(
          `INSERT INTO products (
             id, spu, name_zh, name_en, category, brand_model,
             supplier_name, supplier_url, status, notes,
             appearance_constraints_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          productId,
          input.spu.trim(),
          input.nameZh.trim(),
          (input.nameEn ?? "").trim(),
          (input.category ?? "").trim(),
          (input.brandModel ?? "").trim(),
          (input.supplierName ?? "").trim(),
          (input.supplierUrl ?? "").trim(),
          input.status ?? "active",
          input.notes ?? "",
          JSON.stringify(input.appearanceConstraints ?? {}),
          now,
          now
        );

      if (input.specs && input.specs.length > 0) {
        const insertSpec = db.raw.prepare(
          `INSERT INTO product_specs (id, product_id, spec_key, spec_value, unit, position)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        input.specs.forEach((spec, index) => {
          if (!spec.specKey.trim() || !spec.specValue.trim()) {
            return;
          }
          insertSpec.run(
            crypto.randomUUID(),
            productId,
            spec.specKey.trim(),
            spec.specValue.trim(),
            (spec.unit ?? "").trim(),
            spec.position ?? index
          );
        });
      }

      rebuildProductSearchDocument(db, productId);
      recordActivity(db, {
        actorUserId,
        action: "product.create",
        objectType: "product",
        objectId: productId,
        details: { spu: input.spu.trim(), nameZh: input.nameZh.trim() }
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AppError(409, "CONFLICT", `SPU "${input.spu.trim()}" 已存在`);
    }
    throw err;
  }

  return getProductDetail(db, productId);
}

export function updateProduct(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  input: UpdateProductInput
): ProductDetail {
  const existing = db.raw
    .prepare("SELECT id, spu FROM products WHERE id = ? AND deleted_at IS NULL")
    .get(productId) as { id: string; spu: string } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "商品不存在或已进入回收站");
  }

  if (input.coverVersionId) {
    const ver = db.raw
      .prepare("SELECT id FROM asset_versions WHERE id = ?")
      .get(input.coverVersionId);
    if (!ver) {
      throw new AppError(400, "VALIDATION_ERROR", "指定的封面素材版本不存在");
    }
  }

  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      const sets: string[] = ["updated_at = ?"];
      const params: Array<string | null> = [now];

      if (input.spu !== undefined) {
        sets.push("spu = ?");
        params.push(input.spu.trim());
      }
      if (input.nameZh !== undefined) {
        sets.push("name_zh = ?");
        params.push(input.nameZh.trim());
      }
      if (input.nameEn !== undefined) {
        sets.push("name_en = ?");
        params.push(input.nameEn.trim());
      }
      if (input.category !== undefined) {
        sets.push("category = ?");
        params.push(input.category.trim());
      }
      if (input.brandModel !== undefined) {
        sets.push("brand_model = ?");
        params.push(input.brandModel.trim());
      }
      if (input.supplierName !== undefined) {
        sets.push("supplier_name = ?");
        params.push(input.supplierName.trim());
      }
      if (input.supplierUrl !== undefined) {
        sets.push("supplier_url = ?");
        params.push(input.supplierUrl.trim());
      }
      if (input.coverVersionId !== undefined) {
        sets.push("cover_version_id = ?");
        params.push(input.coverVersionId);
      }
      if (input.status !== undefined) {
        sets.push("status = ?");
        params.push(input.status);
      }
      if (input.notes !== undefined) {
        sets.push("notes = ?");
        params.push(input.notes);
      }
      if (input.appearanceConstraints !== undefined) {
        sets.push("appearance_constraints_json = ?");
        params.push(JSON.stringify(input.appearanceConstraints));
      }

      db.raw
        .prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params, productId);

      if (input.specs !== undefined) {
        db.raw.prepare("DELETE FROM product_specs WHERE product_id = ?").run(productId);
        const insertSpec = db.raw.prepare(
          `INSERT INTO product_specs (id, product_id, spec_key, spec_value, unit, position)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        input.specs.forEach((spec, index) => {
          if (!spec.specKey.trim() || !spec.specValue.trim()) {
            return;
          }
          insertSpec.run(
            crypto.randomUUID(),
            productId,
            spec.specKey.trim(),
            spec.specValue.trim(),
            (spec.unit ?? "").trim(),
            spec.position ?? index
          );
        });
      }

      rebuildProductSearchDocument(db, productId);
      rebuildProductLinkedAssetSearchDocuments(db, productId);
      recordActivity(db, {
        actorUserId,
        action: "product.update",
        objectType: "product",
        objectId: productId,
        details: { updatedFields: Object.keys(input) }
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AppError(409, "CONFLICT", `SPU "${input.spu?.trim()}" 已存在`);
    }
    throw err;
  }

  return getProductDetail(db, productId);
}

export function softDeleteProduct(
  db: AppDatabase,
  actorUserId: string,
  productId: string
): {
  id: string;
  deletedAt: string;
  impact: {
    skuCount: number;
    linkedAssetCount: number;
    listingCount: number;
    masterImageCount: number;
    warning: string | null;
  };
} {
  const existing = db.raw
    .prepare("SELECT id, spu, name_zh FROM products WHERE id = ? AND deleted_at IS NULL")
    .get(productId) as { id: string; spu: string; name_zh: string } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "商品不存在或已在回收站中");
  }

  const skuCount = (
    db.raw.prepare("SELECT COUNT(*) AS count FROM skus WHERE product_id = ?").get(productId) as {
      count: number;
    }
  ).count;
  const linkedAssetCount = (
    db.raw
      .prepare(
        `SELECT COUNT(*) AS count
         FROM product_assets pa
         JOIN assets a ON a.id = pa.asset_id
         WHERE pa.product_id = ? AND a.deleted_at IS NULL`
      )
      .get(productId) as { count: number }
  ).count;

  const hasListingsTable = Boolean(
    db.raw
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'listings'")
      .get()
  );
  const listingCount = hasListingsTable
    ? (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM listings WHERE product_id = ? AND deleted_at IS NULL")
          .get(productId) as { count: number }
      ).count
    : 0;
  const hasMasterTable = Boolean(
    db.raw
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'product_master_images'"
      )
      .get()
  );
  const masterImageCount = hasMasterTable
    ? (
        db.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM product_master_images WHERE product_id = ? AND unlocked_at IS NULL"
          )
          .get(productId) as { count: number }
      ).count
    : 0;

  const deletedAt = new Date().toISOString();
  db.transaction(() => {
    db.raw
      .prepare("UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt, deletedAt, productId);
    rebuildProductSearchDocument(db, productId);
    rebuildProductLinkedAssetSearchDocuments(db, productId);
    recordActivity(db, {
      actorUserId,
      action: "product.soft_delete",
      objectType: "product",
      objectId: productId,
      details: { spu: existing.spu, skuCount, linkedAssetCount, listingCount, masterImageCount }
    });
  });

  const warning =
    skuCount > 0 || linkedAssetCount > 0 || listingCount > 0 || masterImageCount > 0
      ? `该商品包含 ${skuCount} 个 SKU、${linkedAssetCount} 条素材、${masterImageCount} 张锁定母图与 ${listingCount} 条上架链接；已软删除至回收站，恢复后将保留全部关联。`
      : null;

  return {
    id: productId,
    deletedAt,
    impact: {
      skuCount,
      linkedAssetCount,
      listingCount,
      masterImageCount,
      warning
    }
  };
}

export function createSku(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  input: CreateSkuInput
): SkuRecord {
  const product = db.raw
    .prepare("SELECT id, spu FROM products WHERE id = ? AND deleted_at IS NULL")
    .get(productId) as { id: string; spu: string } | undefined;

  if (!product) {
    throw new AppError(404, "NOT_FOUND", "所属商品不存在或已删除");
  }

  const { normalized, canonical } = canonicalizeSkuAttributes(input.attributes);
  const skuId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      db.raw
        .prepare(
          `INSERT INTO skus (
             id, product_id, code, name, attributes_json, attributes_canonical,
             extra_specs_json, primary_asset_version_id, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          skuId,
          productId,
          input.code.trim(),
          input.name.trim(),
          JSON.stringify(normalized),
          canonical,
          JSON.stringify(input.extraSpecs ?? []),
          input.primaryAssetVersionId ?? null,
          input.status ?? "active",
          now,
          now
        );

      rebuildProductSearchDocument(db, productId);
      recordActivity(db, {
        actorUserId,
        action: "sku.create",
        objectType: "sku",
        objectId: skuId,
        details: { productId, code: input.code.trim() }
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("skus.code")) {
        throw new AppError(409, "CONFLICT", `SKU 编码 "${input.code.trim()}" 全局已存在`);
      }
      throw new AppError(409, "CONFLICT", "当前商品下已存在相同规格组合的 SKU");
    }
    throw err;
  }

  const row = db.raw
    .prepare("SELECT * FROM skus WHERE id = ?")
    .get(skuId) as unknown as SkuRow;
  return mapSkuRow(row);
}

export function updateSku(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  skuId: string,
  input: UpdateSkuInput
): SkuRecord {
  const existing = db.raw
    .prepare("SELECT * FROM skus WHERE id = ? AND product_id = ?")
    .get(skuId, productId) as unknown as SkuRow | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "SKU 不存在");
  }

  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      const sets: string[] = ["updated_at = ?"];
      const params: Array<string | null> = [now];

      if (input.code !== undefined) {
        sets.push("code = ?");
        params.push(input.code.trim());
      }
      if (input.name !== undefined) {
        sets.push("name = ?");
        params.push(input.name.trim());
      }
      if (input.attributes !== undefined) {
        const { normalized, canonical } = canonicalizeSkuAttributes(input.attributes);
        sets.push("attributes_json = ?", "attributes_canonical = ?");
        params.push(JSON.stringify(normalized), canonical);
      }
      if (input.extraSpecs !== undefined) {
        sets.push("extra_specs_json = ?");
        params.push(JSON.stringify(input.extraSpecs));
      }
      if (input.primaryAssetVersionId !== undefined) {
        sets.push("primary_asset_version_id = ?");
        params.push(input.primaryAssetVersionId);
      }
      if (input.status !== undefined) {
        sets.push("status = ?");
        params.push(input.status);
      }

      db.raw
        .prepare(`UPDATE skus SET ${sets.join(", ")} WHERE id = ? AND product_id = ?`)
        .run(...params, skuId, productId);

      rebuildProductSearchDocument(db, productId);
      recordActivity(db, {
        actorUserId,
        action: "sku.update",
        objectType: "sku",
        objectId: skuId,
        details: { productId, updatedFields: Object.keys(input) }
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("skus.code")) {
        throw new AppError(409, "CONFLICT", `SKU 编码 "${input.code?.trim()}" 全局已存在`);
      }
      throw new AppError(409, "CONFLICT", "当前商品下已存在相同规格组合的 SKU");
    }
    throw err;
  }

  const updated = db.raw
    .prepare("SELECT * FROM skus WHERE id = ?")
    .get(skuId) as unknown as SkuRow;
  return mapSkuRow(updated);
}

export function deleteSku(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  skuId: string
): { deleted: boolean; id: string } {
  const existing = db.raw
    .prepare("SELECT id, code FROM skus WHERE id = ? AND product_id = ?")
    .get(skuId, productId) as { id: string; code: string } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "SKU 不存在");
  }

  const hasListingSkus = Boolean(
    db.raw
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'listing_skus'")
      .get()
  );
  if (hasListingSkus) {
    const ref = db.raw
      .prepare("SELECT COUNT(*) AS count FROM listing_skus WHERE sku_id = ?")
      .get(skuId) as { count: number };
    if (Number(ref.count) > 0) {
      throw new AppError(
        409,
        "CONFLICT",
        `SKU "${existing.code}" 已被 ${ref.count} 条上架链接引用，无法直接删除；请先从对应 Listing 移除或改为停用`
      );
    }
  }

  db.transaction(() => {
    db.raw.prepare("DELETE FROM skus WHERE id = ? AND product_id = ?").run(skuId, productId);
    rebuildProductSearchDocument(db, productId);
    recordActivity(db, {
      actorUserId,
      action: "sku.delete",
      objectType: "sku",
      objectId: skuId,
      details: { productId, code: existing.code }
    });
  });

  return { deleted: true, id: skuId };
}
