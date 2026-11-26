import type { AppDatabase } from "../../db/database.js";

export type SearchEntityType = "asset" | "product" | "listing";

export function upsertSearchDocument(
  db: AppDatabase,
  entityType: SearchEntityType,
  entityId: string,
  searchText: string
): void {
  const normalized = searchText.replace(/\s+/g, " ").trim();
  const now = new Date().toISOString();

  db.raw
    .prepare(
      `INSERT INTO search_documents (entity_type, entity_id, search_text, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         search_text = excluded.search_text,
         updated_at = excluded.updated_at`
    )
    .run(entityType, entityId, normalized, now);

  db.raw
    .prepare("DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?")
    .run(entityType, entityId);

  if (normalized.length > 0) {
    db.raw
      .prepare("INSERT INTO search_fts (entity_type, entity_id, search_text) VALUES (?, ?, ?)")
      .run(entityType, entityId, normalized);
  }
}

export function removeSearchDocument(
  db: AppDatabase,
  entityType: SearchEntityType,
  entityId: string
): void {
  db.raw
    .prepare("DELETE FROM search_documents WHERE entity_type = ? AND entity_id = ?")
    .run(entityType, entityId);
  db.raw
    .prepare("DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?")
    .run(entityType, entityId);
}

export function rebuildProductSearchDocument(db: AppDatabase, productId: string): void {
  const product = db.raw
    .prepare(
      `SELECT id, spu, name_zh, name_en, category, brand_model, supplier_name, notes, deleted_at
       FROM products WHERE id = ?`
    )
    .get(productId) as
    | {
        id: string;
        spu: string;
        name_zh: string;
        name_en: string;
        category: string;
        brand_model: string;
        supplier_name: string;
        notes: string;
        deleted_at: string | null;
      }
    | undefined;

  if (!product || product.deleted_at !== null) {
    removeSearchDocument(db, "product", productId);
    return;
  }

  const specs = db.raw
    .prepare("SELECT spec_key, spec_value, unit FROM product_specs WHERE product_id = ?")
    .all(productId) as Array<{ spec_key: string; spec_value: string; unit: string }>;

  const skus = db.raw
    .prepare("SELECT code, name, attributes_json FROM skus WHERE product_id = ?")
    .all(productId) as Array<{ code: string; name: string; attributes_json: string }>;

  const parts: string[] = [
    product.spu,
    product.name_zh,
    product.name_en,
    product.category,
    product.brand_model,
    product.supplier_name,
    product.notes,
    ...specs.map((spec) => `${spec.spec_key} ${spec.spec_value} ${spec.unit}`),
    ...skus.map((sku) => `${sku.code} ${sku.name} ${sku.attributes_json}`)
  ];

  upsertSearchDocument(db, "product", productId, parts.filter(Boolean).join(" "));
}

export function rebuildAssetSearchDocument(db: AppDatabase, assetId: string): void {
  const asset = db.raw
    .prepare(
      `SELECT a.id, a.name, a.original_filename, a.purpose, a.source, a.notes, a.deleted_at,
              f.name AS folder_name
       FROM assets a
       LEFT JOIN folders f ON f.id = a.folder_id
       WHERE a.id = ?`
    )
    .get(assetId) as
    | {
        id: string;
        name: string;
        original_filename: string;
        purpose: string;
        source: string;
        notes: string;
        deleted_at: string | null;
        folder_name: string | null;
      }
    | undefined;

  if (!asset || asset.deleted_at !== null) {
    removeSearchDocument(db, "asset", assetId);
    return;
  }

  const versions = db.raw
    .prepare("SELECT original_filename, change_note, prompt_text, review_note FROM asset_versions WHERE asset_id = ?")
    .all(assetId) as Array<{
    original_filename: string;
    change_note: string;
    prompt_text: string;
    review_note: string;
  }>;

  const tags = db.raw
    .prepare(
      `SELECT t.name, t.dimension
       FROM asset_tags at
       JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = ?`
    )
    .all(assetId) as Array<{ name: string; dimension: string }>;

  const products = db.raw
    .prepare(
      `SELECT p.spu, p.name_zh, p.name_en, p.category, p.brand_model
       FROM product_assets pa
       JOIN products p ON p.id = pa.product_id
       WHERE pa.asset_id = ? AND p.deleted_at IS NULL`
    )
    .all(assetId) as Array<{
    spu: string;
    name_zh: string;
    name_en: string;
    category: string;
    brand_model: string;
  }>;

  const parts: string[] = [
    asset.name,
    asset.original_filename,
    asset.purpose,
    asset.source,
    asset.notes,
    asset.folder_name ?? "",
    ...versions.map((ver) => `${ver.original_filename} ${ver.change_note} ${ver.prompt_text} ${ver.review_note}`),
    ...tags.map((tag) => `${tag.dimension} ${tag.name}`),
    ...products.map((prod) => `${prod.spu} ${prod.name_zh} ${prod.name_en} ${prod.category} ${prod.brand_model}`)
  ];

  upsertSearchDocument(db, "asset", assetId, parts.filter(Boolean).join(" "));
}

