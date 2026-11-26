import crypto from "node:crypto";
import type {
  AssetSetKind,
  ExportRecord,
  ExportTemplateRules,
  ListingDetail,
  ListingValidationResult,
  PdpContent,
  ReleaseAssetRecord,
  ReleaseDetail,
  ReleaseSummary
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { ensureListingAssetSetsInTx } from "../listings/asset-sets.js";
import { parsePdpContentJson } from "../listings/pdp.js";
import { getListingDetail } from "../listings/service.js";
import { rebuildListingSearchDocument } from "../search/service.js";
import { recordActivity } from "../system/activity.js";
import { validateListingForRelease } from "./validator.js";

export function sanitizePathSegment(raw: string, fallback: string): string {
  let cleaned = raw
    .normalize("NFC")
    .replace(/[\0-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[_.\s-]+|[_.\s-]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    cleaned = fallback;
  }
  if (cleaned.length > 80) {
    cleaned = cleaned.slice(0, 80).replace(/[_.\s-]+$/g, "") || fallback;
  }
  return cleaned;
}

export function sanitizeExtension(raw: string): string {
  const cleaned = raw.replace(/^\.+/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned || "bin";
}

function allocateUniqueRelativePath(
  usedLower: Set<string>,
  folder: string,
  baseName: string,
  ext: string
): string {
  const safeFolder = sanitizePathSegment(folder, "files");
  const safeBase = sanitizePathSegment(baseName, "file");
  const safeExt = sanitizeExtension(ext);

  let candidate = `${safeFolder}/${safeBase}.${safeExt}`;
  let counter = 2;
  while (usedLower.has(candidate.toLowerCase())) {
    candidate = `${safeFolder}/${safeBase}_${counter}.${safeExt}`;
    counter += 1;
  }
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

export interface ReleaseSnapshotData {
  snapshotFormatVersion: 1;
  listing: {
    id: string;
    productId: string;
    productSpu: string;
    productNameZh: string;
    productNameEn: string;
    storeId: string;
    storeName: string;
    platform: string;
    market: string;
    displayName: string;
    language: string;
    externalId: string | null;
    externalUrl: string | null;
    notes: string;
  };
  skus: Array<{
    listingSkuId: string;
    skuId: string;
    skuCode: string;
    skuName: string;
    channelCode: string;
    displayName: string;
    position: number;
  }>;
  template: {
    id: string;
    name: string;
    platform: string;
    market: string;
    version: number;
    rules: ExportTemplateRules;
  };
  pdp: {
    versionId: string;
    language: string;
    content: PdpContent;
  };
  assets: Array<{
    kind: AssetSetKind;
    position: number;
    assetId: string;
    assetName: string;
    assetVersionId: string;
    versionNo: number;
    originalFilename: string;
    listingSkuId: string | null;
    skuId: string | null;
    listingSkuCode: string | null;
    exportRelativePath: string;
    sha256: string;
    sizeBytes: number;
    mimeType: string;
    ext: string;
    width: number | null;
    height: number | null;
  }>;
}

interface ReleaseRow {
  id: string;
  listing_id: string;
  release_no: number;
  release_code: string;
  is_draft_package: number;
  template_id: string;
  template_name: string;
  template_version: number;
  pdp_version_id: string | null;
  validation_summary_json: string;
  immutable_snapshot_json: string;
  note: string;
  created_at: string;
  asset_count: number;
}

interface ExportRow {
  id: string;
  release_id: string;
  job_id: string | null;
  status: ExportRecord["status"];
  file_path: string | null;
  file_name: string;
  size_bytes: number | null;
  expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function mapExportRow(row: ExportRow): ExportRecord {
  let status = row.status;
  if (status === "ready" && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    status = "expired";
  }
  return {
    id: row.id,
    releaseId: row.release_id,
    jobId: row.job_id,
    status,
    fileName: row.file_name,
    sizeBytes: row.size_bytes !== null ? Number(row.size_bytes) : null,
    expiresAt: row.expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadLatestExportForRelease(db: AppDatabase, releaseId: string): ExportRecord | null {
  const row = db.raw
    .prepare(
      `SELECT id, release_id, job_id, status, file_path, file_name, size_bytes,
              expires_at, last_error, created_at, updated_at
       FROM exports
       WHERE release_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(releaseId) as ExportRow | undefined;
  return row ? mapExportRow(row) : null;
}

function loadExportsForRelease(db: AppDatabase, releaseId: string): ExportRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT id, release_id, job_id, status, file_path, file_name, size_bytes,
              expires_at, last_error, created_at, updated_at
       FROM exports
       WHERE release_id = ?
       ORDER BY created_at DESC
       LIMIT 20`
    )
    .all(releaseId) as unknown as ExportRow[];
  return rows.map(mapExportRow);
}

function mapReleaseSummary(db: AppDatabase, row: ReleaseRow): ReleaseSummary {
  let blockerCount = 0;
  let warningCount = 0;
  try {
    const parsed = JSON.parse(row.validation_summary_json) as ListingValidationResult;
    blockerCount = Array.isArray(parsed.blockers) ? parsed.blockers.length : 0;
    warningCount = Array.isArray(parsed.warnings) ? parsed.warnings.length : 0;
  } catch {
    // ignore malformed
  }
  return {
    id: row.id,
    listingId: row.listing_id,
    releaseNo: Number(row.release_no),
    releaseCode: row.release_code,
    isDraftPackage: row.is_draft_package === 1,
    templateId: row.template_id,
    templateName: row.template_name,
    templateVersion: Number(row.template_version),
    pdpVersionId: row.pdp_version_id,
    note: row.note,
    assetCount: Number(row.asset_count),
    blockerCount,
    warningCount,
    latestExport: loadLatestExportForRelease(db, row.id),
    createdAt: row.created_at
  };
}

export interface CreateReleaseInput {
  templateId?: string;
  isDraftPackage?: boolean;
  note?: string;
}

export async function createRelease(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  actorUserId: string,
  listingId: string,
  input: CreateReleaseInput
): Promise<ReleaseDetail> {
  const isDraftPackage = Boolean(input.isDraftPackage);
  const note = (input.note ?? "").trim();

  const { validation, template, listing, assetSets, pdp } = await validateListingForRelease(
    db,
    storageRegistry,
    listingId,
    input.templateId
  );

  if (!isDraftPackage && !validation.canCreateFormalRelease) {
    throw new AppError(
      409,
      "CONFLICT",
      `当前上架草稿存在 ${validation.blockers.length} 个阻断问题，无法创建正式 Release；请修复阻断项或改用明确标注的「草稿导出包」`,
      { blockers: validation.blockers }
    );
  }

  const skuByListingSkuId = new Map(listing.skus.map((sku) => [sku.id, sku]));
  const usedPaths = new Set<string>();
  const rules = template.rules;
  const plannedAssets: ReleaseSnapshotData["assets"] = [];

  // 1. Carousel
  assetSets.sets.carousel.items.forEach((item, index) => {
    const stem =
      index === 0
        ? rules.naming.mainImageName
        : `${String(index + 1).padStart(2, "0")}_${sanitizePathSegment(
            item.assetName,
            rules.naming.carouselPrefix
          )}`;
    const relPath = allocateUniqueRelativePath(usedPaths, rules.folders.carousel, stem, item.ext);
    plannedAssets.push({
      kind: "carousel",
      position: index,
      assetId: item.assetId,
      assetName: item.assetName,
      assetVersionId: item.assetVersionId,
      versionNo: item.versionNo,
      originalFilename: item.originalFilename,
      listingSkuId: null,
      skuId: null,
      listingSkuCode: null,
      exportRelativePath: relPath,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType,
      ext: sanitizeExtension(item.ext),
      width: item.width,
      height: item.height
    });
  });

  // 2. SKU images
  assetSets.sets.sku.items.forEach((item, index) => {
    const linkedSku = item.listingSkuId ? skuByListingSkuId.get(item.listingSkuId) : undefined;
    const skuCodeLabel =
      linkedSku?.channelCode || linkedSku?.skuCode || item.skuChannelCode || item.skuCode || `SKU_${index + 1}`;
    const relPath = allocateUniqueRelativePath(usedPaths, rules.folders.sku, skuCodeLabel, item.ext);
    plannedAssets.push({
      kind: "sku",
      position: index,
      assetId: item.assetId,
      assetName: item.assetName,
      assetVersionId: item.assetVersionId,
      versionNo: item.versionNo,
      originalFilename: item.originalFilename,
      listingSkuId: item.listingSkuId,
      skuId: linkedSku?.skuId ?? null,
      listingSkuCode: skuCodeLabel,
      exportRelativePath: relPath,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType,
      ext: sanitizeExtension(item.ext),
      width: item.width,
      height: item.height
    });
  });

  // 3. Detail images
  assetSets.sets.detail.items.forEach((item, index) => {
    const stem = `${rules.naming.detailPrefix}_${String(index + 1).padStart(2, "0")}`;
    const relPath = allocateUniqueRelativePath(usedPaths, rules.folders.detail, stem, item.ext);
    plannedAssets.push({
      kind: "detail",
      position: index,
      assetId: item.assetId,
      assetName: item.assetName,
      assetVersionId: item.assetVersionId,
      versionNo: item.versionNo,
      originalFilename: item.originalFilename,
      listingSkuId: null,
      skuId: null,
      listingSkuCode: null,
      exportRelativePath: relPath,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType,
      ext: sanitizeExtension(item.ext),
      width: item.width,
      height: item.height
    });
  });

  // 4. Videos
  assetSets.sets.video.items.forEach((item, index) => {
    const stem = `${rules.naming.videoPrefix}_${String(index + 1).padStart(2, "0")}`;
    const relPath = allocateUniqueRelativePath(usedPaths, rules.folders.video, stem, item.ext);
    plannedAssets.push({
      kind: "video",
      position: index,
      assetId: item.assetId,
      assetName: item.assetName,
      assetVersionId: item.assetVersionId,
      versionNo: item.versionNo,
      originalFilename: item.originalFilename,
      listingSkuId: null,
      skuId: null,
      listingSkuCode: null,
      exportRelativePath: relPath,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType,
      ext: sanitizeExtension(item.ext),
      width: item.width,
      height: item.height
    });
  });

  const releaseId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    const nextNoRow = db.raw
      .prepare("SELECT COALESCE(MAX(release_no), 0) + 1 AS next_no FROM releases WHERE listing_id = ?")
      .get(listingId) as { next_no: number };
    const releaseNo = Number(nextNoRow.next_no);
    const releaseCode = `R${String(releaseNo).padStart(3, "0")}`;

    // Freeze PDP into an immutable pdp_versions record (reuse if latest matches identically)
    const pdpContentJson = JSON.stringify(pdp.draft.content);
    const latestPdpRow = db.raw
      .prepare(
        `SELECT id, language, content_json
         FROM pdp_versions
         WHERE listing_id = ?
         ORDER BY version_no DESC
         LIMIT 1`
      )
      .get(listingId) as { id: string; language: string; content_json: string } | undefined;

    let pdpVersionId: string;
    if (
      latestPdpRow &&
      latestPdpRow.language === pdp.draft.language &&
      latestPdpRow.content_json === pdpContentJson
    ) {
      pdpVersionId = latestPdpRow.id;
    } else {
      const nextPdpNoRow = db.raw
        .prepare(
          "SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no FROM pdp_versions WHERE listing_id = ?"
        )
        .get(listingId) as { next_no: number };
      pdpVersionId = crypto.randomUUID();
      db.raw
        .prepare(
          `INSERT INTO pdp_versions (id, listing_id, language, version_no, content_json, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          pdpVersionId,
          listingId,
          pdp.draft.language,
          Number(nextPdpNoRow.next_no),
          pdpContentJson,
          `${releaseCode} ${isDraftPackage ? "草稿包" : "正式发布"}自动冻结`,
          now
        );
      db.raw
        .prepare(
          "UPDATE listing_pdp_drafts SET based_on_version_id = ?, updated_at = ? WHERE listing_id = ?"
        )
        .run(pdpVersionId, now, listingId);
    }

    const snapshot: ReleaseSnapshotData = {
      snapshotFormatVersion: 1,
      listing: {
        id: listing.id,
        productId: listing.productId,
        productSpu: listing.productSpu,
        productNameZh: listing.productNameZh,
        productNameEn: listing.productNameEn,
        storeId: listing.storeId,
        storeName: listing.storeName,
        platform: listing.platform,
        market: listing.market,
        displayName: listing.displayName,
        language: listing.language,
        externalId: listing.externalId,
        externalUrl: listing.externalUrl,
        notes: listing.notes
      },
      skus: listing.skus.map((sku) => ({
        listingSkuId: sku.id,
        skuId: sku.skuId,
        skuCode: sku.skuCode,
        skuName: sku.skuName,
        channelCode: sku.channelCode,
        displayName: sku.displayName,
        position: sku.position
      })),
      template: {
        id: template.id,
        name: template.name,
        platform: template.platform,
        market: template.market,
        version: template.version,
        rules: template.rules
      },
      pdp: {
        versionId: pdpVersionId,
        language: pdp.draft.language,
        content: pdp.draft.content
      },
      assets: plannedAssets
    };

    db.raw
      .prepare(
        `INSERT INTO releases (
           id, listing_id, release_no, release_code, is_draft_package,
           template_id, template_version, pdp_version_id,
           validation_summary_json, immutable_snapshot_json, note, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        releaseId,
        listingId,
        releaseNo,
        releaseCode,
        isDraftPackage ? 1 : 0,
        template.id,
        template.version,
        pdpVersionId,
        JSON.stringify(validation),
        JSON.stringify(snapshot),
        note,
        now
      );

    const insertReleaseAsset = db.raw.prepare(
      `INSERT INTO release_assets (
         id, release_id, asset_version_id, kind, listing_sku_code,
         position, export_relative_path, sha256, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const asset of plannedAssets) {
      insertReleaseAsset.run(
        crypto.randomUUID(),
        releaseId,
        asset.assetVersionId,
        asset.kind,
        asset.listingSkuCode,
        asset.position,
        asset.exportRelativePath,
        asset.sha256,
        asset.sizeBytes
      );
    }

    recordActivity(db, {
      actorUserId,
      action: isDraftPackage ? "release.create_draft_package" : "release.create_formal",
      objectType: "release",
      objectId: releaseId,
      details: {
        listingId,
        releaseCode,
        isDraftPackage,
        templateId: template.id,
        templateVersion: template.version,
        assetCount: plannedAssets.length,
        blockerCount: validation.blockers.length,
        warningCount: validation.warnings.length
      }
    });
  });

  return getReleaseDetail(db, releaseId);
}

export function listListingReleases(db: AppDatabase, listingId: string): ReleaseSummary[] {
  const exists = db.raw
    .prepare("SELECT id FROM listings WHERE id = ?")
    .get(listingId) as { id: string } | undefined;
  if (!exists) {
    throw new AppError(404, "NOT_FOUND", "上架链接不存在");
  }

  const rows = db.raw
    .prepare(
      `SELECT
         r.id, r.listing_id, r.release_no, r.release_code, r.is_draft_package,
         r.template_id, et.name AS template_name, r.template_version,
         r.pdp_version_id, r.validation_summary_json, r.immutable_snapshot_json,
         r.note, r.created_at,
         (SELECT COUNT(*) FROM release_assets ra WHERE ra.release_id = r.id) AS asset_count
       FROM releases r
       JOIN export_templates et ON et.id = r.template_id
       WHERE r.listing_id = ?
       ORDER BY r.release_no DESC`
    )
    .all(listingId) as unknown as ReleaseRow[];

  return rows.map((row) => mapReleaseSummary(db, row));
}

export function getReleaseDetail(db: AppDatabase, releaseId: string): ReleaseDetail {
  const row = db.raw
    .prepare(
      `SELECT
         r.id, r.listing_id, r.release_no, r.release_code, r.is_draft_package,
         r.template_id, et.name AS template_name, r.template_version,
         r.pdp_version_id, r.validation_summary_json, r.immutable_snapshot_json,
         r.note, r.created_at,
         (SELECT COUNT(*) FROM release_assets ra WHERE ra.release_id = r.id) AS asset_count
       FROM releases r
       JOIN export_templates et ON et.id = r.template_id
       WHERE r.id = ?`
    )
    .get(releaseId) as ReleaseRow | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "指定的 Release 快照不存在");
  }

  const summary = mapReleaseSummary(db, row);
  const assetRows = db.raw
    .prepare(
      `SELECT
         ra.id, ra.release_id, ra.asset_version_id, ra.kind, ra.listing_sku_code,
         ra.position, ra.export_relative_path, ra.sha256, ra.size_bytes,
         av.original_filename, av.version_no, f.storage_id
       FROM release_assets ra
       JOIN asset_versions av ON av.id = ra.asset_version_id
       JOIN files f ON f.id = av.file_id
       WHERE ra.release_id = ?
       ORDER BY
         CASE ra.kind
           WHEN 'carousel' THEN 1
           WHEN 'sku' THEN 2
           WHEN 'detail' THEN 3
           WHEN 'video' THEN 4
           ELSE 5
         END ASC,
         ra.position ASC`
    )
    .all(releaseId) as Array<{
    id: string;
    release_id: string;
    asset_version_id: string;
    kind: AssetSetKind;
    listing_sku_code: string | null;
    position: number;
    export_relative_path: string;
    sha256: string;
    size_bytes: number;
    original_filename: string;
    version_no: number;
    storage_id: string;
  }>;

  const assets: ReleaseAssetRecord[] = assetRows.map((a) => ({
    id: a.id,
    releaseId: a.release_id,
    assetVersionId: a.asset_version_id,
    kind: a.kind,
    listingSkuCode: a.listing_sku_code,
    position: Number(a.position),
    exportRelativePath: a.export_relative_path,
    sha256: a.sha256,
    sizeBytes: Number(a.size_bytes),
    originalFilename: a.original_filename,
    versionNo: Number(a.version_no),
    storageId: a.storage_id
  }));

  return {
    ...summary,
    validationSummary: JSON.parse(row.validation_summary_json) as ListingValidationResult,
    snapshot: JSON.parse(row.immutable_snapshot_json) as Record<string, unknown>,
    assets,
    exports: loadExportsForRelease(db, releaseId)
  };
}

export interface RestoreReleaseDraftInput {
  displayName?: string;
  storeId?: string;
}

export function restoreReleaseToNewDraft(
  db: AppDatabase,
  actorUserId: string,
  releaseId: string,
  input: RestoreReleaseDraftInput = {}
): ListingDetail {
  const detail = getReleaseDetail(db, releaseId);
  const snapshot = detail.snapshot as unknown as ReleaseSnapshotData;

  const productExists = db.raw
    .prepare("SELECT id FROM products WHERE id = ? AND deleted_at IS NULL")
    .get(snapshot.listing.productId) as { id: string } | undefined;
  if (!productExists) {
    throw new AppError(409, "CONFLICT", "该 Release 关联的商品已不在活跃状态，请先从回收站恢复商品");
  }

  const targetStoreId = input.storeId?.trim() || snapshot.listing.storeId;
  const storeRow = db.raw
    .prepare("SELECT id, default_language FROM stores WHERE id = ?")
    .get(targetStoreId) as { id: string; default_language: string } | undefined;
  if (!storeRow) {
    throw new AppError(404, "NOT_FOUND", "目标店铺不存在");
  }

  const newListingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const newDisplayName =
    input.displayName?.trim() ||
    `${snapshot.listing.displayName} (由 ${detail.releaseCode} 恢复草稿)`;

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
        snapshot.listing.productId,
        targetStoreId,
        newDisplayName,
        snapshot.listing.language || storeRow.default_language,
        `从历史 Release ${detail.releaseCode} (${detail.id}) 恢复的独立草稿`,
        now,
        now
      );

    // Restore SKUs that still exist on the product
    const existingSkus = new Set(
      (
        db.raw
          .prepare("SELECT id FROM skus WHERE product_id = ?")
          .all(snapshot.listing.productId) as Array<{ id: string }>
      ).map((r) => r.id)
    );

    const oldToNewListingSkuId = new Map<string, string>();
    const skuCodeToNewListingSkuId = new Map<string, string>();
    const insertSku = db.raw.prepare(
      `INSERT INTO listing_skus (id, listing_id, sku_id, channel_code, display_name, position)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    snapshot.skus.forEach((sku, idx) => {
      if (!existingSkus.has(sku.skuId)) return;
      const newLskuId = crypto.randomUUID();
      insertSku.run(
        newLskuId,
        newListingId,
        sku.skuId,
        sku.channelCode,
        sku.displayName,
        idx
      );
      oldToNewListingSkuId.set(sku.listingSkuId, newLskuId);
      if (sku.channelCode) skuCodeToNewListingSkuId.set(sku.channelCode, newLskuId);
      if (sku.skuCode) skuCodeToNewListingSkuId.set(sku.skuCode, newLskuId);
    });

    const setMap = ensureListingAssetSetsInTx(db, newListingId, now);
    const insertSetItem = db.raw.prepare(
      `INSERT INTO asset_set_items (id, set_id, asset_version_id, listing_sku_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const versionExistsStmt = db.raw.prepare("SELECT id FROM asset_versions WHERE id = ?");
    const posByKind: Record<AssetSetKind, number> = {
      carousel: 0,
      detail: 0,
      sku: 0,
      video: 0
    };

    for (const asset of snapshot.assets) {
      if (!versionExistsStmt.get(asset.assetVersionId)) continue;
      let mappedListingSkuId: string | null = null;
      if (asset.kind === "sku") {
        mappedListingSkuId =
          (asset.listingSkuId ? oldToNewListingSkuId.get(asset.listingSkuId) : undefined) ??
          (asset.listingSkuCode ? skuCodeToNewListingSkuId.get(asset.listingSkuCode) : undefined) ??
          null;
        if (!mappedListingSkuId) continue;
      }
      const pos = posByKind[asset.kind];
      posByKind[asset.kind] = pos + 1;
      insertSetItem.run(
        crypto.randomUUID(),
        setMap[asset.kind],
        asset.assetVersionId,
        mappedListingSkuId,
        pos,
        now
      );
    }

    // Restore PDP draft from frozen pdp_version / snapshot
    let pdpLanguage = snapshot.pdp.language || snapshot.listing.language;
    let pdpContent = snapshot.pdp.content;
    if (detail.pdpVersionId) {
      const pdpRow = db.raw
        .prepare("SELECT language, content_json FROM pdp_versions WHERE id = ?")
        .get(detail.pdpVersionId) as { language: string; content_json: string } | undefined;
      if (pdpRow) {
        pdpLanguage = pdpRow.language;
        pdpContent = parsePdpContentJson(pdpRow.content_json);
      }
    }

    db.raw
      .prepare(
        `INSERT INTO listing_pdp_drafts
           (listing_id, language, content_json, revision, based_on_version_id, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)`
      )
      .run(newListingId, pdpLanguage, JSON.stringify(pdpContent), now);

    rebuildListingSearchDocument(db, newListingId);
    recordActivity(db, {
      actorUserId,
      action: "release.restore_draft",
      objectType: "listing",
      objectId: newListingId,
      details: {
        sourceReleaseId: detail.id,
        sourceReleaseCode: detail.releaseCode,
        sourceListingId: detail.listingId
      }
    });
  });

  return getListingDetail(db, newListingId);
}
