import type { TrashAssetItem, TrashProductItem, TrashResponse } from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import {
  rebuildAssetSearchDocument,
  rebuildProductLinkedAssetSearchDocuments,
  rebuildProductSearchDocument
} from "../search/service.js";
import { recordActivity } from "../system/activity.js";

export function listTrash(db: AppDatabase): TrashResponse {
  const assetRows = db.raw
    .prepare(
      `SELECT
         a.id, a.name, a.original_filename, a.asset_type, a.current_version_id,
         av.thumb_status, f.size_bytes, a.deleted_at,
         (SELECT COUNT(*) FROM product_assets pa WHERE pa.asset_id = a.id) AS product_count,
         (SELECT COUNT(*) FROM asset_tags at WHERE at.asset_id = a.id) AS tag_count
       FROM assets a
       JOIN asset_versions av ON av.id = a.current_version_id
       JOIN files f ON f.id = av.file_id
       WHERE a.deleted_at IS NOT NULL
       ORDER BY a.deleted_at DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    original_filename: string;
    asset_type: TrashAssetItem["assetType"];
    current_version_id: string;
    thumb_status: TrashAssetItem["thumbStatus"];
    size_bytes: number;
    deleted_at: string;
    product_count: number;
    tag_count: number;
  }>;

  const productRows = db.raw
    .prepare(
      `SELECT
         p.id, p.spu, p.name_zh, p.name_en, p.deleted_at,
         (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id) AS sku_count,
         (SELECT COUNT(*) FROM product_assets pa WHERE pa.product_id = p.id) AS asset_count
       FROM products p
       WHERE p.deleted_at IS NOT NULL
       ORDER BY p.deleted_at DESC`
    )
    .all() as Array<{
    id: string;
    spu: string;
    name_zh: string;
    name_en: string;
    deleted_at: string;
    sku_count: number;
    asset_count: number;
  }>;

  const assets: TrashAssetItem[] = assetRows.map((row) => ({
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    assetType: row.asset_type,
    sizeBytes: Number(row.size_bytes),
    currentVersionId: row.current_version_id,
    thumbStatus: row.thumb_status,
    productCount: Number(row.product_count ?? 0),
    tagCount: Number(row.tag_count ?? 0),
    deletedAt: row.deleted_at
  }));

  const products: TrashProductItem[] = productRows.map((row) => ({
    id: row.id,
    spu: row.spu,
    nameZh: row.name_zh,
    nameEn: row.name_en,
    skuCount: Number(row.sku_count ?? 0),
    assetCount: Number(row.asset_count ?? 0),
    deletedAt: row.deleted_at
  }));

  return { assets, products };
}

export function restoreFromTrash(
  db: AppDatabase,
  actorUserId: string,
  input: { type: "asset" | "product"; ids: string[] }
): { restoredCount: number } {
  const uniqueIds = Array.from(new Set(input.ids));
  if (uniqueIds.length === 0) {
    return { restoredCount: 0 };
  }

  const now = new Date().toISOString();
  let restoredCount = 0;

  db.transaction(() => {
    if (input.type === "asset") {
      const stmt = db.raw.prepare(
        "UPDATE assets SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL"
      );
      for (const id of uniqueIds) {
        const res = stmt.run(now, id);
        if (res.changes > 0) {
          restoredCount += 1;
          rebuildAssetSearchDocument(db, id);
        }
      }
    } else {
      const stmt = db.raw.prepare(
        "UPDATE products SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL"
      );
      for (const id of uniqueIds) {
        const res = stmt.run(now, id);
        if (res.changes > 0) {
          restoredCount += 1;
          rebuildProductSearchDocument(db, id);
          rebuildProductLinkedAssetSearchDocuments(db, id);
        }
      }
    }

    recordActivity(db, {
      actorUserId,
      action: `trash.restore.${input.type}`,
      objectType: input.type,
      objectId: uniqueIds.length === 1 ? uniqueIds[0]! : null,
      details: { count: restoredCount }
    });
  });

  return { restoredCount };
}
