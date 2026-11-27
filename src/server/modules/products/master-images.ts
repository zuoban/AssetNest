import crypto from "node:crypto";
import type {
  ProductMasterImageRecord,
  StorageProviderStatus,
  ThumbStatus
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";

interface MasterImageRow {
  id: string;
  product_id: string;
  asset_id: string;
  asset_name: string;
  asset_version_id: string;
  version_no: number;
  latest_version_id: string;
  latest_version_no: number;
  original_filename: string;
  angle: string;
  is_primary: number;
  lock_note: string;
  locked_at: string;
  unlocked_at: string | null;
  unlock_note: string | null;
  thumb_status: ThumbStatus;
  storage_id: string;
  storage_status: StorageProviderStatus;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  ext: string;
  width: number | null;
  height: number | null;
}

function mapMasterRow(row: MasterImageRow): ProductMasterImageRecord {
  return {
    id: row.id,
    productId: row.product_id,
    assetId: row.asset_id,
    assetName: row.asset_name,
    assetVersionId: row.asset_version_id,
    versionNo: row.version_no,
    latestVersionId: row.latest_version_id,
    latestVersionNo: row.latest_version_no,
    originalFilename: row.original_filename,
    angle: row.angle,
    isPrimary: row.is_primary === 1,
    lockNote: row.lock_note,
    lockedAt: row.locked_at,
    unlockedAt: row.unlocked_at,
    unlockNote: row.unlock_note,
    thumbStatus: row.thumb_status,
    storageId: row.storage_id,
    storageStatus: row.storage_status,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    ext: row.ext,
    width: row.width,
    height: row.height
  };
}

function ensureProductExists(db: AppDatabase, productId: string): { id: string; spu: string } {
  const product = db.raw
    .prepare("SELECT id, spu FROM products WHERE id = ? AND deleted_at IS NULL")
    .get(productId) as { id: string; spu: string } | undefined;
  if (!product) {
    throw new AppError(404, "NOT_FOUND", "商品不存在或已移入回收站");
  }
  return product;
}

export function listProductMasterImages(
  db: AppDatabase,
  productId: string,
  includeHistory = false
): ProductMasterImageRecord[] {
  ensureProductExists(db, productId);

  const whereClause = includeHistory
    ? "pmi.product_id = ?"
    : "pmi.product_id = ? AND pmi.unlocked_at IS NULL";

  const rows = db.raw
    .prepare(
      `SELECT
         pmi.id, pmi.product_id, av.asset_id, a.name AS asset_name,
         pmi.asset_version_id, av.version_no,
         a.current_version_id AS latest_version_id,
         (SELECT MAX(av2.version_no) FROM asset_versions av2 WHERE av2.asset_id = av.asset_id) AS latest_version_no,
         av.original_filename, pmi.angle, pmi.is_primary, pmi.lock_note,
         pmi.locked_at, pmi.unlocked_at, pmi.unlock_note,
         av.thumb_status,
         f.storage_id, sp.status AS storage_status, f.sha256, f.size_bytes,
         f.mime_type, f.ext, f.width, f.height
       FROM product_master_images pmi
       JOIN asset_versions av ON av.id = pmi.asset_version_id
       JOIN assets a ON a.id = av.asset_id
       JOIN files f ON f.id = av.file_id
       JOIN storage_providers sp ON sp.id = f.storage_id
       WHERE ${whereClause}
       ORDER BY (pmi.unlocked_at IS NOT NULL) ASC, pmi.is_primary DESC, pmi.locked_at DESC`
    )
    .all(productId) as unknown as MasterImageRow[];

  return rows.map(mapMasterRow);
}

export interface LockMasterImageInput {
  assetVersionId: string;
  angle?: string;
  isPrimary?: boolean;
  lockNote?: string;
}

export function lockProductMasterImage(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  input: LockMasterImageInput
): ProductMasterImageRecord {
  const product = ensureProductExists(db, productId);
  const versionRow = db.raw
    .prepare(
      `SELECT av.id, av.asset_id, av.version_no, a.deleted_at
       FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
       WHERE av.id = ?`
    )
    .get(input.assetVersionId) as
    | { id: string; asset_id: string; version_no: number; deleted_at: string | null }
    | undefined;

  if (!versionRow || versionRow.deleted_at !== null) {
    throw new AppError(404, "NOT_FOUND", "指定的素材版本不存在或已移入回收站");
  }

  const duplicateActive = db.raw
    .prepare(
      `SELECT id FROM product_master_images
       WHERE product_id = ? AND asset_version_id = ? AND unlocked_at IS NULL`
    )
    .get(productId, input.assetVersionId) as { id: string } | undefined;
  if (duplicateActive) {
    throw new AppError(409, "CONFLICT", "该素材版本已锁定为当前商品的母图");
  }

  const masterId = crypto.randomUUID();
  const now = new Date().toISOString();
  const angle = (input.angle ?? "front").trim() || "front";
  const lockNote = (input.lockNote ?? "").trim();

  db.transaction(() => {
    const activeCountRow = db.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM product_master_images WHERE product_id = ? AND unlocked_at IS NULL"
      )
      .get(productId) as { count: number };
    const shouldBePrimary = input.isPrimary === true || Number(activeCountRow.count) === 0;

    if (shouldBePrimary) {
      db.raw
        .prepare(
          "UPDATE product_master_images SET is_primary = 0 WHERE product_id = ? AND unlocked_at IS NULL"
        )
        .run(productId);
    }

    db.raw
      .prepare(
        `INSERT INTO product_master_images (
           id, product_id, asset_version_id, angle, is_primary, lock_note, locked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(masterId, productId, input.assetVersionId, angle, shouldBePrimary ? 1 : 0, lockNote, now);

    // Ensure asset is linked to this product and fill cover if empty
    db.raw
      .prepare("INSERT OR IGNORE INTO product_assets (product_id, asset_id, created_at) VALUES (?, ?, ?)")
      .run(productId, versionRow.asset_id, now);
    if (shouldBePrimary) {
      db.raw
        .prepare(
          "UPDATE products SET cover_version_id = COALESCE(cover_version_id, ?), updated_at = ? WHERE id = ?"
        )
        .run(input.assetVersionId, now, productId);
    }

    recordActivity(db, {
      actorUserId,
      action: "product.master_image.lock",
      objectType: "product_master_image",
      objectId: masterId,
      details: {
        productId,
        spu: product.spu,
        assetVersionId: input.assetVersionId,
        versionNo: versionRow.version_no,
        angle,
        isPrimary: shouldBePrimary
      }
    });
  });

  const items = listProductMasterImages(db, productId, true);
  return items.find((item) => item.id === masterId)!;
}

export function setPrimaryMasterImage(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  masterId: string
): ProductMasterImageRecord {
  ensureProductExists(db, productId);
  const existing = db.raw
    .prepare(
      `SELECT id, asset_version_id, unlocked_at
       FROM product_master_images
       WHERE id = ? AND product_id = ?`
    )
    .get(masterId, productId) as
    | { id: string; asset_version_id: string; unlocked_at: string | null }
    | undefined;

  if (!existing || existing.unlocked_at !== null) {
    throw new AppError(404, "NOT_FOUND", "母图记录不存在或已解除锁定");
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.raw
      .prepare(
        "UPDATE product_master_images SET is_primary = 0 WHERE product_id = ? AND unlocked_at IS NULL"
      )
      .run(productId);
    db.raw
      .prepare("UPDATE product_master_images SET is_primary = 1 WHERE id = ?")
      .run(masterId);
    db.raw
      .prepare("UPDATE products SET updated_at = ? WHERE id = ?")
      .run(now, productId);

    recordActivity(db, {
      actorUserId,
      action: "product.master_image.set_primary",
      objectType: "product_master_image",
      objectId: masterId,
      details: { productId, assetVersionId: existing.asset_version_id }
    });
  });

  const items = listProductMasterImages(db, productId, true);
  return items.find((item) => item.id === masterId)!;
}

export interface UnlockMasterImageInput {
  unlockNote: string;
  replacementAssetVersionId?: string;
  replacementAngle?: string;
  replacementLockNote?: string;
}

export function unlockProductMasterImage(
  db: AppDatabase,
  actorUserId: string,
  productId: string,
  masterId: string,
  input: UnlockMasterImageInput
): { unlocked: ProductMasterImageRecord; replacement: ProductMasterImageRecord | null } {
  const product = ensureProductExists(db, productId);
  const unlockNote = input.unlockNote.trim();
  if (!unlockNote) {
    throw new AppError(400, "VALIDATION_ERROR", "解除或替换母图必须填写原因备注");
  }

  const existing = db.raw
    .prepare(
      `SELECT id, asset_version_id, angle, is_primary, unlocked_at
       FROM product_master_images
       WHERE id = ? AND product_id = ?`
    )
    .get(masterId, productId) as
    | {
        id: string;
        asset_version_id: string;
        angle: string;
        is_primary: number;
        unlocked_at: string | null;
      }
    | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "母图记录不存在");
  }
  if (existing.unlocked_at !== null) {
    throw new AppError(409, "CONFLICT", "该母图已处于解除锁定状态");
  }

  let replacementVersion:
    | { id: string; asset_id: string; version_no: number; deleted_at: string | null }
    | undefined;
  if (input.replacementAssetVersionId) {
    replacementVersion = db.raw
      .prepare(
        `SELECT av.id, av.asset_id, av.version_no, a.deleted_at
         FROM asset_versions av
         JOIN assets a ON a.id = av.asset_id
         WHERE av.id = ?`
      )
      .get(input.replacementAssetVersionId) as
      | { id: string; asset_id: string; version_no: number; deleted_at: string | null }
      | undefined;
    if (!replacementVersion || replacementVersion.deleted_at !== null) {
      throw new AppError(404, "NOT_FOUND", "替换用的素材版本不存在或已移入回收站");
    }
  }

  const now = new Date().toISOString();
  let replacementId: string | null = null;

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE product_master_images
         SET unlocked_at = ?, unlock_note = ?, is_primary = 0
         WHERE id = ?`
      )
      .run(now, unlockNote, masterId);

    if (replacementVersion) {
      const dup = db.raw
        .prepare(
          `SELECT id FROM product_master_images
           WHERE product_id = ? AND asset_version_id = ? AND unlocked_at IS NULL`
        )
        .get(productId, replacementVersion.id) as { id: string } | undefined;
      if (dup) {
        throw new AppError(409, "CONFLICT", "替换的目标版本已是当前商品的锁定母图");
      }

      replacementId = crypto.randomUUID();
      const newAngle = (input.replacementAngle ?? existing.angle).trim() || existing.angle;
      const newLockNote = (input.replacementLockNote ?? `替换原母图：${unlockNote}`).trim();
      const keepPrimary = existing.is_primary === 1;
      if (keepPrimary) {
        db.raw
          .prepare(
            "UPDATE product_master_images SET is_primary = 0 WHERE product_id = ? AND unlocked_at IS NULL"
          )
          .run(productId);
      }

      db.raw
        .prepare(
          `INSERT INTO product_master_images (
             id, product_id, asset_version_id, angle, is_primary, lock_note, locked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          replacementId,
          productId,
          replacementVersion.id,
          newAngle,
          keepPrimary ? 1 : 0,
          newLockNote,
          now
        );

      db.raw
        .prepare("INSERT OR IGNORE INTO product_assets (product_id, asset_id, created_at) VALUES (?, ?, ?)")
        .run(productId, replacementVersion.asset_id, now);
    } else if (existing.is_primary === 1) {
      const nextPrimary = db.raw
        .prepare(
          `SELECT id FROM product_master_images
           WHERE product_id = ? AND unlocked_at IS NULL
           ORDER BY locked_at ASC LIMIT 1`
        )
        .get(productId) as { id: string } | undefined;
      if (nextPrimary) {
        db.raw
          .prepare("UPDATE product_master_images SET is_primary = 1 WHERE id = ?")
          .run(nextPrimary.id);
      }
    }

    recordActivity(db, {
      actorUserId,
      action: replacementId ? "product.master_image.replace" : "product.master_image.unlock",
      objectType: "product_master_image",
      objectId: masterId,
      details: {
        productId,
        spu: product.spu,
        unlockNote,
        replacementId,
        replacementAssetVersionId: replacementVersion?.id ?? null
      }
    });
  });

  const items = listProductMasterImages(db, productId, true);
  return {
    unlocked: items.find((item) => item.id === masterId)!,
    replacement: replacementId ? items.find((item) => item.id === replacementId) ?? null : null
  };
}
