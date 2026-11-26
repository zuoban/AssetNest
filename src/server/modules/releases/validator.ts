import type {
  AssetSetItemRecord,
  ExportTemplateRecord,
  ListingValidationResult,
  PdpContent,
  PdpRequiredField,
  ValidationIssue
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { getListingAssetSets } from "../listings/asset-sets.js";
import { getListingPdp } from "../listings/pdp.js";
import { getListingDetail } from "../listings/service.js";
import { resolveTemplateForListing } from "./templates.js";

interface VersionFileInfo {
  asset_version_id: string;
  file_id: string;
  storage_id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  ext: string;
  state: string;
  storage_enabled: number;
  storage_status: string;
}

function parseAspectRatio(ratioStr: string): number | null {
  const trimmed = ratioStr.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return w / h;
}

function isPdpFieldPopulated(content: PdpContent, field: PdpRequiredField): boolean {
  switch (field) {
    case "title":
      return content.title.trim().length > 0;
    case "shortDescription":
      return content.shortDescription.trim().length > 0;
    case "bullets":
      return content.bullets.some((item) => item.trim().length > 0);
    case "description":
      return content.fullDescription.trim().length > 0 || content.shortDescription.trim().length > 0;
    case "specs":
      return content.specs.some((row) => row.specKey.trim().length > 0 && row.specValue.trim().length > 0);
    case "packageList":
      return content.packageList.trim().length > 0;
    case "usageInstructions":
      return content.usageInstructions.trim().length > 0;
  }
}

const PDP_FIELD_LABELS: Record<PdpRequiredField, string> = {
  title: "商品标题",
  shortDescription: "短描述",
  bullets: "核心卖点",
  description: "完整描述",
  specs: "规格参数表",
  packageList: "包装清单",
  usageInstructions: "使用说明"
};

export interface ValidatedListingContext {
  validation: ListingValidationResult;
  template: ExportTemplateRecord;
  listing: ReturnType<typeof getListingDetail>;
  assetSets: ReturnType<typeof getListingAssetSets>;
  pdp: ReturnType<typeof getListingPdp>;
}

export async function validateListingForRelease(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  listingId: string,
  templateId?: string
): Promise<ValidatedListingContext> {
  const listing = getListingDetail(db, listingId);
  const template = resolveTemplateForListing(db, listing.platform, listing.market, templateId);
  const assetSets = getListingAssetSets(db, listingId);
  const pdp = getListingPdp(db, listingId);
  const rules = template.rules;

  const blockers: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const allItems: AssetSetItemRecord[] = [
    ...assetSets.sets.carousel.items,
    ...assetSets.sets.sku.items,
    ...assetSets.sets.detail.items,
    ...assetSets.sets.video.items
  ];

  // Load physical file info for every unique referenced asset_version_id
  const versionFileMap = new Map<string, VersionFileInfo>();
  const uniqueVersionIds = Array.from(new Set(allItems.map((item) => item.assetVersionId)));
  if (uniqueVersionIds.length > 0) {
    const placeholders = uniqueVersionIds.map(() => "?").join(", ");
    const rows = db.raw
      .prepare(
        `SELECT
           av.id AS asset_version_id,
           f.id AS file_id,
           f.storage_id,
           f.object_key,
           f.sha256,
           f.size_bytes,
           f.ext,
           f.state,
           sp.enabled AS storage_enabled,
           sp.status AS storage_status
         FROM asset_versions av
         JOIN files f ON f.id = av.file_id
         JOIN storage_providers sp ON sp.id = f.storage_id
         WHERE av.id IN (${placeholders})`
      )
      .all(...uniqueVersionIds) as unknown as VersionFileInfo[];
    for (const row of rows) {
      versionFileMap.set(row.asset_version_id, row);
    }
  }

  // Cache physical stat checks per (storageId, objectKey)
  const objectCheckCache = new Map<
    string,
    { ok: boolean; code?: string; message?: string }
  >();

  async function verifyPhysicalObject(fileInfo: VersionFileInfo): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
  }> {
    const cacheKey = `${fileInfo.storage_id}::${fileInfo.object_key}`;
    const cached = objectCheckCache.get(cacheKey);
    if (cached) return cached;

    if (fileInfo.state !== "ready") {
      const res = {
        ok: false,
        code: "FILE_NOT_READY",
        message: `底层物理文件状态异常（${fileInfo.state}）`
      };
      objectCheckCache.set(cacheKey, res);
      return res;
    }

    const provider = storageRegistry.get(fileInfo.storage_id);
    if (!provider || fileInfo.storage_enabled !== 1) {
      const res = {
        ok: false,
        code: "STORAGE_OFFLINE",
        message: `所在存储空间 "${fileInfo.storage_id}" 当前离线或未启用`
      };
      objectCheckCache.set(cacheKey, res);
      return res;
    }

    try {
      const stat = await provider.stat(fileInfo.object_key);
      if (stat.size !== Number(fileInfo.size_bytes)) {
        const res = {
          ok: false,
          code: "FILE_SIZE_MISMATCH",
          message: `存储空间 "${fileInfo.storage_id}" 中的文件大小与记录不一致`
        };
        objectCheckCache.set(cacheKey, res);
        return res;
      }
      const res = { ok: true };
      objectCheckCache.set(cacheKey, res);
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const res = {
        ok: false,
        code: "STORAGE_READ_FAILED",
        message: `无法从存储空间 "${fileInfo.storage_id}" 读取文件：${msg}`
      };
      objectCheckCache.set(cacheKey, res);
      return res;
    }
  }

  const inspectSetItem = async (
    item: AssetSetItemRecord,
    opts: {
      allowedExts: string[];
      maxFileSizeMB: number;
      minWidth?: number;
      minHeight?: number;
      aspectRatio?: string;
      aspectTolerance?: number;
    }
  ) => {
    const label = `${item.assetName} (v${item.versionNo})`;

    if (item.assetDeleted) {
      blockers.push({
        severity: "blocker",
        code: "ASSET_DELETED",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」已被移入回收站，请恢复或替换后再发布`
      });
    }

    const fileInfo = versionFileMap.get(item.assetVersionId);
    if (!fileInfo) {
      blockers.push({
        severity: "blocker",
        code: "FILE_MISSING",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」缺少底层物理文件记录`
      });
    } else {
      const check = await verifyPhysicalObject(fileInfo);
      if (!check.ok) {
        blockers.push({
          severity: "blocker",
          code: check.code ?? "STORAGE_READ_FAILED",
          targetKind: "storage",
          targetId: item.assetVersionId,
          message: `素材「${label}」不可读取：${check.message}`
        });
      }
    }

    if (item.reviewStatus === "rejected") {
      blockers.push({
        severity: "blocker",
        code: "REVIEW_REJECTED",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」审核状态为「已拒绝」，禁止用于正式上架包`
      });
    } else if (item.reviewStatus === "pending") {
      if (rules.review.requireApprovedForFormal) {
        blockers.push({
          severity: "blocker",
          code: "REVIEW_PENDING",
          targetKind: item.kind,
          targetId: item.assetVersionId,
          message: `素材「${label}」尚未通过审核（当前待审核），模板要求正式发布前必须全部审核通过`
        });
      } else {
        warnings.push({
          severity: "warning",
          code: "REVIEW_PENDING_WARNING",
          targetKind: item.kind,
          targetId: item.assetVersionId,
          message: `素材「${label}」目前为待审核状态`
        });
      }
    }

    const normalizedExt = item.ext.replace(/^\.+/, "").toLowerCase();
    if (opts.allowedExts.length > 0 && !opts.allowedExts.includes(normalizedExt)) {
      blockers.push({
        severity: "blocker",
        code: "DISALLOWED_EXTENSION",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」格式 .${normalizedExt || "unknown"} 不在模板允许列表（${opts.allowedExts.join(", ")}）内`
      });
    }

    const maxBytes = opts.maxFileSizeMB * 1024 * 1024;
    if (item.sizeBytes > maxBytes) {
      blockers.push({
        severity: "blocker",
        code: "FILE_TOO_LARGE",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」体积 ${(item.sizeBytes / (1024 * 1024)).toFixed(2)} MB 超出模板上限 ${opts.maxFileSizeMB} MB`
      });
    }

    if (
      (opts.minWidth && opts.minWidth > 0) ||
      (opts.minHeight && opts.minHeight > 0)
    ) {
      if (item.width && item.height) {
        if (
          (opts.minWidth && item.width < opts.minWidth) ||
          (opts.minHeight && item.height < opts.minHeight)
        ) {
          warnings.push({
            severity: "warning",
            code: "RESOLUTION_BELOW_MIN",
            targetKind: item.kind,
            targetId: item.assetVersionId,
            message: `素材「${label}」分辨率 ${item.width}×${item.height} 低于模板建议最小尺寸 ${opts.minWidth ?? 0}×${opts.minHeight ?? 0}`
          });
        }
      }
    }

    if (opts.aspectRatio && item.width && item.height) {
      const expectedRatio = parseAspectRatio(opts.aspectRatio);
      if (expectedRatio) {
        const actualRatio = item.width / item.height;
        const tolerance = opts.aspectTolerance ?? 0.05;
        const diff = Math.abs(actualRatio - expectedRatio) / expectedRatio;
        if (diff > tolerance) {
          warnings.push({
            severity: "warning",
            code: "ASPECT_RATIO_MISMATCH",
            targetKind: item.kind,
            targetId: item.assetVersionId,
            message: `素材「${label}」宽高比 (${item.width}×${item.height}) 超出模板目标 ${opts.aspectRatio}（±${Math.round(tolerance * 100)}%）范围`
          });
        }
      }
    }

    if (item.hasNewerVersion) {
      warnings.push({
        severity: "warning",
        code: "NEWER_VERSION_AVAILABLE",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」存在更新版本 v${item.latestVersionNo}（系统不会自动替换，可按需手动升级）`
      });
    }

    if (item.isDuplicateAsset || item.isDuplicateVersion) {
      warnings.push({
        severity: "warning",
        code: "DUPLICATE_ASSET",
        targetKind: item.kind,
        targetId: item.assetVersionId,
        message: `素材「${label}」在当前 ${item.kind} 集合中存在重复引用`
      });
    }
  };

  // 1. Carousel checks
  const carouselItems = assetSets.sets.carousel.items;
  if (carouselItems.length < rules.carousel.minCount) {
    blockers.push({
      severity: "blocker",
      code: "CAROUSEL_COUNT_TOO_LOW",
      targetKind: "carousel",
      message: `轮播图数量不足：当前 ${carouselItems.length} 张，模板要求至少 ${rules.carousel.minCount} 张`
    });
  } else if (carouselItems.length < rules.carousel.targetCount) {
    warnings.push({
      severity: "warning",
      code: "CAROUSEL_BELOW_TARGET",
      targetKind: "carousel",
      message: `轮播图当前 ${carouselItems.length} 张，低于模板推荐数量 ${rules.carousel.targetCount} 张`
    });
  }
  if (carouselItems.length > rules.carousel.maxCount) {
    blockers.push({
      severity: "blocker",
      code: "CAROUSEL_COUNT_TOO_HIGH",
      targetKind: "carousel",
      message: `轮播图数量超限：当前 ${carouselItems.length} 张，模板最多允许 ${rules.carousel.maxCount} 张`
    });
  }
  for (const item of carouselItems) {
    await inspectSetItem(item, {
      allowedExts: rules.carousel.allowedExts,
      maxFileSizeMB: rules.carousel.maxFileSizeMB,
      minWidth: rules.carousel.minWidth,
      minHeight: rules.carousel.minHeight,
      aspectRatio: rules.carousel.aspectRatio,
      aspectTolerance: rules.carousel.aspectTolerance
    });
  }

  // 2. Detail checks
  const detailItems = assetSets.sets.detail.items;
  if (detailItems.length < rules.detail.minCount) {
    blockers.push({
      severity: "blocker",
      code: "DETAIL_COUNT_TOO_LOW",
      targetKind: "detail",
      message: `详情图数量不足：当前 ${detailItems.length} 张，模板要求至少 ${rules.detail.minCount} 张`
    });
  }
  if (detailItems.length > rules.detail.maxCount) {
    blockers.push({
      severity: "blocker",
      code: "DETAIL_COUNT_TOO_HIGH",
      targetKind: "detail",
      message: `详情图数量超限：当前 ${detailItems.length} 张，模板最多允许 ${rules.detail.maxCount} 张`
    });
  }
  for (const item of detailItems) {
    await inspectSetItem(item, {
      allowedExts: rules.detail.allowedExts,
      maxFileSizeMB: rules.detail.maxFileSizeMB,
      minWidth: rules.detail.minWidth,
      minHeight: rules.detail.minHeight,
      aspectRatio: rules.detail.aspectRatio,
      aspectTolerance: rules.detail.aspectTolerance
    });
  }

  // 3. SKU image checks
  const skuItems = assetSets.sets.sku.items;
  const boundSkuIds = new Set(
    skuItems.map((item) => item.listingSkuId).filter((id): id is string => Boolean(id))
  );
  if (rules.sku.required) {
    if (listing.skus.length === 0) {
      warnings.push({
        severity: "warning",
        code: "NO_LISTING_SKUS",
        targetKind: "sku",
        message: "当前上架链接尚未绑定任何 SKU"
      });
    } else {
      for (const lsku of listing.skus) {
        if (!boundSkuIds.has(lsku.id)) {
          blockers.push({
            severity: "blocker",
            code: "SKU_IMAGE_MISSING",
            targetKind: "sku",
            targetId: lsku.id,
            message: `SKU「${lsku.channelCode || lsku.skuCode}」缺少绑定的 SKU 图`
          });
        }
      }
    }
  }
  for (const item of skuItems) {
    await inspectSetItem(item, {
      allowedExts: rules.sku.allowedExts,
      maxFileSizeMB: rules.sku.maxFileSizeMB,
      minWidth: rules.sku.minWidth,
      minHeight: rules.sku.minHeight
    });
  }

  // 4. Video checks
  const videoItems = assetSets.sets.video.items;
  if (videoItems.length > rules.video.maxCount) {
    blockers.push({
      severity: "blocker",
      code: "VIDEO_COUNT_TOO_HIGH",
      targetKind: "video",
      message: `视频数量超限：当前 ${videoItems.length} 个，模板最多允许 ${rules.video.maxCount} 个`
    });
  }
  for (const item of videoItems) {
    await inspectSetItem(item, {
      allowedExts: rules.video.allowedExts,
      maxFileSizeMB: rules.video.maxFileSizeMB
    });
  }

  // 5. PDP checks
  for (const field of rules.pdp.requiredFields) {
    if (!isPdpFieldPopulated(pdp.draft.content, field)) {
      blockers.push({
        severity: "blocker",
        code: "PDP_REQUIRED_FIELD_MISSING",
        targetKind: "pdp",
        targetId: field,
        message: `PDP 文案缺少必填字段「${PDP_FIELD_LABELS[field]}」`
      });
    }
  }

  if (pdp.draft.titleCodePoints > rules.pdp.maxTitleCodePoints) {
    warnings.push({
      severity: "warning",
      code: "PDP_TITLE_TOO_LONG",
      targetKind: "pdp",
      message: `PDP 标题当前 ${pdp.draft.titleCodePoints} 个 Unicode 字符，超过模板建议上限 ${rules.pdp.maxTitleCodePoints}`
    });
  }

  if (pdp.specDiff.length > 0) {
    warnings.push({
      severity: "warning",
      code: "PDP_SPEC_DIFF",
      targetKind: "pdp",
      message: `PDP 规格表与商品公共规格存在 ${pdp.specDiff.length} 处差异，发布前建议核对`
    });
  }

  const validation: ListingValidationResult = {
    listingId: listing.id,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    canCreateFormalRelease: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    blockers,
    warnings,
    stats: {
      carouselCount: carouselItems.length,
      detailCount: detailItems.length,
      skuTotalCount: listing.skus.length,
      skuBoundCount: listing.skus.filter((s) => boundSkuIds.has(s.id)).length,
      videoCount: videoItems.length,
      titleCodePoints: pdp.draft.titleCodePoints
    }
  };

  return { validation, template, listing, assetSets, pdp };
}
