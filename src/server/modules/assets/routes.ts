import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import type { StorageRegistry } from "../../storage/registry.js";
import { createRequireAuthHook } from "../../http/security.js";
import {
  isActiveMimeOrExt,
  isRasterImageMime,
  isSafePlainTextMime,
  sanitizeFilename
} from "../media/detect.js";
import {
  appendAssetVersion,
  batchOperateAssets,
  ensureThumbnailReady,
  getAssetDetail,
  ingestStagedFile,
  listAssets,
  resolveAssetVersionFile,
  reviewAssetVersion,
  switchAssetCurrentVersion,
  updateAsset,
  type StagedUploadFile
} from "./service.js";

const listAssetsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  productId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  market: z.string().max(80).optional(),
  platform: z.string().max(80).optional(),
  purpose: z.string().max(80).optional(),
  scene: z.string().max(80).optional(),
  color: z.string().max(80).optional(),
  tagId: z.string().max(500).optional(),
  type: z.enum(["image", "video", "document", "archive", "other"]).optional(),
  reviewStatus: z.enum(["pending", "approved", "rejected"]).optional(),
  folderId: z.string().uuid().optional(),
  unfiled: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((val) => val === true || val === "true" || val === "1"),
  favorite: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((val) => val === true || val === "true" || val === "1"),
  storageId: z.string().max(64).optional(),
  minWidth: z.coerce.number().int().min(1).optional(),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  sort: z.enum(["newest", "oldest", "name_asc", "size_desc"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(48)
});

const updateAssetSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  folderId: z.string().uuid().nullable().optional(),
  purpose: z.string().trim().max(80).optional(),
  isFavorite: z.boolean().optional(),
  source: z.string().max(200).optional(),
  sourceUrl: z.string().max(500).nullable().optional(),
  notes: z.string().max(4000).optional(),
  tagIds: z.array(z.string().min(1)).max(100).optional(),
  productIds: z.array(z.string().uuid()).max(100).optional()
});

const batchAssetsSchema = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum([
    "move_folder",
    "add_tags",
    "remove_tags",
    "link_products",
    "unlink_products",
    "set_review_status",
    "soft_delete"
  ]),
  folderId: z.string().uuid().nullable().optional(),
  tagIds: z.array(z.string().min(1)).max(100).optional(),
  productIds: z.array(z.string().uuid()).max(100).optional(),
  reviewStatus: z.enum(["pending", "approved", "rejected"]).optional(),
  reviewNote: z.string().max(1000).optional()
});

const switchCurrentVersionSchema = z.object({
  versionId: z.string().uuid()
});

const reviewVersionSchema = z.object({
  reviewStatus: z.enum(["pending", "approved", "rejected"]),
  reviewNote: z.string().max(2000).optional()
});

function parseCsvOrJsonList(values: string[]): string[] {
  const result: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              result.push(item.trim());
            }
          }
          continue;
        }
      } catch {
        // fallback to comma split
      }
    }
    for (const part of trimmed.split(",")) {
      if (part.trim()) {
        result.push(part.trim());
      }
    }
  }
  return Array.from(new Set(result));
}

async function measureDirectoryBytes(dirPath: string): Promise<number> {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  let total = 0;
  const items = await fsp.readdir(dirPath, { withFileTypes: true });
  for (const item of items) {
    if (item.isFile()) {
      const stat = await fsp.stat(path.join(dirPath, item.name)).catch(() => null);
      if (stat) {
        total += stat.size;
      }
    }
  }
  return total;
}

function parseHttpRange(
  header: string | undefined,
  totalSize: number
): { start: number; end: number } | null {
  if (!header || !header.startsWith("bytes=")) {
    return null;
  }
  const rangeSpec = header.slice("bytes=".length).split(",")[0]?.trim();
  if (!rangeSpec) {
    return null;
  }
  const [startStr, endStr] = rangeSpec.split("-");
  if (startStr === "" && endStr) {
    const suffixLength = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(totalSize - suffixLength, 0);
    return { start, end: Math.max(totalSize - 1, 0) };
  }
  const start = Number.parseInt(startStr ?? "", 10);
  const end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= totalSize) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