export function rebuildProductLinkedAssetSearchDocuments(db: AppDatabase, productId: string): void {
  const rows = db.raw
    .prepare("SELECT asset_id FROM product_assets WHERE product_id = ?")
    .all(productId) as Array<{ asset_id: string }>;
  for (const row of rows) {
    rebuildAssetSearchDocument(db, row.asset_id);
  }
}

export function rebuildListingSearchDocument(db: AppDatabase, listingId: string): void {
  const exists = db.raw
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'listings'")
    .get() as { ok: number } | undefined;
  if (!exists) {
    return;
  }

  const row = db.raw
    .prepare(
      `SELECT
         l.id, l.display_name, l.language, l.external_id, l.notes, l.deleted_at,
         p.spu, p.name_zh, p.name_en,
         s.name AS store_name, s.platform, s.market,
         d.content_json
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN stores s ON s.id = l.store_id
       LEFT JOIN listing_pdp_drafts d ON d.listing_id = l.id
       WHERE l.id = ?`
    )
    .get(listingId) as
    | {
        id: string;
        display_name: string;
        language: string;
        external_id: string | null;
        notes: string;
        deleted_at: string | null;
        spu: string;
        name_zh: string;
        name_en: string;
        store_name: string;
        platform: string;
        market: string;
        content_json: string | null;
      }
    | undefined;

  if (!row || row.deleted_at !== null) {
    removeSearchDocument(db, "listing", listingId);
    return;
  }

  let pdpParts: string[] = [];
  if (row.content_json) {
    try {
      const pdp = JSON.parse(row.content_json) as {
        title?: string;
        shortDescription?: string;
        bullets?: string[];
        fullDescription?: string;
        seoKeywords?: string;
      };
      pdpParts = [
        pdp.title ?? "",
        pdp.shortDescription ?? "",
        ...(Array.isArray(pdp.bullets) ? pdp.bullets : []),
        pdp.fullDescription ?? "",
        pdp.seoKeywords ?? ""
      ];
    } catch {
      // ignore malformed json
    }
  }

  const parts = [
    row.display_name,
    row.language,
    row.external_id ?? "",
    row.notes,
    row.spu,
    row.name_zh,
    row.name_en,
    row.store_name,
    row.platform,
    row.market,
    ...pdpParts
  ];

  upsertSearchDocument(db, "listing", listingId, parts.filter(Boolean).join(" "));
}

function escapeFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export function searchEntityIds(
  db: AppDatabase,
  entityType: SearchEntityType,
  rawQuery: string
): string[] {
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return [];
  }

  const longTokens = tokens.filter((token) => Array.from(token).length >= 3);
  const shortTokens = tokens.filter((token) => Array.from(token).length < 3);

  const clauses: string[] = ["sd.entity_type = ?"];
  const params: Array<string> = [entityType];

  if (longTokens.length > 0) {
    const matchQuery = longTokens.map(escapeFtsPhrase).join(" AND ");
    clauses.push(
      `sd.entity_id IN (SELECT entity_id FROM search_fts WHERE entity_type = ? AND search_fts MATCH ?)`
    );
    params.push(entityType, matchQuery);
  }

  for (const token of shortTokens) {
    clauses.push("instr(lower(sd.search_text), lower(?)) > 0");
    params.push(token);
  }

  const ftsRows = db.raw
    .prepare(`SELECT sd.entity_id FROM search_documents sd WHERE ${clauses.join(" AND ")}`)
    .all(...params) as Array<{ entity_id: string }>;

  if (ftsRows.length > 0 || longTokens.length === 0) {
    return ftsRows.map((row) => row.entity_id);
  }

  const fallbackClauses = ["entity_type = ?"];
  const fallbackParams: Array<string> = [entityType];
  for (const token of tokens) {
    fallbackClauses.push("instr(lower(search_text), lower(?)) > 0");
    fallbackParams.push(token);
  }
  const fallbackRows = db.raw
    .prepare(`SELECT entity_id FROM search_documents WHERE ${fallbackClauses.join(" AND ")}`)
    .all(...fallbackParams) as Array<{ entity_id: string }>;
  return fallbackRows.map((row) => row.entity_id);
}
