import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  AssetDetail,
  AssetLinkedProduct,
  AssetListItem,
  AssetType,
  AssetVersionRecord,
  PaginatedResponse,
  ReviewStatus,
  StorageProviderStatus,
  TagDimension,
  ThumbStatus
} from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { buildOriginalObjectKey } from "../../storage/types.js";
import {
  detectFileType,
  isRasterImageMime,
  sanitizeFilename
} from "../media/detect.js";
import {
  buildThumbnailRelPath,
  generateThumbnailFromFile,
  generateThumbnailFromStream,
  inspectImageDimensions,
  isValidThumbnailFile,
  resolveThumbnailAbsPath
} from "../media/thumbnail.js";
import { rebuildAssetSearchDocument, searchEntityIds } from "../search/service.js";
import { recordActivity } from "../system/activity.js";

export interface StagedUploadFile {
  tempPath: string;
  originalFilename: string;
  declaredMime: string;
  sha256: string;
  sizeBytes: number;
  header: Buffer;
}

export interface UploadAssetOptions {
  productIds: string[];
  folderId: string | null;
  storageId: string | null;
  purpose: string;
  tagIds: string[];
  source: string;
  sourceUrl: string | null;
  notes: string;
  promptText: string;
}

export interface AssetListQuery {
  q?: string;
  productId?: string;
  storeId?: string;
  market?: string;
  platform?: string;
  purpose?: string;
  scene?: string;
  color?: string;
  tagId?: string;
  type?: AssetType;
  reviewStatus?: ReviewStatus;
  folderId?: string;
  unfiled?: boolean;
  favorite?: boolean;
  storageId?: string;
  minWidth?: number;
  dateFrom?: string;
  dateTo?: string;
  sort: "newest" | "oldest" | "name_asc" | "size_desc";
  page: number;
  pageSize: number;
}

export interface UpdateAssetInput {
  name?: string;
  folderId?: string | null;
  purpose?: string;
  isFavorite?: boolean;
  source?: string;
  sourceUrl?: string | null;
  notes?: string;
  tagIds?: string[];
  productIds?: string[];
}

export interface BatchAssetsInput {
  assetIds: string[];
  action:
    | "move_folder"
    | "add_tags"
    | "remove_tags"
    | "link_products"
    | "unlink_products"
    | "set_review_status"
    | "soft_delete";
  folderId?: string | null;
  tagIds?: string[];
  productIds?: string[];
  reviewStatus?: ReviewStatus;
  reviewNote?: string;
}

export interface AppendAssetVersionOptions {
  storageId: string | null;
  changeNote: string;
  promptText: string;
  referenceAssetVersionId: string | null;
  setAsCurrent?: boolean;
}

interface AssetJoinedRow {
  id: string;
  name: string;
  original_filename: string;
  asset_type: AssetType;
  purpose: string;
  folder_id: string | null;
  folder_name: string | null;
  current_version_id: string;
  version_no: number;
  review_status: ReviewStatus;
  thumb_status: ThumbStatus;
  is_favorite: number;
  source: string;
  source_url: string | null;
  notes: string;
  storage_id: string;
  storage_status: StorageProviderStatus;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  ext: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface ResolvedAssetVersionFile {
  assetId: string;
  versionId: string;
  fileId: string;
  originalFilename: string;
  storageId: string;
  storageStatus: StorageProviderStatus;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  ext: string;
  thumbStatus: ThumbStatus;
  thumbKey: string | null;
}

export function getDefaultStorageId(db: AppDatabase, config: ResolvedAppConfig): string {
  const row = db.raw
    .prepare("SELECT value_json FROM settings WHERE key = 'default_storage_id'")
    .get() as { value_json: string } | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value_json);
      if (typeof parsed === "string" && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // fallback
    }
  }
  return config.storage.default;
}

function loadTagsForAssets(
  db: AppDatabase,
  assetIds: string[]
): Map<string, Array<{ id: string; dimension: TagDimension; name: string }>> {
  const result = new Map<string, Array<{ id: string; dimension: TagDimension; name: string }>>();
  if (assetIds.length === 0) {
    return result;
  }
  const placeholders = assetIds.map(() => "?").join(", ");
  const rows = db.raw
    .prepare(
      `SELECT at.asset_id, t.id, t.dimension, t.name
       FROM asset_tags at
       JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id IN (${placeholders})
       ORDER BY t.dimension ASC, t.name ASC`
    )
    .all(...assetIds) as Array<{
    asset_id: string;
    id: string;
    dimension: TagDimension;
    name: string;
  }>;

  for (const row of rows) {
    const list = result.get(row.asset_id) ?? [];
    list.push({ id: row.id, dimension: row.dimension, name: row.name });
    result.set(row.asset_id, list);
  }
  return result;
}

function loadProductsForAssets(
  db: AppDatabase,
  assetIds: string[]
): Map<string, AssetLinkedProduct[]> {
  const result = new Map<string, AssetLinkedProduct[]>();
  if (assetIds.length === 0) {
    return result;
  }
  const placeholders = assetIds.map(() => "?").join(", ");
  const rows = db.raw
    .prepare(
      `SELECT pa.asset_id, p.id, p.spu, p.name_zh, p.name_en
       FROM product_assets pa
       JOIN products p ON p.id = pa.product_id
       WHERE pa.asset_id IN (${placeholders}) AND p.deleted_at IS NULL
       ORDER BY p.spu ASC`
    )
    .all(...assetIds) as Array<{
    asset_id: string;
    id: string;
    spu: string;
    name_zh: string;
    name_en: string;
  }>;

  for (const row of rows) {
    const list = result.get(row.asset_id) ?? [];
    list.push({
      id: row.id,
      spu: row.spu,
      nameZh: row.name_zh,
      nameEn: row.name_en
    });
    result.set(row.asset_id, list);
  }
  return result;
}

