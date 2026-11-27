import crypto from "node:crypto";
import type {
  AssetSetItemRecord,
  AssetSetKind,
  AssetType,
  ListingAssetSetsResponse,
  StorageProviderStatus,
  ThumbStatus
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";

export const ASSET_SET_KINDS: AssetSetKind[] = ["carousel", "detail", "sku", "video"];

function ensureActiveListing(db: AppDatabase, listingId: string): void {
  const row = db.raw
    .prepare("SELECT id FROM listings WHERE id = ? AND deleted_at IS NULL")
    .get(listingId);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "上架链接不存在或已移入回收站");
  }
}

export function ensureListingAssetSetsInTx(
  db: AppDatabase,
  listingId: string,
  now: string
): Record<AssetSetKind, string> {
  const insertStmt = db.raw.prepare(
    `INSERT OR IGNORE INTO asset_sets (id, listing_id, kind, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  for (const kind of ASSET_SET_KINDS) {
    insertStmt.run(crypto.randomUUID(), listingId, kind, now);
  }

  const rows = db.raw
    .prepare("SELECT id, kind FROM asset_sets WHERE listing_id = ?")
    .all(listingId) as Array<{ id: string; kind: AssetSetKind }>;

  const map = {} as Record<AssetSetKind, string>;
  for (const row of rows) {
    map[row.kind] = row.id;
  }
  return map;
}

interface SetItemJoinedRow {
  id: string;
  set_id: string;
  kind: AssetSetKind;
  position: number;
  asset_version_id: string;
  asset_id: string;
  asset_name: string;
  asset_type: AssetType;
  asset_deleted_at: string | null;
  original_filename: string;
  version_no: number;
  current_version_id: string | null;
  latest_version_no: number;
  latest_version_id: string;
  thumb_status: ThumbStatus;
  storage_id: string;
  storage_status: StorageProviderStatus;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  ext: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  listing_sku_id: string | null;
  sku_code: string | null;
  sku_channel_code: string | null;
  sku_display_name: string | null;
  created_at: string;
}

export function getListingAssetSets(
  db: AppDatabase,
  listingId: string
): ListingAssetSetsResponse {
  ensureActiveListing(db, listingId);

  const now = new Date().toISOString();
  let setRows = db.raw
    .prepare("SELECT id, kind, updated_at FROM asset_sets WHERE listing_id = ?")
    .all(listingId) as Array<{ id: string; kind: AssetSetKind; updated_at: string }>;

  if (setRows.length < ASSET_SET_KINDS.length) {
    db.transaction(() => {
      ensureListingAssetSetsInTx(db, listingId, now);
    });
    setRows = db.raw
      .prepare("SELECT id, kind, updated_at FROM asset_sets WHERE listing_id = ?")
      .all(listingId) as Array<{ id: string; kind: AssetSetKind; updated_at: string }>;
  }

  const itemRows = db.raw
    .prepare(
      `SELECT
         asi.id, asi.set_id, s.kind, asi.position, asi.asset_version_id,
         av.asset_id, a.name AS asset_name, a.asset_type, a.deleted_at AS asset_deleted_at,
         av.original_filename, av.version_no, a.current_version_id,
         (SELECT MAX(av2.version_no) FROM asset_versions av2 WHERE av2.asset_id = av.asset_id) AS latest_version_no,
         (SELECT av3.id FROM asset_versions av3 WHERE av3.asset_id = av.asset_id ORDER BY av3.version_no DESC LIMIT 1) AS latest_version_id,
         av.thumb_status,
         f.storage_id, sp.status AS storage_status, f.sha256, f.size_bytes,
         f.mime_type, f.ext, f.width, f.height, f.duration_ms,
         asi.listing_sku_id, sk.code AS sku_code, ls.channel_code AS sku_channel_code,
         ls.display_name AS sku_display_name, asi.created_at
       FROM asset_set_items asi
       JOIN asset_sets s ON s.id = asi.set_id
       JOIN asset_versions av ON av.id = asi.asset_version_id
       JOIN assets a ON a.id = av.asset_id
       JOIN files f ON f.id = av.file_id
       JOIN storage_providers sp ON sp.id = f.storage_id
       LEFT JOIN listing_skus ls ON ls.id = asi.listing_sku_id
       LEFT JOIN skus sk ON sk.id = ls.sku_id
       WHERE s.listing_id = ?
       ORDER BY s.kind ASC, asi.position ASC, asi.created_at ASC, asi.id ASC`
    )
    .all(listingId) as unknown as SetItemJoinedRow[];

  const groupedRaw = new Map<AssetSetKind, SetItemJoinedRow[]>();
  for (const kind of ASSET_SET_KINDS) {
    groupedRaw.set(kind, []);
  }
  for (const row of itemRows) {
    groupedRaw.get(row.kind)?.push(row);
  }

  const sets = {} as ListingAssetSetsResponse["sets"];
  for (const setRow of setRows) {
    const rows = groupedRaw.get(setRow.kind) ?? [];
    const versionCounts = new Map<string, number>();
    const assetCounts = new Map<string, number>();
    for (const row of rows) {
      versionCounts.set(row.asset_version_id, (versionCounts.get(row.asset_version_id) ?? 0) + 1);
      assetCounts.set(row.asset_id, (assetCounts.get(row.asset_id) ?? 0) + 1);
    }

    const items: AssetSetItemRecord[] = rows.map((row) => {
      const preferredLatestId =
        row.latest_version_no > row.version_no
          ? row.latest_version_id
          : row.current_version_id ?? row.latest_version_id;
      const hasNewerVersion =
        row.latest_version_no > row.version_no ||
        (Boolean(row.current_version_id) && row.current_version_id !== row.asset_version_id);

      return {
        id: row.id,
        setId: row.set_id,
        kind: row.kind,
        position: row.position,
        assetVersionId: row.asset_version_id,
        assetId: row.asset_id,
        assetName: row.asset_name,
        assetType: row.asset_type,
        assetDeleted: row.asset_deleted_at !== null,
        originalFilename: row.original_filename,
        versionNo: row.version_no,
        latestVersionId: preferredLatestId,
        latestVersionNo: row.latest_version_no,
        hasNewerVersion,
        thumbStatus: row.thumb_status,
        storageId: row.storage_id,
        storageStatus: row.storage_status,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        mimeType: row.mime_type,
        ext: row.ext,
        width: row.width,
        height: row.height,
        durationMs: row.duration_ms,
        listingSkuId: row.listing_sku_id,
        skuCode: row.sku_code,
        skuChannelCode: row.sku_channel_code,
        skuDisplayName: row.sku_display_name,
        isDuplicateVersion: (versionCounts.get(row.asset_version_id) ?? 0) > 1,
        isDuplicateAsset: (assetCounts.get(row.asset_id) ?? 0) > 1,
        createdAt: row.created_at
      };
    });

    sets[setRow.kind] = {
      id: setRow.id,
      kind: setRow.kind,
      updatedAt: setRow.updated_at,
      items
    };
  }

  return { listingId, sets };
}

export interface ReplaceAssetSetItemInput {
  assetVersionId: string;
  listingSkuId?: string | null;
}

export function replaceListingAssetSet(
  db: AppDatabase,
  actorUserId: string,
  listingId: string,
  kind: AssetSetKind,
  items: ReplaceAssetSetItemInput[],
  expectedItemIds?: string[]
): ListingAssetSetsResponse {
  const now = new Date().toISOString();
  db.transaction(() => {
    ensureActiveListing(db, listingId);

    const uniqueVersionIds = Array.from(new Set(items.map((item) => item.assetVersionId)));
    if (uniqueVersionIds.length > 0) {
      const placeholders = uniqueVersionIds.map(() => "?").join(", ");
      const found = db.raw
        .prepare(`SELECT id FROM asset_versions WHERE id IN (${placeholders})`)
        .all(...uniqueVersionIds) as Array<{ id: string }>;
      const foundSet = new Set(found.map((row) => row.id));
      for (const vid of uniqueVersionIds) {
        if (!foundSet.has(vid)) {
          throw new AppError(404, "NOT_FOUND", `素材版本 "${vid}" 不存在`);
        }
      }
    }

    if (kind === "sku") {
      const validListingSkus = new Set(
        (
          db.raw
            .prepare("SELECT id FROM listing_skus WHERE listing_id = ?")
            .all(listingId) as Array<{ id: string }>
        ).map((row) => row.id)
      );

      for (const item of items) {
        if (!item.listingSkuId) {
          throw new AppError(400, "VALIDATION_ERROR", "SKU 图集合中的每一项都必须绑定具体的 Listing SKU");
        }
        if (!validListingSkus.has(item.listingSkuId)) {
          throw new AppError(400, "VALIDATION_ERROR", "指定的 Listing SKU 不属于当前上架链接");
        }
      }
    }

    const setMap = ensureListingAssetSetsInTx(db, listingId, now);
    const setId = setMap[kind];
    if (expectedItemIds) {
      const current = db.raw
        .prepare("SELECT id FROM asset_set_items WHERE set_id = ? ORDER BY position, created_at, id")
        .all(setId) as Array<{ id: string }>;
      if (
        current.length !== expectedItemIds.length ||
        current.some((item, index) => item.id !== expectedItemIds[index])
      ) {
        throw new AppError(409, "CONFLICT", "这个图组已在其他页面更新，请检查最新内容后重试");
      }
    }

    db.raw.prepare("DELETE FROM asset_set_items WHERE set_id = ?").run(setId);

    const insertItem = db.raw.prepare(
      `INSERT INTO asset_set_items (id, set_id, asset_version_id, listing_sku_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    items.forEach((item, index) => {
      insertItem.run(
        crypto.randomUUID(),
        setId,
        item.assetVersionId,
        kind === "sku" ? item.listingSkuId ?? null : null,
        index,
        now
      );
    });

    db.raw.prepare("UPDATE asset_sets SET updated_at = ? WHERE id = ?").run(now, setId);
    db.raw.prepare("UPDATE listings SET updated_at = ? WHERE id = ?").run(now, listingId);

    recordActivity(db, {
      actorUserId,
      action: "listing.asset_set.update",
      objectType: "asset_set",
      objectId: setId,
      details: { listingId, kind, itemCount: items.length }
    });
  });

  return getListingAssetSets(db, listingId);
}
