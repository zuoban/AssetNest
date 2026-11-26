import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import type { ExportRecord, PdpContent } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { getCurrentSchemaVersion } from "../../db/migrator.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { enqueueJob } from "../jobs/service.js";
import type { JobContext, JobWorker } from "../jobs/worker.js";
import { parsePdpContentJson } from "../listings/pdp.js";
import { recordActivity } from "../system/activity.js";
import { getAppSettings } from "../system/service.js";
import {
  getReleaseDetail,
  mapExportRow,
  sanitizeExtension,
  sanitizePathSegment,
  type ReleaseSnapshotData
} from "./service.js";

function getExportsDir(config: ResolvedAppConfig): string {
  return path.resolve(config.app.dataDir, "exports");
}

export function resolveExportZipPath(config: ResolvedAppConfig, relativeName: string): string {
  const root = getExportsDir(config);
  const resolved = path.resolve(root, relativeName);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError(400, "PATH_TRAVERSAL", "导出文件路径越界");
  }
  return resolved;
}

function buildPdpDescriptionText(content: PdpContent): string {
  const sections: string[] = [];
  if (content.shortDescription.trim()) {
    sections.push(content.shortDescription.trim());
  }
  const bullets = content.bullets.map((b) => b.trim()).filter(Boolean);
  if (bullets.length > 0) {
    sections.push(bullets.map((b) => `- ${b}`).join("\n"));
  }
  if (content.fullDescription.trim()) {
    sections.push(content.fullDescription.trim());
  }
  if (content.packageList.trim()) {
    sections.push(`Package List:\n${content.packageList.trim()}`);
  }
  if (content.usageInstructions.trim()) {
    sections.push(`Usage Instructions:\n${content.usageInstructions.trim()}`);
  }
  return sections.join("\n\n") + (sections.length > 0 ? "\n" : "");
}