function encodeContentDisposition(disposition: "attachment" | "inline", filename: string): string {
  const safe = sanitizeFilename(filename);
  const asciiFallback = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safe);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function registerAssetRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ResolvedAppConfig,
  storageRegistry: StorageRegistry
): void {
  const requireAuth = createRequireAuthHook(db);
  let activeUploads = 0;

  app.post("/api/v1/assets/upload", { preHandler: requireAuth }, async (request, reply) => {
    if (activeUploads >= config.uploads.maxConcurrency) {
      throw new AppError(429, "RATE_LIMITED", "当前并发上传数量已达上限，请稍后重试");
    }

    activeUploads += 1;
    const stagedFiles: StagedUploadFile[] = [];

    try {
      const tempDir = config.uploads.tempDir;
      await fsp.mkdir(tempDir, { recursive: true });

      const maxFileBytes = config.uploads.maxFileSizeMB * 1024 * 1024;
      const maxTempBytes = Math.max(config.uploads.maxFileSizeMB * 2, 512) * 1024 * 1024;
      const currentTempBytes = await measureDirectoryBytes(tempDir);
      if (currentTempBytes >= maxTempBytes) {
        throw new AppError(503, "STORAGE_OFFLINE", "临时上传暂存区空间不足，请稍后重试");
      }

      const fieldValues = new Map<string, string[]>();
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === "field") {
          const list = fieldValues.get(part.fieldname) ?? [];
          list.push(typeof part.value === "string" ? part.value : String(part.value ?? ""));
          fieldValues.set(part.fieldname, list);
          continue;
        }

        const tempPath = path.join(tempDir, `${crypto.randomUUID()}.upload`);
        const hash = crypto.createHash("sha256");
        const headerChunks: Buffer[] = [];
        let headerBytes = 0;
        let sizeBytes = 0;
        const writeStream = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o640 });

        try {
          for await (const chunk of part.file) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            sizeBytes += buf.length;
            if (sizeBytes > maxFileBytes) {
              throw new AppError(
                413,
                "PAYLOAD_TOO_LARGE",
                `单文件大小超过上限（${config.uploads.maxFileSizeMB} MB）`
              );
            }
            hash.update(buf);
            if (headerBytes < 8192) {
              const need = Math.min(8192 - headerBytes, buf.length);
              headerChunks.push(buf.subarray(0, need));
              headerBytes += need;
            }
            if (!writeStream.write(buf)) {
              await new Promise<void>((resolve) => writeStream.once("drain", resolve));
            }
          }

          await new Promise<void>((resolve, reject) => {
            writeStream.on("error", reject);
            writeStream.end(() => resolve());
          });

          if (part.file.truncated) {
            throw new AppError(
              413,
              "PAYLOAD_TOO_LARGE",
              `单文件大小超过上限（${config.uploads.maxFileSizeMB} MB）`
            );
          }

          stagedFiles.push({
            tempPath,
            originalFilename: part.filename || "unnamed",
            declaredMime: part.mimetype || "application/octet-stream",
            sha256: hash.digest("hex"),
            sizeBytes,
            header: Buffer.concat(headerChunks)
          });
        } catch (err) {
          writeStream.destroy();
          await fsp.rm(tempPath, { force: true }).catch(() => {});
          throw err;
        }
      }

      if (stagedFiles.length === 0) {
        throw new AppError(400, "VALIDATION_ERROR", "未检测到上传文件");
      }

      const productIds = parseCsvOrJsonList([
        ...(fieldValues.get("productId") ?? []),
        ...(fieldValues.get("productIds") ?? [])
      ]);
      const tagIds = parseCsvOrJsonList(fieldValues.get("tagIds") ?? []);
      const folderIdRaw = (fieldValues.get("folderId")?.[0] ?? "").trim();
      const storageIdRaw = (fieldValues.get("storageId")?.[0] ?? "").trim();
      const purposeRaw = (fieldValues.get("purpose")?.[0] ?? "").trim();
      const sourceRaw = (fieldValues.get("source")?.[0] ?? "").trim();
      const sourceUrlRaw = (fieldValues.get("sourceUrl")?.[0] ?? "").trim();
      const notesRaw = fieldValues.get("notes")?.[0] ?? "";
      const promptTextRaw = fieldValues.get("promptText")?.[0] ?? "";

      const results = [];
      for (const staged of stagedFiles) {
        const ingested = await ingestStagedFile(
          db,
          config,
          storageRegistry,
          request.authUser!.id,
          staged,
          {
            productIds,
            folderId: folderIdRaw || null,
            storageId: storageIdRaw || null,
            purpose: purposeRaw || "other",
            tagIds,
            source: sourceRaw,
            sourceUrl: sourceUrlRaw || null,
            notes: notesRaw,
            promptText: promptTextRaw
          }
        );
        results.push(ingested);
      }

      return reply.status(201).send({
        items: results.map((entry) => entry.asset),
        uploadedCount: results.length,
        deduplicatedCount: results.filter((entry) => entry.deduplicated).length
      });
    } finally {
      activeUploads = Math.max(0, activeUploads - 1);
      for (const staged of stagedFiles) {
        await fsp.rm(staged.tempPath, { force: true }).catch(() => {});
      }
    }
  });

  app.get("/api/v1/assets", { preHandler: requireAuth }, async (request) => {
    const query = listAssetsQuerySchema.parse(request.query);
    return listAssets(db, query);
  });

  app.get("/api/v1/assets/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return getAssetDetail(db, id);
  });

  app.patch("/api/v1/assets/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateAssetSchema.parse(request.body);
    return updateAsset(db, request.authUser!.id, id, body);
  });

  app.post("/api/v1/assets/batch", { preHandler: requireAuth }, async (request) => {
    const body = batchAssetsSchema.parse(request.body);
    return batchOperateAssets(db, request.authUser!.id, body);
  });

  app.post("/api/v1/assets/:id/versions", { preHandler: requireAuth }, async (request, reply) => {
    if (activeUploads >= config.uploads.maxConcurrency) {
      throw new AppError(429, "RATE_LIMITED", "当前并发上传数量已达上限，请稍后重试");
    }

    const { id } = request.params as { id: string };
    activeUploads += 1;
    let stagedFile: StagedUploadFile | null = null;

    try {
      const tempDir = config.uploads.tempDir;
      await fsp.mkdir(tempDir, { recursive: true });

      const maxFileBytes = config.uploads.maxFileSizeMB * 1024 * 1024;
      const maxTempBytes = Math.max(config.uploads.maxFileSizeMB * 2, 512) * 1024 * 1024;
      const currentTempBytes = await measureDirectoryBytes(tempDir);
      if (currentTempBytes >= maxTempBytes) {
        throw new AppError(503, "STORAGE_OFFLINE", "临时上传暂存区空间不足，请稍后重试");
      }

      const fieldValues = new Map<string, string>();
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === "field") {
          fieldValues.set(
            part.fieldname,
            typeof part.value === "string" ? part.value : String(part.value ?? "")
          );
          continue;
        }

        if (stagedFile) {
          // Drain extra files if any
          for await (const _chunk of part.file) {
            // discard
          }
          continue;
        }

        const tempPath = path.join(tempDir, `${crypto.randomUUID()}.upload`);
        const hash = crypto.createHash("sha256");
        const headerChunks: Buffer[] = [];
        let headerBytes = 0;
        let sizeBytes = 0;
        const writeStream = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o640 });

        try {
          for await (const chunk of part.file) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            sizeBytes += buf.length;
            if (sizeBytes > maxFileBytes) {
              throw new AppError(
                413,
                "PAYLOAD_TOO_LARGE",
                `单文件大小超过上限（${config.uploads.maxFileSizeMB} MB）`
              );
            }
            hash.update(buf);
            if (headerBytes < 8192) {
              const need = Math.min(8192 - headerBytes, buf.length);
              headerChunks.push(buf.subarray(0, need));
              headerBytes += need;
            }
            if (!writeStream.write(buf)) {
              await new Promise<void>((resolve) => writeStream.once("drain", resolve));
            }
          }

          await new Promise<void>((resolve, reject) => {
            writeStream.on("error", reject);
            writeStream.end(() => resolve());
          });

          if (part.file.truncated) {
            throw new AppError(
              413,
              "PAYLOAD_TOO_LARGE",
              `单文件大小超过上限（${config.uploads.maxFileSizeMB} MB）`
            );
          }

          stagedFile = {
            tempPath,
            originalFilename: part.filename || "unnamed",
            declaredMime: part.mimetype || "application/octet-stream",
            sha256: hash.digest("hex"),
            sizeBytes,
            header: Buffer.concat(headerChunks)
          };
        } catch (err) {
          writeStream.destroy();
          await fsp.rm(tempPath, { force: true }).catch(() => {});
          throw err;
        }
      }

      if (!stagedFile) {
        throw new AppError(400, "VALIDATION_ERROR", "请上传新版本文件");
      }

      const setAsCurrentRaw = (fieldValues.get("setAsCurrent") ?? "true").trim().toLowerCase();
      const setAsCurrent = setAsCurrentRaw !== "false" && setAsCurrentRaw !== "0";
      const referenceRaw = (fieldValues.get("referenceAssetVersionId") ?? "").trim();
      const storageIdRaw = (fieldValues.get("storageId") ?? "").trim();

      const created = await appendAssetVersion(
        db,
        config,
        storageRegistry,
        request.authUser!.id,
        id,
        stagedFile,
        {
          storageId: storageIdRaw || null,
          changeNote: fieldValues.get("changeNote") ?? "",
          promptText: fieldValues.get("promptText") ?? "",
          referenceAssetVersionId: referenceRaw || null,
          setAsCurrent
        }
      );

      return reply.status(201).send(created);
    } finally {
      activeUploads = Math.max(0, activeUploads - 1);
      if (stagedFile) {
        await fsp.rm(stagedFile.tempPath, { force: true }).catch(() => {});
      }
    }
  });

  app.post("/api/v1/assets/:id/current-version", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = switchCurrentVersionSchema.parse(request.body);
    return switchAssetCurrentVersion(db, request.authUser!.id, id, body.versionId);
  });

  app.post(
    "/api/v1/asset-versions/:versionId/review",
    { preHandler: requireAuth },
    async (request) => {
      const { versionId } = request.params as { versionId: string };
      const body = reviewVersionSchema.parse(request.body);
      return reviewAssetVersion(db, request.authUser!.id, versionId, body);
    }
  );

  app.get(
    "/api/v1/assets/:id/versions/:versionId/content",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const query = z
        .object({
          preview: z.enum(["1", "true", "0", "false"]).optional()
        })
        .parse(request.query);
      const wantsPreview = query.preview === "1" || query.preview === "true";

      const versionInfo = resolveAssetVersionFile(db, id, versionId);
      const provider = storageRegistry.require(versionInfo.storageId);

      // Always enforce strict sandbox headers on active content (SVG/HTML/JS)
      if (isActiveMimeOrExt(versionInfo.mimeType, versionInfo.ext)) {
        const readRes = await provider.get(versionInfo.objectKey);
        reply
          .header("Content-Security-Policy", "default-src 'none'; sandbox")
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition", encodeContentDisposition("attachment", versionInfo.originalFilename))
          .header("Content-Type", "application/octet-stream");
        if (readRes.size !== undefined) {
          reply.header("Content-Length", String(readRes.size));
        }
        return reply.send(readRes.stream);
      }

      // Safe plain-text/Markdown inline preview
      if (wantsPreview && isSafePlainTextMime(versionInfo.mimeType, versionInfo.ext)) {
        const readRes = await provider.get(versionInfo.objectKey);
        reply
          .header("Content-Security-Policy", "default-src 'none'; sandbox")
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition", encodeContentDisposition("inline", versionInfo.originalFilename))
          .header("Content-Type", "text/plain; charset=utf-8");
        if (readRes.size !== undefined) {
          reply.header("Content-Length", String(readRes.size));
        }
        return reply.send(readRes.stream);
      }

      // Raster image or Video inline preview (with HTTP Range 206 support)
      const isVideo = versionInfo.mimeType.startsWith("video/");
      const isRaster = isRasterImageMime(versionInfo.mimeType);
      if (wantsPreview && (isVideo || isRaster)) {
        const rangeHeader = request.headers.range;
        if (rangeHeader && provider.capabilities.rangeRead) {
          const parsedRange = parseHttpRange(rangeHeader, versionInfo.sizeBytes);
          if (!parsedRange) {
            reply.header("Content-Range", `bytes */${versionInfo.sizeBytes}`);
            return reply.status(416).send({
              error: { code: "RANGE_NOT_SATISFIABLE", message: "请求的字节范围无效" }
            });
          }
          const readRes = await provider.get(versionInfo.objectKey, { range: parsedRange });
          const range = readRes.contentRange ?? {
            start: parsedRange.start,
            end: parsedRange.end,
            total: versionInfo.sizeBytes
          };
          reply
            .status(206)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", `bytes ${range.start}-${range.end}/${range.total}`)
            .header("Content-Length", String(range.end - range.start + 1))
            .header("Content-Type", versionInfo.mimeType)
            .header("Content-Disposition", encodeContentDisposition("inline", versionInfo.originalFilename))
            .header("Content-Security-Policy", "default-src 'none'; sandbox");
          return reply.send(readRes.stream);
        }

        const readRes = await provider.get(versionInfo.objectKey);
        reply
          .header("Accept-Ranges", provider.capabilities.rangeRead ? "bytes" : "none")
          .header("Content-Type", versionInfo.mimeType)
          .header("Content-Disposition", encodeContentDisposition("inline", versionInfo.originalFilename))
          .header("Content-Security-Policy", "default-src 'none'; sandbox");
        if (readRes.size !== undefined) {
          reply.header("Content-Length", String(readRes.size));
        }
        return reply.send(readRes.stream);
      }

      // Default: safe original file download (including PSD/ZIP/PDF/etc.)
      const readRes = await provider.get(versionInfo.objectKey);
      reply
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", encodeContentDisposition("attachment", versionInfo.originalFilename))
        .header("Content-Type", versionInfo.mimeType || "application/octet-stream");
      if (readRes.size !== undefined) {
        reply.header("Content-Length", String(readRes.size));
      }
      return reply.send(readRes.stream);
    }
  );

  app.get(
    "/api/v1/assets/:id/versions/:versionId/thumbnail",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const versionInfo = resolveAssetVersionFile(db, id, versionId);
      const ready = await ensureThumbnailReady(db, config, storageRegistry, versionInfo, false);
      const stat = await fsp.stat(ready.absPath);
      reply
        .header("Content-Type", "image/webp")
        .header("Content-Length", String(stat.size))
        .header("Cache-Control", "private, max-age=3600");
      return reply.send(fs.createReadStream(ready.absPath));
    }
  );

  app.post(
    "/api/v1/assets/:id/versions/:versionId/regenerate-thumbnail",
    { preHandler: requireAuth },
    async (request) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const versionInfo = resolveAssetVersionFile(db, id, versionId);
      const result = await ensureThumbnailReady(db, config, storageRegistry, versionInfo, true);
      return {
        versionId,
        thumbStatus: result.thumbStatus,
        regenerated: result.regenerated
      };
    }
  );
}