function mapAssetRow(
  row: AssetJoinedRow,
  tagsMap: Map<string, Array<{ id: string; dimension: TagDimension; name: string }>>,
  productsMap: Map<string, AssetLinkedProduct[]>
): AssetListItem {
  return {
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    assetType: row.asset_type,
    purpose: row.purpose,
    folderId: row.folder_id,
    folderName: row.folder_name,
    currentVersionId: row.current_version_id,
    versionNo: row.version_no,
    reviewStatus: row.review_status,
    thumbStatus: row.thumb_status,
    isFavorite: row.is_favorite === 1,
    source: row.source,
    sourceUrl: row.source_url,
    notes: row.notes,
    storageId: row.storage_id,
    storageStatus: row.storage_status,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    ext: row.ext,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    tags: tagsMap.get(row.id) ?? [],
    products: productsMap.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function ingestStagedFile(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  actorUserId: string,
  staged: StagedUploadFile,
  options: UploadAssetOptions
): Promise<{ asset: AssetDetail; deduplicated: boolean }> {
  const safeFilename = sanitizeFilename(staged.originalFilename);
  const detected = detectFileType(staged.header, safeFilename, staged.declaredMime);
  const targetStorageId = options.storageId || getDefaultStorageId(db, config);

  const providerRow = db.raw
    .prepare("SELECT id, enabled, status FROM storage_providers WHERE id = ?")
    .get(targetStorageId) as { id: string; enabled: number; status: StorageProviderStatus } | undefined;

  if (!providerRow || providerRow.enabled !== 1 || providerRow.status === "missing_config") {
    throw new AppError(503, "STORAGE_OFFLINE", `目标存储空间 "${targetStorageId}" 当前不可用`);
  }

  const storageProvider = storageRegistry.require(targetStorageId);
  const objectKey = buildOriginalObjectKey(staged.sha256);

  // Validate optional folder/products/tags before writing physical file
  if (options.folderId) {
    const folder = db.raw.prepare("SELECT id FROM folders WHERE id = ?").get(options.folderId);
    if (!folder) {
      throw new AppError(404, "NOT_FOUND", "指定的逻辑目录不存在");
    }
  }
  for (const productId of options.productIds) {
    const product = db.raw
      .prepare("SELECT id FROM products WHERE id = ? AND deleted_at IS NULL")
      .get(productId);
    if (!product) {
      throw new AppError(404, "NOT_FOUND", `关联商品 "${productId}" 不存在或已删除`);
    }
  }
  for (const tagId of options.tagIds) {
    const tag = db.raw.prepare("SELECT id FROM tags WHERE id = ?").get(tagId);
    if (!tag) {
      throw new AppError(404, "NOT_FOUND", `标签 "${tagId}" 不存在`);
    }
  }

  const dimensions = await inspectImageDimensions(staged.tempPath, detected.mimeType);

  // Content-addressed deduplication check
  const existingFile = db.raw
    .prepare(
      `SELECT id, object_key, state, width, height
       FROM files
       WHERE storage_id = ? AND sha256 = ?`
    )
    .get(targetStorageId, staged.sha256) as
    | { id: string; object_key: string; state: string; width: number | null; height: number | null }
    | undefined;

  let deduplicated = false;
  let fileId: string;

  if (existingFile && existingFile.state === "ready" && (await storageProvider.exists(existingFile.object_key))) {
    deduplicated = true;
    fileId = existingFile.id;
  } else {
    // Stream to storage outside SQLite transaction
    await storageProvider.put(objectKey, fs.createReadStream(staged.tempPath), {
      contentType: detected.mimeType,
      contentLength: staged.sizeBytes,
      sha256: staged.sha256
    });
    fileId = existingFile?.id ?? crypto.randomUUID();
  }

  // Generate thumbnail outside SQLite transaction
  const expectedThumbKey = buildThumbnailRelPath(staged.sha256);
  const expectedThumbAbs = resolveThumbnailAbsPath(config.cache.path, expectedThumbKey);
  let thumbResult: { thumbStatus: ThumbStatus; thumbKey: string | null };
  if (detected.isRasterPreviewable && (await isValidThumbnailFile(expectedThumbAbs))) {
    thumbResult = { thumbStatus: "ready", thumbKey: expectedThumbKey };
  } else {
    thumbResult = await generateThumbnailFromFile(
      staged.tempPath,
      detected.mimeType,
      staged.sha256,
      config.cache.path,
      config.cache.maxSizeMB
    );
  }

  const assetId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const baseDisplayName = path.parse(safeFilename).name || safeFilename;

  db.transaction(() => {
    if (!deduplicated) {
      db.raw
        .prepare(
          `INSERT INTO files (
             id, storage_id, object_key, sha256, size_bytes, mime_type, ext,
             width, height, duration_ms, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ready', ?, ?)
           ON CONFLICT(storage_id, sha256) DO UPDATE SET
             state = 'ready',
             width = COALESCE(files.width, excluded.width),
             height = COALESCE(files.height, excluded.height),
             updated_at = excluded.updated_at`
        )
        .run(
          fileId,
          targetStorageId,
          objectKey,
          staged.sha256,
          staged.sizeBytes,
          detected.mimeType,
          detected.ext,
          dimensions.width,
          dimensions.height,
          now,
          now
        );
      const resolved = db.raw
        .prepare("SELECT id FROM files WHERE storage_id = ? AND sha256 = ?")
        .get(targetStorageId, staged.sha256) as { id: string };
      fileId = resolved.id;
    } else if ((dimensions.width && !existingFile?.width) || (dimensions.height && !existingFile?.height)) {
      db.raw
        .prepare("UPDATE files SET width = COALESCE(width, ?), height = COALESCE(height, ?), updated_at = ? WHERE id = ?")
        .run(dimensions.width, dimensions.height, now, fileId);
    }

    db.raw
      .prepare(
        `INSERT INTO assets (
           id, name, original_filename, asset_type, purpose, folder_id,
           current_version_id, is_favorite, source, source_url, notes,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        assetId,
        baseDisplayName,
        safeFilename,
        detected.assetType,
        options.purpose || "other",
        options.folderId,
        options.source || "",
        options.sourceUrl,
        options.notes || "",
        now,
        now
      );

    db.raw
      .prepare(
        `INSERT INTO asset_versions (
           id, asset_id, file_id, version_no, original_filename,
           change_note, prompt_text, review_status, review_note,
           thumb_status, thumb_key, metadata_json, created_at
         ) VALUES (?, ?, ?, 1, ?, '', ?, 'pending', '', ?, ?, '{}', ?)`
      )
      .run(
        versionId,
        assetId,
        fileId,
        safeFilename,
        options.promptText || "",
        thumbResult.thumbStatus,
        thumbResult.thumbKey,
        now
      );

    db.raw
      .prepare("UPDATE assets SET current_version_id = ? WHERE id = ?")
      .run(versionId, assetId);

    if (options.productIds.length > 0) {
      const insertLink = db.raw.prepare(
        "INSERT OR IGNORE INTO product_assets (product_id, asset_id, created_at) VALUES (?, ?, ?)"
      );
      const setCoverIfEmpty = db.raw.prepare(
        "UPDATE products SET cover_version_id = ?, updated_at = ? WHERE id = ? AND cover_version_id IS NULL"
      );
      for (const productId of options.productIds) {
        insertLink.run(productId, assetId, now);
        if (detected.isRasterPreviewable) {
          setCoverIfEmpty.run(versionId, now, productId);
        }
      }
    }

    if (options.tagIds.length > 0) {
      const insertTag = db.raw.prepare(
        "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)"
      );
      for (const tagId of options.tagIds) {
        insertTag.run(assetId, tagId, now);
      }
    }

    rebuildAssetSearchDocument(db, assetId);
    recordActivity(db, {
      actorUserId,
      action: "asset.upload",
      objectType: "asset",
      objectId: assetId,
      details: {
        filename: safeFilename,
        storageId: targetStorageId,
        sizeBytes: staged.sizeBytes,
        deduplicated
      }
    });
  });

  return {
    asset: getAssetDetail(db, assetId),
    deduplicated
  };
}

function addDimensionTagFilter(
  clauses: string[],
  params: Array<string | number>,
  dimension: TagDimension,
  value: string
): void {
  clauses.push(
    `EXISTS (
       SELECT 1 FROM asset_tags at_f
       JOIN tags t_f ON t_f.id = at_f.tag_id
       WHERE at_f.asset_id = a.id
         AND t_f.dimension = ?
         AND (t_f.id = ? OR lower(t_f.name) = lower(?))
     )`
  );
  params.push(dimension, value, value);
}

export function listAssets(
  db: AppDatabase,
  query: AssetListQuery
): PaginatedResponse<AssetListItem> {
  const clauses: string[] = ["a.deleted_at IS NULL"];
  const params: Array<string | number> = [];

  if (query.q && query.q.trim().length > 0) {
    const matchedIds = searchEntityIds(db, "asset", query.q);
    if (matchedIds.length === 0) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    const placeholders = matchedIds.map(() => "?").join(", ");
    clauses.push(`a.id IN (${placeholders})`);
    params.push(...matchedIds);
  }

  if (query.productId) {
    clauses.push(
      "EXISTS (SELECT 1 FROM product_assets pa WHERE pa.asset_id = a.id AND pa.product_id = ?)"
    );
    params.push(query.productId);
  }

  if (query.storeId) {
    clauses.push(
      `(EXISTS (
         SELECT 1
         FROM asset_versions av_s
         JOIN asset_set_items asi ON asi.asset_version_id = av_s.id
         JOIN asset_sets aset ON aset.id = asi.set_id
         JOIN listings lst ON lst.id = aset.listing_id
         WHERE av_s.asset_id = a.id AND lst.store_id = ? AND lst.deleted_at IS NULL
       ) OR EXISTS (
         SELECT 1
         FROM product_assets pa_s
         JOIN listings lst_p ON lst_p.product_id = pa_s.product_id
         WHERE pa_s.asset_id = a.id AND lst_p.store_id = ? AND lst_p.deleted_at IS NULL
       ))`
    );
    params.push(query.storeId, query.storeId);
  }

  if (query.market) {
    addDimensionTagFilter(clauses, params, "market", query.market);
  }
  if (query.platform) {
    addDimensionTagFilter(clauses, params, "platform", query.platform);
  }
  if (query.scene) {
    addDimensionTagFilter(clauses, params, "scene", query.scene);
  }
  if (query.color) {
    addDimensionTagFilter(clauses, params, "color", query.color);
  }
  if (query.purpose) {
    clauses.push(
      `(lower(a.purpose) = lower(?) OR EXISTS (
         SELECT 1 FROM asset_tags at_p
         JOIN tags t_p ON t_p.id = at_p.tag_id
         WHERE at_p.asset_id = a.id
           AND t_p.dimension = 'purpose'
           AND (t_p.id = ? OR lower(t_p.name) = lower(?))
       ))`
    );
    params.push(query.purpose, query.purpose, query.purpose);
  }

  if (query.tagId) {
    const tagIds = query.tagId
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const tid of tagIds) {
      clauses.push(
        "EXISTS (SELECT 1 FROM asset_tags at_x WHERE at_x.asset_id = a.id AND at_x.tag_id = ?)"
      );
      params.push(tid);
    }
  }

  if (query.type) {
    clauses.push("a.asset_type = ?");
    params.push(query.type);
  }
  if (query.reviewStatus) {
    clauses.push("av.review_status = ?");
    params.push(query.reviewStatus);
  }
  if (query.unfiled) {
    clauses.push("a.folder_id IS NULL");
  } else if (query.folderId) {
    clauses.push("a.folder_id = ?");
    params.push(query.folderId);
  }
  if (query.favorite) {
    clauses.push("a.is_favorite = 1");
  }
  if (query.storageId) {
    clauses.push("f.storage_id = ?");
    params.push(query.storageId);
  }
  if (query.minWidth !== undefined) {
    clauses.push("f.width IS NOT NULL AND f.width >= ?");
    params.push(query.minWidth);
  }
  if (query.dateFrom) {
    clauses.push("a.created_at >= ?");
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    clauses.push("a.created_at <= ?");
    params.push(query.dateTo);
  }

  const whereSql = clauses.join(" AND ");
  const orderSql =
    query.sort === "oldest"
      ? "a.created_at ASC"
      : query.sort === "name_asc"
        ? "a.name COLLATE NOCASE ASC"
        : query.sort === "size_desc"
          ? "f.size_bytes DESC, a.created_at DESC"
          : "a.created_at DESC";

  const baseFrom = `
    FROM assets a
    JOIN asset_versions av ON av.id = a.current_version_id
    JOIN files f ON f.id = av.file_id
    JOIN storage_providers sp ON sp.id = f.storage_id
    LEFT JOIN folders fld ON fld.id = a.folder_id
    WHERE ${whereSql}
  `;

  const countRow = db.raw
    .prepare(`SELECT COUNT(*) AS count ${baseFrom}`)
    .get(...params) as { count: number };

  const offset = (query.page - 1) * query.pageSize;
  const rows = db.raw
    .prepare(
      `SELECT
         a.id, a.name, a.original_filename, a.asset_type, a.purpose,
         a.folder_id, fld.name AS folder_name, a.current_version_id,
         av.version_no, av.review_status, av.thumb_status,
         a.is_favorite, a.source, a.source_url, a.notes,
         f.storage_id, sp.status AS storage_status, f.sha256, f.size_bytes,
         f.mime_type, f.ext, f.width, f.height, f.duration_ms,
         a.created_at, a.updated_at
       ${baseFrom}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`
    )
    .all(...params, query.pageSize, offset) as unknown as AssetJoinedRow[];

  const assetIds = rows.map((row) => row.id);
  const tagsMap = loadTagsForAssets(db, assetIds);
  const productsMap = loadProductsForAssets(db, assetIds);

  return {
    items: rows.map((row) => mapAssetRow(row, tagsMap, productsMap)),
    total: Number(countRow.count ?? 0),
    page: query.page,
    pageSize: query.pageSize
  };
}

export function getAssetDetail(db: AppDatabase, assetId: string): AssetDetail {
  const row = db.raw
    .prepare(
      `SELECT
         a.id, a.name, a.original_filename, a.asset_type, a.purpose,
         a.folder_id, fld.name AS folder_name, a.current_version_id,
         av.version_no, av.review_status, av.thumb_status,
         a.is_favorite, a.source, a.source_url, a.notes,
         f.storage_id, sp.status AS storage_status, f.sha256, f.size_bytes,
         f.mime_type, f.ext, f.width, f.height, f.duration_ms,
         a.created_at, a.updated_at
       FROM assets a
       JOIN asset_versions av ON av.id = a.current_version_id
       JOIN files f ON f.id = av.file_id
       JOIN storage_providers sp ON sp.id = f.storage_id
       LEFT JOIN folders fld ON fld.id = a.folder_id
       WHERE a.id = ? AND a.deleted_at IS NULL`
    )
    .get(assetId) as unknown as AssetJoinedRow | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "素材不存在或已移入回收站");
  }

  const versionRows = db.raw
    .prepare(
      `SELECT
         av.id, av.asset_id, av.file_id, av.version_no, av.original_filename,
         av.change_note, av.prompt_text, av.reference_asset_version_id, av.review_status, av.review_note,
         av.reviewed_at, av.thumb_status, av.created_at,
         f.storage_id, sp.status AS storage_status, f.sha256, f.size_bytes,
         f.mime_type, f.ext, f.width, f.height, f.duration_ms
       FROM asset_versions av
       JOIN files f ON f.id = av.file_id
       JOIN storage_providers sp ON sp.id = f.storage_id
       WHERE av.asset_id = ?
       ORDER BY av.version_no DESC`
    )
    .all(assetId) as Array<{
    id: string;
    asset_id: string;
    file_id: string;
    version_no: number;
    original_filename: string;
    change_note: string;
    prompt_text: string;
    reference_asset_version_id: string | null;
    review_status: ReviewStatus;
    review_note: string;
    reviewed_at: string | null;
    thumb_status: ThumbStatus;
    created_at: string;
    storage_id: string;
    storage_status: StorageProviderStatus;
    sha256: string;
    size_bytes: number;
    mime_type: string;
    ext: string;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
  }>;

  const masterLocksByVersion = new Map<
    string,
    Array<{
      masterImageId: string;
      productId: string;
      spu: string;
      angle: string;
      isPrimary: boolean;
    }>
  >();

  if (versionRows.length > 0) {
    const hasMasterTable = Boolean(
      db.raw
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'product_master_images'"
        )
        .get()
    );
    if (hasMasterTable) {
      const versionIds = versionRows.map((ver) => ver.id);
      const placeholders = versionIds.map(() => "?").join(", ");
      const lockRows = db.raw
        .prepare(
          `SELECT pmi.id AS master_image_id, pmi.asset_version_id, pmi.product_id,
                  p.spu, pmi.angle, pmi.is_primary
           FROM product_master_images pmi
           JOIN products p ON p.id = pmi.product_id
           WHERE pmi.asset_version_id IN (${placeholders}) AND pmi.unlocked_at IS NULL
           ORDER BY pmi.is_primary DESC, pmi.locked_at ASC`
        )
        .all(...versionIds) as Array<{
        master_image_id: string;
        asset_version_id: string;
        product_id: string;
        spu: string;
        angle: string;
        is_primary: number;
      }>;
      for (const lockRow of lockRows) {
        const list = masterLocksByVersion.get(lockRow.asset_version_id) ?? [];
        list.push({
          masterImageId: lockRow.master_image_id,
          productId: lockRow.product_id,
          spu: lockRow.spu,
          angle: lockRow.angle,
          isPrimary: lockRow.is_primary === 1
        });
        masterLocksByVersion.set(lockRow.asset_version_id, list);
      }
    }
  }

  const versions: AssetVersionRecord[] = versionRows.map((ver) => ({
    id: ver.id,
    assetId: ver.asset_id,
    fileId: ver.file_id,
    versionNo: ver.version_no,
    originalFilename: ver.original_filename,
    changeNote: ver.change_note,
    promptText: ver.prompt_text,
    referenceAssetVersionId: ver.reference_asset_version_id,
    reviewStatus: ver.review_status,
    reviewNote: ver.review_note,
    reviewedAt: ver.reviewed_at,
    thumbStatus: ver.thumb_status,
    storageId: ver.storage_id,
    storageStatus: ver.storage_status,
    sha256: ver.sha256,
    sizeBytes: Number(ver.size_bytes),
    mimeType: ver.mime_type,
    ext: ver.ext,
    width: ver.width,
    height: ver.height,
    durationMs: ver.duration_ms,
    lockedMasterProducts: masterLocksByVersion.get(ver.id) ?? [],
    createdAt: ver.created_at
  }));

  const tagsMap = loadTagsForAssets(db, [assetId]);
  const productsMap = loadProductsForAssets(db, [assetId]);

  return {
    ...mapAssetRow(row, tagsMap, productsMap),
    versions
  };
}

export function updateAsset(
  db: AppDatabase,
  actorUserId: string,
  assetId: string,
  input: UpdateAssetInput
): AssetDetail {
  const existing = db.raw
    .prepare("SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL")
    .get(assetId);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "素材不存在或已在回收站中");
  }

  if (input.folderId) {
    const folder = db.raw.prepare("SELECT id FROM folders WHERE id = ?").get(input.folderId);
    if (!folder) {
      throw new AppError(404, "NOT_FOUND", "指定的逻辑目录不存在");
    }
  }
  if (input.tagIds) {
    for (const tagId of input.tagIds) {
      const tag = db.raw.prepare("SELECT id FROM tags WHERE id = ?").get(tagId);
      if (!tag) {
        throw new AppError(404, "NOT_FOUND", `标签 "${tagId}" 不存在`);
      }
    }
  }
  if (input.productIds) {
    for (const productId of input.productIds) {
      const product = db.raw
        .prepare("SELECT id FROM products WHERE id = ? AND deleted_at IS NULL")
        .get(productId);
      if (!product) {
        throw new AppError(404, "NOT_FOUND", `关联商品 "${productId}" 不存在`);
      }
    }
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number | null> = [now];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name.trim());
    }
    if (input.folderId !== undefined) {
      sets.push("folder_id = ?");
      params.push(input.folderId);
    }
    if (input.purpose !== undefined) {
      sets.push("purpose = ?");
      params.push(input.purpose.trim() || "other");
    }
    if (input.isFavorite !== undefined) {
      sets.push("is_favorite = ?");
      params.push(input.isFavorite ? 1 : 0);
    }
    if (input.source !== undefined) {
      sets.push("source = ?");
      params.push(input.source.trim());
    }
    if (input.sourceUrl !== undefined) {
      sets.push("source_url = ?");
      params.push(input.sourceUrl);
    }
    if (input.notes !== undefined) {
      sets.push("notes = ?");
      params.push(input.notes);
    }

    db.raw.prepare(`UPDATE assets SET ${sets.join(", ")} WHERE id = ?`).run(...params, assetId);

    if (input.tagIds !== undefined) {
      db.raw.prepare("DELETE FROM asset_tags WHERE asset_id = ?").run(assetId);
      const insertTag = db.raw.prepare(
        "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)"
      );
      for (const tagId of input.tagIds) {
        insertTag.run(assetId, tagId, now);
      }
    }

    if (input.productIds !== undefined) {
      db.raw.prepare("DELETE FROM product_assets WHERE asset_id = ?").run(assetId);
      const insertProd = db.raw.prepare(
        "INSERT OR IGNORE INTO product_assets (product_id, asset_id, created_at) VALUES (?, ?, ?)"
      );
      for (const productId of input.productIds) {
        insertProd.run(productId, assetId, now);
      }
    }

    rebuildAssetSearchDocument(db, assetId);
    recordActivity(db, {
      actorUserId,
      action: "asset.update",
      objectType: "asset",
      objectId: assetId,
      details: { updatedFields: Object.keys(input) }
    });
  });

  return getAssetDetail(db, assetId);
}

export function batchOperateAssets(
  db: AppDatabase,
  actorUserId: string,
  input: BatchAssetsInput
): { affectedCount: number } {
  const uniqueIds = Array.from(new Set(input.assetIds));
  if (uniqueIds.length === 0) {
    return { affectedCount: 0 };
  }

  const now = new Date().toISOString();
  let affectedCount = 0;

  db.transaction(() => {
    if (input.action === "move_folder") {
      if (input.folderId) {
        const exists = db.raw.prepare("SELECT id FROM folders WHERE id = ?").get(input.folderId);
        if (!exists) {
          throw new AppError(404, "NOT_FOUND", "目标目录不存在");
        }
      }
      const stmt = db.raw.prepare(
        "UPDATE assets SET folder_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      );
      for (const assetId of uniqueIds) {
        const res = stmt.run(input.folderId ?? null, now, assetId);
        if (res.changes > 0) {
          affectedCount += 1;
          rebuildAssetSearchDocument(db, assetId);
        }
      }
    } else if (input.action === "add_tags") {
      const tagIds = input.tagIds ?? [];
      const stmt = db.raw.prepare(
        "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)"
      );
      for (const assetId of uniqueIds) {
        for (const tagId of tagIds) {
          stmt.run(assetId, tagId, now);
        }
        affectedCount += 1;
        rebuildAssetSearchDocument(db, assetId);
      }
    } else if (input.action === "remove_tags") {
      const tagIds = input.tagIds ?? [];
      const stmt = db.raw.prepare("DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?");
      for (const assetId of uniqueIds) {
        for (const tagId of tagIds) {
          stmt.run(assetId, tagId);
        }
        affectedCount += 1;
        rebuildAssetSearchDocument(db, assetId);
      }
    } else if (input.action === "link_products") {
      const productIds = input.productIds ?? [];
      const stmt = db.raw.prepare(
        "INSERT OR IGNORE INTO product_assets (product_id, asset_id, created_at) VALUES (?, ?, ?)"
      );
      for (const assetId of uniqueIds) {
        for (const productId of productIds) {
          stmt.run(productId, assetId, now);
        }
        affectedCount += 1;
        rebuildAssetSearchDocument(db, assetId);
      }
    } else if (input.action === "unlink_products") {
      const productIds = input.productIds ?? [];
      const stmt = db.raw.prepare("DELETE FROM product_assets WHERE product_id = ? AND asset_id = ?");
      for (const assetId of uniqueIds) {
        for (const productId of productIds) {
          stmt.run(productId, assetId);
        }
        affectedCount += 1;
        rebuildAssetSearchDocument(db, assetId);
      }
    } else if (input.action === "set_review_status") {
      if (!input.reviewStatus) {
        throw new AppError(400, "VALIDATION_ERROR", "批量审核必须指定审核状态");
      }
      const reviewedAt = input.reviewStatus === "pending" ? null : now;
      const stmt = db.raw.prepare(
        `UPDATE asset_versions
         SET review_status = ?, review_note = ?, reviewed_at = ?
         WHERE id = (SELECT current_version_id FROM assets WHERE id = ? AND deleted_at IS NULL)`
      );
      for (const assetId of uniqueIds) {
        const res = stmt.run(input.reviewStatus, input.reviewNote ?? "", reviewedAt, assetId);
        if (res.changes > 0) {
          affectedCount += 1;
          rebuildAssetSearchDocument(db, assetId);
        }
      }
    } else if (input.action === "soft_delete") {
      const stmt = db.raw.prepare(
        "UPDATE assets SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      );
      for (const assetId of uniqueIds) {
        const res = stmt.run(now, now, assetId);
        if (res.changes > 0) {
          affectedCount += 1;
          rebuildAssetSearchDocument(db, assetId);
        }
      }
    }

    recordActivity(db, {
      actorUserId,
      action: `asset.batch.${input.action}`,
      objectType: "asset",
      objectId: null,
      details: { count: affectedCount, action: input.action }
    });
  });

  return { affectedCount };
}

export function resolveAssetVersionFile(
  db: AppDatabase,
  assetId: string,
  versionId: string
): ResolvedAssetVersionFile {
  const row = db.raw
    .prepare(
      `SELECT
         av.asset_id, av.id AS version_id, av.file_id, av.original_filename,
         av.thumb_status, av.thumb_key,
         f.storage_id, sp.status AS storage_status, f.object_key, f.sha256,
         f.size_bytes, f.mime_type, f.ext
       FROM asset_versions av
       JOIN files f ON f.id = av.file_id
       JOIN storage_providers sp ON sp.id = f.storage_id
       WHERE av.id = ? AND av.asset_id = ?`
    )
    .get(versionId, assetId) as
    | {
        asset_id: string;
        version_id: string;
        file_id: string;
        original_filename: string;
        thumb_status: ThumbStatus;
        thumb_key: string | null;
        storage_id: string;
        storage_status: StorageProviderStatus;
        object_key: string;
        sha256: string;
        size_bytes: number;
        mime_type: string;
        ext: string;
      }
    | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "素材版本不存在");
  }

  return {
    assetId: row.asset_id,
    versionId: row.version_id,
    fileId: row.file_id,
    originalFilename: row.original_filename,
    storageId: row.storage_id,
    storageStatus: row.storage_status,
    objectKey: row.object_key,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    ext: row.ext,
    thumbStatus: row.thumb_status,
    thumbKey: row.thumb_key
  };
}

export async function ensureThumbnailReady(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  versionInfo: ResolvedAssetVersionFile,
  forceRegenerate = false
): Promise<{ absPath: string; thumbStatus: ThumbStatus; regenerated: boolean }> {
  if (!isRasterImageMime(versionInfo.mimeType)) {
    throw new AppError(404, "NOT_FOUND", "当前文件类型不支持位图缩略图");
  }

  const relKey = versionInfo.thumbKey || buildThumbnailRelPath(versionInfo.sha256);
  const absPath = resolveThumbnailAbsPath(config.cache.path, relKey);

  if (!forceRegenerate && (await isValidThumbnailFile(absPath))) {
    return { absPath, thumbStatus: "ready", regenerated: false };
  }

  if (forceRegenerate) {
    await fsp.rm(absPath, { force: true }).catch(() => {});
  }

  const provider = storageRegistry.require(versionInfo.storageId);
  const readRes = await provider.get(versionInfo.objectKey);
  const generated = await generateThumbnailFromStream(
    readRes.stream,
    versionInfo.mimeType,
    versionInfo.sha256,
    config.cache.path,
    config.cache.maxSizeMB
  );

  db.transaction(() => {
    db.raw
      .prepare("UPDATE asset_versions SET thumb_status = ?, thumb_key = ? WHERE id = ?")
      .run(generated.thumbStatus, generated.thumbKey, versionInfo.versionId);
  });

  if (generated.thumbStatus !== "ready" || !generated.thumbKey) {
    throw new AppError(500, "INTERNAL_ERROR", "缩略图生成失败，原图可能已损坏或超像素限制");
  }

  return {
    absPath: resolveThumbnailAbsPath(config.cache.path, generated.thumbKey),
    thumbStatus: "ready",
    regenerated: true
  };
}

export async function appendAssetVersion(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  actorUserId: string,
  assetId: string,
  staged: StagedUploadFile,
  options: AppendAssetVersionOptions
): Promise<{ asset: AssetDetail; version: AssetVersionRecord; deduplicated: boolean }> {
  const existingAsset = db.raw
    .prepare("SELECT id, name FROM assets WHERE id = ? AND deleted_at IS NULL")
    .get(assetId) as { id: string; name: string } | undefined;
  if (!existingAsset) {
    throw new AppError(404, "NOT_FOUND", "素材不存在或已移入回收站");
  }

  if (options.referenceAssetVersionId) {
    const refVersion = db.raw
      .prepare("SELECT id FROM asset_versions WHERE id = ?")
      .get(options.referenceAssetVersionId);
    if (!refVersion) {
      throw new AppError(404, "NOT_FOUND", "指定的参考素材版本不存在");
    }
  }

  const safeFilename = sanitizeFilename(staged.originalFilename);
  const detected = detectFileType(staged.header, safeFilename, staged.declaredMime);
  const targetStorageId = options.storageId || getDefaultStorageId(db, config);

  const providerRow = db.raw
    .prepare("SELECT id, enabled, status FROM storage_providers WHERE id = ?")
    .get(targetStorageId) as { id: string; enabled: number; status: StorageProviderStatus } | undefined;

  if (!providerRow || providerRow.enabled !== 1 || providerRow.status === "missing_config") {
    throw new AppError(503, "STORAGE_OFFLINE", `目标存储空间 "${targetStorageId}" 当前不可用`);
  }

  const storageProvider = storageRegistry.require(targetStorageId);
  const objectKey = buildOriginalObjectKey(staged.sha256);
  const dimensions = await inspectImageDimensions(staged.tempPath, detected.mimeType);

  const existingFile = db.raw
    .prepare(
      `SELECT id, object_key, state, width, height
       FROM files
       WHERE storage_id = ? AND sha256 = ?`
    )
    .get(targetStorageId, staged.sha256) as
    | {
        id: string;
        object_key: string;
        state: string;
        width: number | null;
        height: number | null;
      }
    | undefined;

  let deduplicated = false;
  let fileId: string;

  if (existingFile && existingFile.state === "ready" && (await storageProvider.exists(existingFile.object_key))) {
    deduplicated = true;
    fileId = existingFile.id;
  } else {
    await storageProvider.put(objectKey, fs.createReadStream(staged.tempPath), {
      contentType: detected.mimeType,
      contentLength: staged.sizeBytes,
      sha256: staged.sha256
    });
    fileId = existingFile?.id ?? crypto.randomUUID();
  }

  const expectedThumbKey = buildThumbnailRelPath(staged.sha256);
  const expectedThumbAbs = resolveThumbnailAbsPath(config.cache.path, expectedThumbKey);
  let thumbResult: { thumbStatus: ThumbStatus; thumbKey: string | null };
  if (detected.isRasterPreviewable && (await isValidThumbnailFile(expectedThumbAbs))) {
    thumbResult = { thumbStatus: "ready", thumbKey: expectedThumbKey };
  } else {
    thumbResult = await generateThumbnailFromFile(
      staged.tempPath,
      detected.mimeType,
      staged.sha256,
      config.cache.path,
      config.cache.maxSizeMB
    );
  }

  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const setAsCurrent = options.setAsCurrent !== false;
  let versionNo = 1;

  db.transaction(() => {
    if (!deduplicated) {
      db.raw
        .prepare(
          `INSERT INTO files (
             id, storage_id, object_key, sha256, size_bytes, mime_type, ext,
             width, height, duration_ms, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ready', ?, ?)
           ON CONFLICT(storage_id, sha256) DO UPDATE SET
             state = 'ready',
             width = COALESCE(files.width, excluded.width),
             height = COALESCE(files.height, excluded.height),
             updated_at = excluded.updated_at`
        )
        .run(
          fileId,
          targetStorageId,
          objectKey,
          staged.sha256,
          staged.sizeBytes,
          detected.mimeType,
          detected.ext,
          dimensions.width,
          dimensions.height,
          now,
          now
        );
      const resolved = db.raw
        .prepare("SELECT id FROM files WHERE storage_id = ? AND sha256 = ?")
        .get(targetStorageId, staged.sha256) as { id: string };
      fileId = resolved.id;
    } else if ((dimensions.width && !existingFile?.width) || (dimensions.height && !existingFile?.height)) {
      db.raw
        .prepare(
          "UPDATE files SET width = COALESCE(width, ?), height = COALESCE(height, ?), updated_at = ? WHERE id = ?"
        )
        .run(dimensions.width, dimensions.height, now, fileId);
    }

    const maxRow = db.raw
      .prepare("SELECT COALESCE(MAX(version_no), 0) AS max_no FROM asset_versions WHERE asset_id = ?")
      .get(assetId) as { max_no: number };
    versionNo = Number(maxRow.max_no) + 1;

    db.raw
      .prepare(
        `INSERT INTO asset_versions (
           id, asset_id, file_id, version_no, original_filename,
           change_note, prompt_text, reference_asset_version_id,
           review_status, review_note, thumb_status, thumb_key, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, '{}', ?)`
      )
      .run(
        versionId,
        assetId,
        fileId,
        versionNo,
        safeFilename,
        options.changeNote.trim(),
        options.promptText.trim(),
        options.referenceAssetVersionId,
        thumbResult.thumbStatus,
        thumbResult.thumbKey,
        now
      );

    if (setAsCurrent) {
      db.raw
        .prepare("UPDATE assets SET current_version_id = ?, original_filename = ?, updated_at = ? WHERE id = ?")
        .run(versionId, safeFilename, now, assetId);
    } else {
      db.raw
        .prepare("UPDATE assets SET updated_at = ? WHERE id = ?")
        .run(now, assetId);
    }

    rebuildAssetSearchDocument(db, assetId);
    recordActivity(db, {
      actorUserId,
      action: "asset.version.append",
      objectType: "asset_version",
      objectId: versionId,
      details: {
        assetId,
        versionNo,
        storageId: targetStorageId,
        deduplicated,
        setAsCurrent
      }
    });
  });

  const detail = getAssetDetail(db, assetId);
  const createdVersion = detail.versions.find((ver) => ver.id === versionId)!;
  return { asset: detail, version: createdVersion, deduplicated };
}

export function switchAssetCurrentVersion(
  db: AppDatabase,
  actorUserId: string,
  assetId: string,
  versionId: string
): AssetDetail {
  const asset = db.raw
    .prepare("SELECT id, current_version_id FROM assets WHERE id = ? AND deleted_at IS NULL")
    .get(assetId) as { id: string; current_version_id: string } | undefined;
  if (!asset) {
    throw new AppError(404, "NOT_FOUND", "素材不存在或已移入回收站");
  }

  const targetVersion = db.raw
    .prepare("SELECT id, version_no, original_filename FROM asset_versions WHERE id = ? AND asset_id = ?")
    .get(versionId, assetId) as
    | { id: string; version_no: number; original_filename: string }
    | undefined;
  if (!targetVersion) {
    throw new AppError(404, "NOT_FOUND", "指定的版本不属于当前素材");
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.raw
      .prepare("UPDATE assets SET current_version_id = ?, original_filename = ?, updated_at = ? WHERE id = ?")
      .run(versionId, targetVersion.original_filename, now, assetId);
    rebuildAssetSearchDocument(db, assetId);
    recordActivity(db, {
      actorUserId,
      action: "asset.current_version.switch",
      objectType: "asset",
      objectId: assetId,
      details: {
        previousVersionId: asset.current_version_id,
        currentVersionId: versionId,
        versionNo: targetVersion.version_no
      }
    });
  });

  return getAssetDetail(db, assetId);
}

export function reviewAssetVersion(
  db: AppDatabase,
  actorUserId: string,
  versionId: string,
  input: { reviewStatus: ReviewStatus; reviewNote?: string }
): AssetVersionRecord {
  const existing = db.raw
    .prepare(
      `SELECT av.id, av.asset_id, av.version_no, a.deleted_at
       FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
       WHERE av.id = ?`
    )
    .get(versionId) as
    | { id: string; asset_id: string; version_no: number; deleted_at: string | null }
    | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "素材版本不存在");
  }

  const now = new Date().toISOString();
  const reviewedAt = input.reviewStatus === "pending" ? null : now;
  const reviewNote = input.reviewNote ?? "";

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE asset_versions
         SET review_status = ?, review_note = ?, reviewed_at = ?
         WHERE id = ?`
      )
      .run(input.reviewStatus, reviewNote, reviewedAt, versionId);
    db.raw
      .prepare("UPDATE assets SET updated_at = ? WHERE id = ?")
      .run(now, existing.asset_id);
    rebuildAssetSearchDocument(db, existing.asset_id);
    recordActivity(db, {
      actorUserId,
      action: "asset_version.review",
      objectType: "asset_version",
      objectId: versionId,
      details: {
        assetId: existing.asset_id,
        versionNo: existing.version_no,
        reviewStatus: input.reviewStatus
      }
    });
  });

  const detail = getAssetDetail(db, existing.asset_id);
  const updatedVersion = detail.versions.find((ver) => ver.id === versionId);
  if (!updatedVersion) {
    throw new AppError(404, "NOT_FOUND", "素材版本不存在");
  }
  return updatedVersion;
}