export function enqueueReleaseExport(
  db: AppDatabase,
  worker: JobWorker,
  actorUserId: string,
  releaseId: string
): { exportRecord: ExportRecord; job: ReturnType<typeof enqueueJob> } {
  const detail = getReleaseDetail(db, releaseId);
  const snapshot = detail.snapshot as unknown as ReleaseSnapshotData;

  const spuPart = sanitizePathSegment(snapshot.listing.productSpu, "SPU");
  const marketPart = sanitizePathSegment(snapshot.listing.market, "MKT");
  const platformPart = sanitizePathSegment(snapshot.listing.platform, "PLT");
  const storePart = sanitizePathSegment(snapshot.listing.storeName, "Store");
  const draftSuffix = detail.isDraftPackage ? "_DRAFT" : "";
  const fileName = `${spuPart}_${marketPart}_${platformPart}_${storePart}_${detail.releaseCode}${draftSuffix}.zip`;

  const exportId = crypto.randomUUID();
  const relPath = `${exportId}.zip`;
  const now = new Date().toISOString();

  const result = db.transaction(() => {
    const job = enqueueJob(db, {
      type: "export_zip",
      payload: { exportId, releaseId },
      priority: 50,
      maxAttempts: 2,
      progressStage: "queued"
    });

    db.raw
      .prepare(
        `INSERT INTO exports (
           id, release_id, job_id, status, file_path, file_name,
           size_bytes, expires_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(exportId, releaseId, job.id, relPath, fileName, now, now);

    recordActivity(db, {
      actorUserId,
      action: "release.export_zip_enqueue",
      objectType: "export",
      objectId: exportId,
      details: {
        releaseId,
        releaseCode: detail.releaseCode,
        isDraftPackage: detail.isDraftPackage,
        fileName,
        jobId: job.id
      }
    });

    const exportRow = db.raw
      .prepare(
        `SELECT id, release_id, job_id, status, file_path, file_name, size_bytes,
                expires_at, last_error, created_at, updated_at
         FROM exports WHERE id = ?`
      )
      .get(exportId) as unknown as Parameters<typeof mapExportRow>[0];

    return { exportRecord: mapExportRow(exportRow), job };
  });

  worker.wake();
  return result;
}

export async function executeReleaseExportJob(
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry,
  payload: Record<string, unknown>,
  ctx: JobContext
): Promise<Record<string, unknown>> {
  const exportId = String(payload.exportId ?? "");
  const releaseId = String(payload.releaseId ?? "");
  if (!exportId || !releaseId) {
    throw new Error("缺少导出任务参数 exportId 或 releaseId");
  }

  const exportRow = db.raw
    .prepare("SELECT id, file_path, file_name FROM exports WHERE id = ?")
    .get(exportId) as { id: string; file_path: string; file_name: string } | undefined;
  if (!exportRow) {
    throw new Error(`导出记录 ${exportId} 不存在`);
  }

  const detail = getReleaseDetail(db, releaseId);
  const snapshot = detail.snapshot as unknown as ReleaseSnapshotData;
  const exportsDir = getExportsDir(config);
  await fsp.mkdir(exportsDir, { recursive: true });

  const finalZipPath = resolveExportZipPath(config, exportRow.file_path);
  const tempZipPath = path.join(exportsDir, `.${exportId}-${crypto.randomUUID()}.zip.tmp`);

  const startNow = new Date().toISOString();
  db.raw
    .prepare("UPDATE exports SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(startNow, exportId);

  const totalItems = detail.assets.length + 2;
  ctx.updateProgress({ stage: "preparing_release_export", current: 0, total: totalItems });

  try {
    // Resolve current physical location for every release_asset (automatically follows storage migration)
    const fileLocStmt = db.raw.prepare(
      `SELECT f.id AS file_id, f.storage_id, f.object_key, f.sha256, f.size_bytes, f.state
       FROM asset_versions av
       JOIN files f ON f.id = av.file_id
       WHERE av.id = ?`
    );

    const resolvedEntries = detail.assets.map((asset) => {
      const loc = fileLocStmt.get(asset.assetVersionId) as
        | {
            file_id: string;
            storage_id: string;
            object_key: string;
            sha256: string;
            size_bytes: number;
            state: string;
          }
        | undefined;
      if (!loc || loc.state !== "ready") {
        throw new Error(
          `导出失败：Release 素材版本 ${asset.assetVersionId} 的底层物理文件不可用`
        );
      }
      const provider = storageRegistry.get(loc.storage_id);
      if (!provider) {
        throw new Error(
          `导出失败：素材 ${asset.exportRelativePath} 所在存储空间 "${loc.storage_id}" 当前离线或未配置`
        );
      }
      return { asset, loc, provider };
    });

    const zipFile = new yazl.ZipFile();
    const zipOutput = zipFile.outputStream as Readable;
    let completedCount = 0;
    const lazyStreams: Readable[] = [];
    const abortZip = (err: Error) => {
      if (!zipOutput.destroyed) {
        zipOutput.destroy(err);
      }
      for (const stream of lazyStreams) {
        if (!stream.destroyed) {
          stream.destroy();
        }
      }
    };
    zipFile.on("error", abortZip);

    // Lazy sequential streaming: each generator only starts reading when yazl pulls it,
    // keeping memory constant regardless of total media volume.
    for (const entry of resolvedEntries) {
      const { asset, loc, provider } = entry;
      const expectedSha = asset.sha256;
      const expectedSize = asset.sizeBytes;

      const lazyStream = Readable.from(
        (async function* () {
          ctx.throwIfCancelled();
          const readRes = await provider.get(loc.object_key, { signal: ctx.signal });
          const hash = crypto.createHash("sha256");
          let actualBytes = 0;

          for await (const chunk of readRes.stream) {
            ctx.throwIfCancelled();
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            actualBytes += buf.length;
            hash.update(buf);
            yield buf;
          }

          const actualSha = hash.digest("hex");
          if (actualBytes !== expectedSize || actualSha !== expectedSha) {
            throw new Error(
              `导出完整性校验失败（${asset.exportRelativePath}: expected sha=${expectedSha} size=${expectedSize}, actual sha=${actualSha} size=${actualBytes}）`
            );
          }

          completedCount += 1;
          ctx.updateProgress({
            stage: "streaming_assets",
            current: completedCount,
            total: totalItems
          });
        })()
      );
      lazyStreams.push(lazyStream);
      lazyStream.on("error", abortZip);

      // Store compressed=false for already-compressed media (jpg/png/webp/mp4) for speed & low CPU
      zipFile.addReadStream(lazyStream, asset.exportRelativePath, { compress: false });
    }

    // PDP files (UTF-8)
    const pdpFolder = sanitizePathSegment(snapshot.template.rules.folders.pdp, "05_PDP");
    let pdpLanguage = snapshot.pdp.language;
    let pdpContent = snapshot.pdp.content;
    if (detail.pdpVersionId) {
      const frozenPdp = db.raw
        .prepare("SELECT language, content_json FROM pdp_versions WHERE id = ?")
        .get(detail.pdpVersionId) as { language: string; content_json: string } | undefined;
      if (frozenPdp) {
        pdpLanguage = frozenPdp.language;
        pdpContent = parsePdpContentJson(frozenPdp.content_json);
      }
    }

    const titleText = `${pdpContent.title}\n`;
    const descText = buildPdpDescriptionText(pdpContent);
    const specsJson = JSON.stringify(pdpContent.specs, null, 2) + "\n";
    const pdpFullJson = JSON.stringify(
      {
        versionId: detail.pdpVersionId,
        language: pdpLanguage,
        content: pdpContent
      },
      null,
      2
    ) + "\n";

    const pdpFiles = [
      { path: `${pdpFolder}/Title.txt`, buf: Buffer.from(titleText, "utf8") },
      { path: `${pdpFolder}/Description.txt`, buf: Buffer.from(descText, "utf8") },
      { path: `${pdpFolder}/Specifications.json`, buf: Buffer.from(specsJson, "utf8") },
      { path: `${pdpFolder}/PDP_Full.json`, buf: Buffer.from(pdpFullJson, "utf8") }
    ];

    for (const pf of pdpFiles) {
      zipFile.addBuffer(pf.buf, pf.path);
    }

    if (detail.isDraftPackage) {
      const draftNotice = [
        "DRAFT PACKAGE NOTICE / 草稿导出包提示",
        "========================================",
        `Release Code: ${detail.releaseCode}`,
        `Release ID: ${detail.id}`,
        "This package was explicitly exported as an unapproved DRAFT package.",
        "本压缩包为明确标注的草稿导出包，不得作为已审核正式上架包使用。",
        `Blockers at creation: ${detail.blockerCount}`,
        `Warnings at creation: ${detail.warningCount}`,
        ""
      ].join("\n");
      zipFile.addBuffer(Buffer.from(draftNotice, "utf8"), "DRAFT_NOTICE.txt");
    }

    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: getCurrentSchemaVersion(db),
      manifestFormatVersion: 1,
      releaseId: detail.id,
      releaseNo: detail.releaseNo,
      releaseCode: detail.releaseCode,
      isDraftPackage: detail.isDraftPackage,
      generatedAt,
      product: {
        id: snapshot.listing.productId,
        spu: snapshot.listing.productSpu,
        nameZh: snapshot.listing.productNameZh,
        nameEn: snapshot.listing.productNameEn
      },
      store: {
        id: snapshot.listing.storeId,
        name: snapshot.listing.storeName,
        platform: snapshot.listing.platform,
        market: snapshot.listing.market
      },
      listing: {
        id: snapshot.listing.id,
        displayName: snapshot.listing.displayName,
        language: pdpLanguage,
        externalId: snapshot.listing.externalId
      },
      template: {
        id: detail.templateId,
        name: detail.templateName,
        version: detail.templateVersion
      },
      pdp: {
        versionId: detail.pdpVersionId,
        language: pdpLanguage,
        files: pdpFiles.map((pf) => ({
          relativePath: pf.path,
          sha256: crypto.createHash("sha256").update(pf.buf).digest("hex"),
          sizeBytes: pf.buf.length
        }))
      },
      assets: detail.assets.map((asset) => ({
        relativePath: asset.exportRelativePath,
        kind: asset.kind,
        position: asset.position,
        assetVersionId: asset.assetVersionId,
        listingSkuCode: asset.listingSkuCode,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes
      }))
    };

    zipFile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"), "manifest.json");
    zipFile.end();

    const writer = fs.createWriteStream(tempZipPath);
    await pipeline(zipFile.outputStream, writer);

    const stat = await fsp.stat(tempZipPath);
    await fsp.rename(tempZipPath, finalZipPath);

    const settings = getAppSettings(db, config.app.timezone);
    const ttlHours = Math.max(1, settings.exportTtlHours || 72);
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    const finishNow = new Date().toISOString();

    db.raw
      .prepare(
        `UPDATE exports
         SET status = 'ready',
             size_bytes = ?,
             expires_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(stat.size, expiresAt, finishNow, exportId);

    ctx.updateProgress({ stage: "completed", current: totalItems, total: totalItems });

    return {
      exportId,
      releaseId,
      fileName: exportRow.file_name,
      sizeBytes: stat.size,
      expiresAt,
      assetCount: detail.assets.length
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failNow = new Date().toISOString();
    db.raw
      .prepare("UPDATE exports SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .run(message, failNow, exportId);
    await fsp.rm(tempZipPath, { force: true }).catch(() => {});
    throw err;
  }
}

export function getExportDownloadInfo(
  db: AppDatabase,
  config: ResolvedAppConfig,
  exportId: string
): { absPath: string; fileName: string; sizeBytes: number; record: ExportRecord } {
  const row = db.raw
    .prepare(
      `SELECT id, release_id, job_id, status, file_path, file_name, size_bytes,
              expires_at, last_error, created_at, updated_at
       FROM exports
       WHERE id = ?`
    )
    .get(exportId) as
    | {
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
    | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "指定的导出记录不存在");
  }

  const expiredByTime = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
  if (row.status === "expired" || (row.status === "ready" && expiredByTime)) {
    const now = new Date().toISOString();
    db.raw
      .prepare("UPDATE exports SET status = 'expired', updated_at = ? WHERE id = ?")
      .run(now, exportId);
    throw new AppError(409, "CONFLICT", "该导出包已过期，请从对应的历史 Release 重新生成 ZIP");
  }

  if (row.status !== "ready" || !row.file_path) {
    throw new AppError(409, "CONFLICT", `该导出包当前状态为 ${row.status}，暂不可下载`);
  }

  const absPath = resolveExportZipPath(config, row.file_path);
  if (!fs.existsSync(absPath)) {
    const now = new Date().toISOString();
    db.raw
      .prepare("UPDATE exports SET status = 'expired', updated_at = ? WHERE id = ?")
      .run(now, exportId);
    throw new AppError(409, "CONFLICT", "导出压缩包文件已清理或过期，请从历史 Release 重新生成");
  }

  const stat = fs.statSync(absPath);
  return {
    absPath,
    fileName: row.file_name,
    sizeBytes: stat.size,
    record: mapExportRow(row)
  };
}

export interface StandardExportOptions {
  productId?: string;
  assetIds?: string[];
  includeAllVersions?: boolean;
}

export function buildStandardOpenExportStream(
  db: AppDatabase,
  storageRegistry: StorageRegistry,
  options: StandardExportOptions = {}
): { stream: NodeJS.ReadableStream; fileName: string; fileCount: number } {
  const clauses: string[] = ["a.deleted_at IS NULL", "f.state = 'ready'"];
  const params: string[] = [];

  if (!options.includeAllVersions) {
    clauses.push("av.id = a.current_version_id");
  }
  if (options.assetIds && options.assetIds.length > 0) {
    const placeholders = options.assetIds.map(() => "?").join(", ");
    clauses.push(`a.id IN (${placeholders})`);
    params.push(...options.assetIds);
  }
  if (options.productId) {
    clauses.push(
      "EXISTS (SELECT 1 FROM product_assets pa WHERE pa.asset_id = a.id AND pa.product_id = ?)"
    );
    params.push(options.productId);
  }

  const rows = db.raw
    .prepare(
      `SELECT
         a.id AS asset_id,
         a.name AS asset_name,
         a.asset_type,
         a.purpose,
         a.source,
         a.notes,
         av.id AS asset_version_id,
         av.version_no,
         av.original_filename,
         av.review_status,
         av.created_at AS version_created_at,
         f.storage_id,
         f.object_key,
         f.sha256,
         f.size_bytes,
         f.mime_type,
         f.ext,
         f.width,
         f.height,
         (SELECT p.spu FROM product_assets pa JOIN products p ON p.id = pa.product_id WHERE pa.asset_id = a.id AND p.deleted_at IS NULL ORDER BY p.spu ASC LIMIT 1) AS primary_spu
       FROM assets a
       JOIN asset_versions av ON av.asset_id = a.id
       JOIN files f ON f.id = av.file_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY primary_spu ASC, a.name ASC, av.version_no ASC`
    )
    .all(...params) as Array<{
    asset_id: string;
    asset_name: string;
    asset_type: string;
    purpose: string;
    source: string;
    notes: string;
    asset_version_id: string;
    version_no: number;
    original_filename: string;
    review_status: string;
    version_created_at: string;
    storage_id: string;
    object_key: string;
    sha256: string;
    size_bytes: number;
    mime_type: string;
    ext: string;
    width: number | null;
    height: number | null;
    primary_spu: string | null;
  }>;

  if (rows.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "没有符合条件的可导出素材");
  }

  // Verify all required providers are available upfront
  const providers = rows.map((row) => {
    const provider = storageRegistry.get(row.storage_id);
    if (!provider) {
      throw new AppError(
        503,
        "STORAGE_OFFLINE",
        `素材「${row.asset_name}」所在存储空间 "${row.storage_id}" 当前离线，无法导出开放标准包`
      );
    }
    return provider;
  });

  const usedLower = new Set<string>();
  const manifestEntries: Array<Record<string, unknown>> = [];
  const zipFile = new yazl.ZipFile();
  const zipOutput = zipFile.outputStream as Readable;
  const lazyStreams: Readable[] = [];
  const abortZip = (err: Error) => {
    if (!zipOutput.destroyed) {
      zipOutput.destroy(err);
    }
    for (const stream of lazyStreams) {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
  };
  zipFile.on("error", abortZip);

  rows.forEach((row, idx) => {
    const provider = providers[idx]!;
    const baseFolder = row.primary_spu
      ? `products/${sanitizePathSegment(row.primary_spu, "SPU")}`
      : "unassigned";
    const safeName = sanitizePathSegment(row.asset_name, "asset");
    const safeExt = sanitizeExtension(row.ext);

    let relativePath = `${baseFolder}/${safeName}_v${row.version_no}.${safeExt}`;
    let counter = 2;
    while (usedLower.has(relativePath.toLowerCase())) {
      relativePath = `${baseFolder}/${safeName}_v${row.version_no}_${counter}.${safeExt}`;
      counter += 1;
    }
    usedLower.add(relativePath.toLowerCase());

    const lazyStream = Readable.from(
      (async function* () {
        const readRes = await provider.get(row.object_key);
        for await (const chunk of readRes.stream) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        }
      })()
    );
    lazyStreams.push(lazyStream);
    lazyStream.on("error", abortZip);
    zipFile.addReadStream(lazyStream, relativePath, { compress: false });

    manifestEntries.push({
      relativePath,
      assetId: row.asset_id,
      assetName: row.asset_name,
      assetType: row.asset_type,
      purpose: row.purpose,
      source: row.source,
      primarySpu: row.primary_spu,
      assetVersionId: row.asset_version_id,
      versionNo: Number(row.version_no),
      originalFilename: row.original_filename,
      reviewStatus: row.review_status,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      createdAt: row.version_created_at
    });
  });

  const manifest = {
    format: "assetnest-open-standard-export",
    formatVersion: 1,
    schemaVersion: getCurrentSchemaVersion(db),
    generatedAt: new Date().toISOString(),
    fileCount: manifestEntries.length,
    files: manifestEntries
  };

  zipFile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"), "manifest.json");
  zipFile.end();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `assetnest-open-export-${stamp}.zip`;
  return { stream: zipFile.outputStream, fileName, fileCount: manifestEntries.length };
}
