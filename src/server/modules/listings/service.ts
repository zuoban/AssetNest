import crypto from "node:crypto";
import type {
  ListingDetail,
  ListingSkuRecord,
  ListingStatus,
  ListingSummary,
  PaginatedResponse,
  SkuStatus
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { buildEntitySearchClause, rebuildListingSearchDocument } from "../search/service.js";
import { recordActivity } from "../system/activity.js";
import { ASSET_SET_KINDS, ensureListingAssetSetsInTx } from "./asset-sets.js";
import { createEmptyPdpContent, parsePdpContentJson } from "./pdp.js";

interface ListingSummaryRow {
  id: string;
  product_id: string;
  product_spu: string;
  product_name_zh: string;
  product_name_en: string;
  store_id: string;
  store_name: string;
  platform: string;
  market: string;
  display_name: string;
  language: string;
  external_id: string | null;
  external_url: string | null;
  status: ListingStatus;
  notes: string;
  sku_count: number;
  carousel_count: number;
  detail_count: number;
  sku_image_count: number;
  video_count: number;
  pdp_version_count: number;
  pdp_content_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ListingSkuJoinedRow {
  id: string;
  listing_id: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  sku_attributes_json: string;
  sku_status: SkuStatus;
  channel_code: string;
  display_name: string;
  position: number;
}

function safeParseAttributes(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function mapListingSummary(row: ListingSummaryRow): ListingSummary {
  const pdpTitle = row.pdp_content_json ? parsePdpContentJson(row.pdp_content_json).title : "";
  return {
    id: row.id,
    productId: row.product_id,
    productSpu: row.product_spu,
    productNameZh: row.product_name_zh,
    productNameEn: row.product_name_en,
    storeId: row.store_id,
    storeName: row.store_name,
    platform: row.platform,
    market: row.market,
    displayName: row.display_name,
    language: row.language,
    externalId: row.external_id,
    externalUrl: row.external_url,
    status: row.status,
    notes: row.notes,
    skuCount: Number(row.sku_count ?? 0),
    carouselCount: Number(row.carousel_count ?? 0),
    detailCount: Number(row.detail_count ?? 0),
    skuImageCount: Number(row.sku_image_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    pdpVersionCount: Number(row.pdp_version_count ?? 0),
    pdpTitle,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const LISTING_SUMMARY_SELECT = `
  SELECT
    l.id, l.product_id, p.spu AS product_spu, p.name_zh AS product_name_zh, p.name_en AS product_name_en,
    l.store_id, s.name AS store_name, s.platform, s.market,
    l.display_name, l.language, l.external_id, l.external_url,
    l.status, l.notes, l.created_at, l.updated_at,
    (SELECT COUNT(*) FROM listing_skus ls WHERE ls.listing_id = l.id) AS sku_count,
    (SELECT COUNT(*) FROM asset_set_items asi JOIN asset_sets aset ON aset.id = asi.set_id WHERE aset.listing_id = l.id AND aset.kind = 'carousel') AS carousel_count,
    (SELECT COUNT(*) FROM asset_set_items asi JOIN asset_sets aset ON aset.id = asi.set_id WHERE aset.listing_id = l.id AND aset.kind = 'detail') AS detail_count,
    (SELECT COUNT(*) FROM asset_set_items asi JOIN asset_sets aset ON aset.id = asi.set_id WHERE aset.listing_id = l.id AND aset.kind = 'sku') AS sku_image_count,
    (SELECT COUNT(*) FROM asset_set_items asi JOIN asset_sets aset ON aset.id = asi.set_id WHERE aset.listing_id = l.id AND aset.kind = 'video') AS video_count,
    (SELECT COUNT(*) FROM pdp_versions pv WHERE pv.listing_id = l.id) AS pdp_version_count,
    d.content_json AS pdp_content_json
  FROM listings l
  JOIN products p ON p.id = l.product_id
  JOIN stores s ON s.id = l.store_id
  LEFT JOIN listing_pdp_drafts d ON d.listing_id = l.id
`;

export interface ListingListQuery {
  q?: string;
  productId?: string;
  storeId?: string;
  platform?: string;
  market?: string;
  status?: ListingStatus;
  page: number;
  pageSize: number;
}

export function listListings(
  db: AppDatabase,
  query: ListingListQuery
): PaginatedResponse<ListingSummary> {
  const clauses: string[] = ["l.deleted_at IS NULL"];
  const params: Array<string | number> = [];

  if (query.productId) {
    clauses.push("l.product_id = ?");
    params.push(query.productId);
  }
  if (query.storeId) {
    clauses.push("l.store_id = ?");
    params.push(query.storeId);
  }
  if (query.platform) {
    clauses.push("s.platform = ?");
    params.push(query.platform);
  }
  if (query.market) {
    clauses.push("s.market = ?");
    params.push(query.market);
  }
  if (query.status) {
    clauses.push("l.status = ?");
    params.push(query.status);
  }
  if (query.q && query.q.trim()) {
    const searchPredicate = buildEntitySearchClause(db, "listing", "l.id", query.q);
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
    .prepare(
      `SELECT COUNT(*) AS count
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN stores s ON s.id = l.store_id
       WHERE ${whereSql}`
    )
    .get(...params) as { count: number };

  const offset = (query.page - 1) * query.pageSize;
  const rows = db.raw
    .prepare(
      `${LISTING_SUMMARY_SELECT}
       WHERE ${whereSql}
       ORDER BY l.updated_at DESC, l.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, query.pageSize, offset) as unknown as ListingSummaryRow[];

  return {
    items: rows.map(mapListingSummary),
    total: Number(countRow.count ?? 0),
    page: query.page,
    pageSize: query.pageSize
  };
}

export function getListingDetail(db: AppDatabase, listingId: string): ListingDetail {
  const row = db.raw
    .prepare(`${LISTING_SUMMARY_SELECT} WHERE l.id = ? AND l.deleted_at IS NULL`)
    .get(listingId) as unknown as ListingSummaryRow | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "上架链接不存在或已移入回收站");
  }

  const skuRows = db.raw
    .prepare(
      `SELECT
         ls.id, ls.listing_id, ls.sku_id,
         sk.code AS sku_code, sk.name AS sku_name, sk.attributes_json AS sku_attributes_json,
         sk.status AS sku_status,
         ls.channel_code, ls.display_name, ls.position
       FROM listing_skus ls
       JOIN skus sk ON sk.id = ls.sku_id
       WHERE ls.listing_id = ?
       ORDER BY ls.position ASC, sk.code ASC`
    )
    .all(listingId) as unknown as ListingSkuJoinedRow[];

  const skus: ListingSkuRecord[] = skuRows.map((skuRow) => ({
    id: skuRow.id,
    listingId: skuRow.listing_id,
    skuId: skuRow.sku_id,
    skuCode: skuRow.sku_code,
    skuName: skuRow.sku_name,
    skuAttributes: safeParseAttributes(skuRow.sku_attributes_json),
    skuStatus: skuRow.sku_status,
    channelCode: skuRow.channel_code,
    displayName: skuRow.display_name,
    position: skuRow.position
  }));

  return {
    ...mapListingSummary(row),
    skus
  };
}

export interface CreateListingInput {
  productId: string;
  storeId: string;
  displayName: string;
  language?: string;
  externalId?: string | null;
  externalUrl?: string | null;
  status?: ListingStatus;
  notes?: string;
  skuIds?: string[];
}

export function createListing(
  db: AppDatabase,
  actorUserId: string,
  input: CreateListingInput
): ListingDetail {
  const product = db.raw
    .prepare("SELECT id, spu FROM products WHERE id = ? AND deleted_at IS NULL")
    .get(input.productId) as { id: string; spu: string } | undefined;
  if (!product) {
    throw new AppError(404, "NOT_FOUND", "所属商品不存在或已移入回收站");
  }

  const store = db.raw
    .prepare("SELECT id, name, platform, market, default_language, status FROM stores WHERE id = ?")
    .get(input.storeId) as
    | {
        id: string;
        name: string;
        platform: string;
        market: string;
        default_language: string;
        status: string;
      }
    | undefined;
  if (!store) {
    throw new AppError(404, "NOT_FOUND", "目标店铺不存在");
  }

  const listingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const language = (input.language ?? store.default_language).trim() || store.default_language;
  const displayName = input.displayName.trim();

  const skuIds = Array.from(new Set(input.skuIds ?? []));
  if (skuIds.length > 0) {
    const placeholders = skuIds.map(() => "?").join(", ");
    const validSkus = db.raw
      .prepare(`SELECT id FROM skus WHERE product_id = ? AND id IN (${placeholders})`)
      .all(input.productId, ...skuIds) as Array<{ id: string }>;
    if (validSkus.length !== skuIds.length) {
      throw new AppError(400, "VALIDATION_ERROR", "所选 SKU 不属于当前商品");
    }
  }

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO listings (
           id, product_id, store_id, display_name, language,
           external_id, external_url, status, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        listingId,
        input.productId,
        input.storeId,
        displayName,
        language,
        input.externalId?.trim() || null,
        input.externalUrl?.trim() || null,
        input.status ?? "draft",
        (input.notes ?? "").trim(),
        now,
        now
      );

    ensureListingAssetSetsInTx(db, listingId, now);

    db.raw
      .prepare(
        `INSERT INTO listing_pdp_drafts
           (listing_id, language, content_json, revision, based_on_version_id, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)`
      )
      .run(listingId, language, JSON.stringify(createEmptyPdpContent()), now);

    if (skuIds.length > 0) {
      const insertListingSku = db.raw.prepare(
        `INSERT INTO listing_skus (id, listing_id, sku_id, channel_code, display_name, position)
         VALUES (?, ?, ?, '', '', ?)`
      );
      skuIds.forEach((skuId, index) => {
        insertListingSku.run(crypto.randomUUID(), listingId, skuId, index);
      });
    }

    rebuildListingSearchDocument(db, listingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.create",
      objectType: "listing",
      objectId: listingId,
      details: {
        productId: input.productId,
        spu: product.spu,
        storeId: input.storeId,
        platform: store.platform,
        market: store.market,
        language
      }
    });
  });

  return getListingDetail(db, listingId);
}

export interface UpdateListingInput {
  displayName?: string;
  language?: string;
  externalId?: string | null;
  externalUrl?: string | null;
  status?: ListingStatus;
  notes?: string;
}

export function updateListing(
  db: AppDatabase,
  actorUserId: string,
  listingId: string,
  input: UpdateListingInput
): ListingDetail {
  const existing = getListingDetail(db, listingId);
  const now = new Date().toISOString();

  const nextDisplayName =
    input.displayName !== undefined ? input.displayName.trim() : existing.displayName;
  const nextLanguage = input.language !== undefined ? input.language.trim() : existing.language;
  const nextExternalId =
    input.externalId !== undefined ? input.externalId?.trim() || null : existing.externalId;
  const nextExternalUrl =
    input.externalUrl !== undefined ? input.externalUrl?.trim() || null : existing.externalUrl;
  const nextStatus = input.status ?? existing.status;
  const nextNotes = input.notes !== undefined ? input.notes.trim() : existing.notes;

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE listings
         SET display_name = ?, language = ?, external_id = ?, external_url = ?,
             status = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextDisplayName,
        nextLanguage,
        nextExternalId,
        nextExternalUrl,
        nextStatus,
        nextNotes,
        now,
        listingId
      );

    rebuildListingSearchDocument(db, listingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.update",
      objectType: "listing",
      objectId: listingId,
      details: { updatedFields: Object.keys(input), status: nextStatus }
    });
  });

  return getListingDetail(db, listingId);
}

export function softDeleteListing(
  db: AppDatabase,
  actorUserId: string,
  listingId: string
): { id: string; deletedAt: string } {
  const existing = getListingDetail(db, listingId);
  const deletedAt = new Date().toISOString();

  db.transaction(() => {
    db.raw
      .prepare("UPDATE listings SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt, deletedAt, listingId);
    rebuildListingSearchDocument(db, listingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.soft_delete",
      objectType: "listing",
      objectId: listingId,
      details: {
        productId: existing.productId,
        storeId: existing.storeId,
        displayName: existing.displayName
      }
    });
  });

  return { id: listingId, deletedAt };
}

export interface DuplicateListingInput {
  storeId?: string;
  displayName?: string;
  language?: string;
}

export function duplicateListing(
  db: AppDatabase,
  actorUserId: string,
  sourceListingId: string,
  input: DuplicateListingInput = {}
): ListingDetail {
  const source = getListingDetail(db, sourceListingId);
  const targetStoreId = input.storeId || source.storeId;
  const targetStore = db.raw
    .prepare("SELECT id, default_language FROM stores WHERE id = ?")
    .get(targetStoreId) as { id: string; default_language: string } | undefined;
  if (!targetStore) {
    throw new AppError(404, "NOT_FOUND", "目标店铺不存在");
  }

  const newListingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const displayName = (input.displayName ?? `${source.displayName} (副本)`).trim();
  const language = (input.language ?? source.language).trim() || targetStore.default_language;

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO listings (
           id, product_id, store_id, display_name, language,
           external_id, external_url, status, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'draft', ?, ?, ?)`
      )
      .run(
        newListingId,
        source.productId,
        targetStoreId,
        displayName,
        language,
        source.notes,
        now,
        now
      );

    // Copy listing SKUs and map old listing_sku_id -> new listing_sku_id
    const skuIdMap = new Map<string, string>();
    const sourceSkus = db.raw
      .prepare(
        "SELECT id, sku_id, channel_code, display_name, position FROM listing_skus WHERE listing_id = ? ORDER BY position ASC"
      )
      .all(sourceListingId) as Array<{
      id: string;
      sku_id: string;
      channel_code: string;
      display_name: string;
      position: number;
    }>;
    const insertSku = db.raw.prepare(
      `INSERT INTO listing_skus (id, listing_id, sku_id, channel_code, display_name, position)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const sku of sourceSkus) {
      const newListingSkuId = crypto.randomUUID();
      skuIdMap.set(sku.id, newListingSkuId);
      insertSku.run(
        newListingSkuId,
        newListingId,
        sku.sku_id,
        sku.channel_code,
        sku.display_name,
        sku.position
      );
    }

    // Create new independent asset_sets and copy asset_set_items referencing exact same asset_version_id
    const newSets = ensureListingAssetSetsInTx(db, newListingId, now);
    const sourceSets = db.raw
      .prepare("SELECT id, kind FROM asset_sets WHERE listing_id = ?")
      .all(sourceListingId) as Array<{ id: string; kind: (typeof ASSET_SET_KINDS)[number] }>;

    const selectItems = db.raw.prepare(
      "SELECT asset_version_id, listing_sku_id, position FROM asset_set_items WHERE set_id = ? ORDER BY position ASC"
    );
    const insertItem = db.raw.prepare(
      `INSERT INTO asset_set_items (id, set_id, asset_version_id, listing_sku_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const sourceSet of sourceSets) {
      const targetSetId = newSets[sourceSet.kind];
      const items = selectItems.all(sourceSet.id) as Array<{
        asset_version_id: string;
        listing_sku_id: string | null;
        position: number;
      }>;
      for (const item of items) {
        const mappedSkuId = item.listing_sku_id ? skuIdMap.get(item.listing_sku_id) ?? null : null;
        if (sourceSet.kind === "sku" && !mappedSkuId) {
          continue;
        }
        insertItem.run(
          crypto.randomUUID(),
          targetSetId,
          item.asset_version_id,
          mappedSkuId,
          item.position,
          now
        );
      }
    }

    // Copy PDP draft as an independent draft (never sharing mutable row)
    const sourceDraft = db.raw
      .prepare("SELECT content_json FROM listing_pdp_drafts WHERE listing_id = ?")
      .get(sourceListingId) as { content_json: string } | undefined;
    const copiedContentJson = sourceDraft?.content_json ?? JSON.stringify(createEmptyPdpContent());

    db.raw
      .prepare(
        `INSERT INTO listing_pdp_drafts
           (listing_id, language, content_json, revision, based_on_version_id, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)`
      )
      .run(newListingId, language, copiedContentJson, now);

    rebuildListingSearchDocument(db, newListingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.duplicate",
      objectType: "listing",
      objectId: newListingId,
      details: { sourceListingId, targetStoreId, language }
    });
  });

  return getListingDetail(db, newListingId);
}

export interface SyncListingSkuItem {
  skuId: string;
  channelCode?: string;
  displayName?: string;
}

export function syncListingSkus(
  db: AppDatabase,
  actorUserId: string,
  listingId: string,
  items: SyncListingSkuItem[]
): ListingDetail {
  const listing = getListingDetail(db, listingId);

  // Ensure no duplicate skuId in payload
  const seenSkuIds = new Set<string>();
  for (const item of items) {
    if (seenSkuIds.has(item.skuId)) {
      throw new AppError(400, "VALIDATION_ERROR", "同一 Listing 中不能重复绑定相同 SKU");
    }
    seenSkuIds.add(item.skuId);
  }

  if (items.length > 0) {
    const skuIds = items.map((item) => item.skuId);
    const placeholders = skuIds.map(() => "?").join(", ");
    const validSkus = db.raw
      .prepare(`SELECT id FROM skus WHERE product_id = ? AND id IN (${placeholders})`)
      .all(listing.productId, ...skuIds) as Array<{ id: string }>;
    if (validSkus.length !== skuIds.length) {
      throw new AppError(400, "VALIDATION_ERROR", "所选 SKU 必须全部属于当前上架链接对应的商品");
    }
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    const existingRows = db.raw
      .prepare("SELECT id, sku_id FROM listing_skus WHERE listing_id = ?")
      .all(listingId) as Array<{ id: string; sku_id: string }>;
    const existingBySkuId = new Map(existingRows.map((row) => [row.sku_id, row.id]));

    // Delete removed SKUs (preserving IDs of retained SKUs so their SKU image bindings stay intact)
    const deleteStmt = db.raw.prepare("DELETE FROM listing_skus WHERE id = ?");
    for (const row of existingRows) {
      if (!seenSkuIds.has(row.sku_id)) {
        deleteStmt.run(row.id);
      }
    }

    const updateStmt = db.raw.prepare(
      "UPDATE listing_skus SET channel_code = ?, display_name = ?, position = ? WHERE id = ?"
    );
    const insertStmt = db.raw.prepare(
      `INSERT INTO listing_skus (id, listing_id, sku_id, channel_code, display_name, position)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    items.forEach((item, index) => {
      const existingId = existingBySkuId.get(item.skuId);
      const channelCode = (item.channelCode ?? "").trim();
      const displayName = (item.displayName ?? "").trim();
      if (existingId) {
        updateStmt.run(channelCode, displayName, index, existingId);
      } else {
        insertStmt.run(
          crypto.randomUUID(),
          listingId,
          item.skuId,
          channelCode,
          displayName,
          index
        );
      }
    });

    db.raw.prepare("UPDATE listings SET updated_at = ? WHERE id = ?").run(now, listingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.skus.sync",
      objectType: "listing",
      objectId: listingId,
      details: { skuCount: items.length }
    });
  });

  return getListingDetail(db, listingId);
}
