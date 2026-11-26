import crypto from "node:crypto";
import { z } from "zod";
import type {
  ExportTemplateRecord,
  ExportTemplateRules,
  PdpRequiredField
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";

const pdpRequiredFieldEnum = z.enum([
  "title",
  "shortDescription",
  "bullets",
  "description",
  "specs",
  "packageList",
  "usageInstructions"
]);

const safeFolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (val) =>
      !val.includes("/") &&
      !val.includes("\\") &&
      !val.includes("..") &&
      !val.includes("\0") &&
      val !== ".",
    "目录名不允许包含路径分隔符或 .."
  );

const safePrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (val) => !val.includes("/") && !val.includes("\\") && !val.includes("..") && !val.includes("\0"),
    "命名前缀不允许包含路径分隔符或 .."
  );

const extListSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .transform((ext) => ext.replace(/^\.+/, ""))
      .refine((ext) => /^[a-z0-9]+$/.test(ext), "文件扩展名仅允许字母与数字")
  )
  .min(1)
  .max(30);

const aspectRatioSchema = z
  .string()
  .trim()
  .refine(
    (val) => val === "" || /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(val),
    "宽高比格式应为 W:H（如 1:1 或 9:16）或留空"
  );

export const exportTemplateRulesSchema = z.object({
  folders: z.object({
    carousel: safeFolderNameSchema,
    sku: safeFolderNameSchema,
    detail: safeFolderNameSchema,
    video: safeFolderNameSchema,
    pdp: safeFolderNameSchema
  }),
  carousel: z
    .object({
      minCount: z.number().int().min(0).max(50),
      targetCount: z.number().int().min(0).max(50),
      maxCount: z.number().int().min(1).max(100),
      aspectRatio: aspectRatioSchema,
      aspectTolerance: z.number().min(0).max(1),
      minWidth: z.number().int().min(0).max(20000),
      minHeight: z.number().int().min(0).max(20000),
      maxFileSizeMB: z.number().positive().max(2048),
      allowedExts: extListSchema
    })
    .refine((cfg) => cfg.minCount <= cfg.maxCount, "轮播图 minCount 不能大于 maxCount")
    .refine((cfg) => cfg.targetCount <= cfg.maxCount, "轮播图 targetCount 不能大于 maxCount"),
  detail: z
    .object({
      minCount: z.number().int().min(0).max(100),
      maxCount: z.number().int().min(0).max(200),
      aspectRatio: aspectRatioSchema,
      aspectTolerance: z.number().min(0).max(1),
      minWidth: z.number().int().min(0).max(20000),
      minHeight: z.number().int().min(0).max(20000),
      maxFileSizeMB: z.number().positive().max(2048),
      allowedExts: extListSchema
    })
    .refine((cfg) => cfg.minCount <= cfg.maxCount, "详情图 minCount 不能大于 maxCount"),
  sku: z.object({
    required: z.boolean(),
    minWidth: z.number().int().min(0).max(20000),
    minHeight: z.number().int().min(0).max(20000),
    maxFileSizeMB: z.number().positive().max(2048),
    allowedExts: extListSchema
  }),
  video: z.object({
    maxCount: z.number().int().min(0).max(20),
    maxFileSizeMB: z.number().positive().max(4096),
    allowedExts: extListSchema
  }),
  pdp: z.object({
    maxTitleCodePoints: z.number().int().min(1).max(2000),
    requiredFields: z.array(pdpRequiredFieldEnum).max(10)
  }),
  review: z.object({
    requireApprovedForFormal: z.boolean()
  }),
  naming: z.object({
    carouselPrefix: safePrefixSchema,
    mainImageName: safePrefixSchema,
    detailPrefix: safePrefixSchema,
    videoPrefix: safePrefixSchema
  })
});

export const DEFAULT_TEMPLATE_RULES: ExportTemplateRules = {
  folders: {
    carousel: "01_Carousel",
    sku: "02_SKU",
    detail: "03_Detail",
    video: "04_Video",
    pdp: "05_PDP"
  },
  carousel: {
    minCount: 1,
    targetCount: 9,
    maxCount: 9,
    aspectRatio: "1:1",
    aspectTolerance: 0.05,
    minWidth: 800,
    minHeight: 800,
    maxFileSizeMB: 10,
    allowedExts: ["jpg", "jpeg", "png", "webp"]
  },
  detail: {
    minCount: 0,
    maxCount: 20,
    aspectRatio: "9:16",
    aspectTolerance: 0.15,
    minWidth: 750,
    minHeight: 800,
    maxFileSizeMB: 10,
    allowedExts: ["jpg", "jpeg", "png", "webp"]
  },
  sku: {
    required: true,
    minWidth: 600,
    minHeight: 600,
    maxFileSizeMB: 10,
    allowedExts: ["jpg", "jpeg", "png", "webp"]
  },
  video: {
    maxCount: 2,
    maxFileSizeMB: 100,
    allowedExts: ["mp4", "mov", "webm"]
  },
  pdp: {
    maxTitleCodePoints: 120,
    requiredFields: ["title", "description"] as PdpRequiredField[]
  },
  review: {
    requireApprovedForFormal: true
  },
  naming: {
    carouselPrefix: "Carousel",
    mainImageName: "01_Main",
    detailPrefix: "Detail",
    videoPrefix: "Video"
  }
};

interface TemplateRow {
  id: string;
  name: string;
  platform: string;
  market: string;
  version: number;
  is_default: number;
  rules_json: string;
  created_at: string;
  updated_at: string;
}

function parseRules(raw: string): ExportTemplateRules {
  try {
    const parsed = JSON.parse(raw) as Partial<ExportTemplateRules>;
    const merged: ExportTemplateRules = {
      folders: { ...DEFAULT_TEMPLATE_RULES.folders, ...(parsed.folders ?? {}) },
      carousel: { ...DEFAULT_TEMPLATE_RULES.carousel, ...(parsed.carousel ?? {}) },
      detail: { ...DEFAULT_TEMPLATE_RULES.detail, ...(parsed.detail ?? {}) },
      sku: { ...DEFAULT_TEMPLATE_RULES.sku, ...(parsed.sku ?? {}) },
      video: { ...DEFAULT_TEMPLATE_RULES.video, ...(parsed.video ?? {}) },
      pdp: { ...DEFAULT_TEMPLATE_RULES.pdp, ...(parsed.pdp ?? {}) },
      review: { ...DEFAULT_TEMPLATE_RULES.review, ...(parsed.review ?? {}) },
      naming: { ...DEFAULT_TEMPLATE_RULES.naming, ...(parsed.naming ?? {}) }
    };
    return exportTemplateRulesSchema.parse(merged);
  } catch {
    return DEFAULT_TEMPLATE_RULES;
  }
}

function mapTemplateRow(row: TemplateRow): ExportTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    market: row.market,
    version: Number(row.version),
    isDefault: row.is_default === 1,
    rules: parseRules(row.rules_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listExportTemplates(
  db: AppDatabase,
  filter?: { platform?: string; market?: string }
): ExportTemplateRecord[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.platform) {
    clauses.push("platform = ?");
    params.push(filter.platform);
  }
  if (filter?.market) {
    clauses.push("market = ?");
    params.push(filter.market);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.raw
    .prepare(
      `SELECT id, name, platform, market, version, is_default, rules_json, created_at, updated_at
       FROM export_templates
       ${where}
       ORDER BY platform ASC, market ASC, is_default DESC, updated_at DESC`
    )
    .all(...params) as unknown as TemplateRow[];
  return rows.map(mapTemplateRow);
}

export function getExportTemplate(db: AppDatabase, id: string): ExportTemplateRecord {
  const row = db.raw
    .prepare(
      `SELECT id, name, platform, market, version, is_default, rules_json, created_at, updated_at
       FROM export_templates
       WHERE id = ?`
    )
    .get(id) as TemplateRow | undefined;
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `导出模板 "${id}" 不存在`);
  }
  return mapTemplateRow(row);
}

export function resolveTemplateForListing(
  db: AppDatabase,
  platform: string,
  market: string,
  templateId?: string
): ExportTemplateRecord {
  if (templateId) {
    return getExportTemplate(db, templateId);
  }

  const exact = db.raw
    .prepare(
      `SELECT id, name, platform, market, version, is_default, rules_json, created_at, updated_at
       FROM export_templates
       WHERE platform = ? AND market = ?
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`
    )
    .get(platform, market) as TemplateRow | undefined;
  if (exact) {
    return mapTemplateRow(exact);
  }

  const byPlatform = db.raw
    .prepare(
      `SELECT id, name, platform, market, version, is_default, rules_json, created_at, updated_at
       FROM export_templates
       WHERE platform = ?
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`
    )
    .get(platform) as TemplateRow | undefined;
  if (byPlatform) {
    return mapTemplateRow(byPlatform);
  }

  const fallback = db.raw
    .prepare(
      `SELECT id, name, platform, market, version, is_default, rules_json, created_at, updated_at
       FROM export_templates
       ORDER BY is_default DESC, created_at ASC
       LIMIT 1`
    )
    .get() as TemplateRow | undefined;
  if (fallback) {
    return mapTemplateRow(fallback);
  }

  throw new AppError(404, "NOT_FOUND", "当前系统未配置任何导出模板，请先创建导出模板");
}

export interface CreateExportTemplateInput {
  name: string;
  platform: string;
  market: string;
  isDefault?: boolean;
  rules: ExportTemplateRules;
}

export function createExportTemplate(
  db: AppDatabase,
  actorUserId: string,
  input: CreateExportTemplateInput
): ExportTemplateRecord {
  const rules = exportTemplateRulesSchema.parse(input.rules);
  const id = `tpl_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const isDefault = Boolean(input.isDefault);

  db.transaction(() => {
    if (isDefault) {
      db.raw
        .prepare(
          "UPDATE export_templates SET is_default = 0, updated_at = ? WHERE platform = ? AND market = ?"
        )
        .run(now, input.platform, input.market);
    }
    db.raw
      .prepare(
        `INSERT INTO export_templates (
           id, name, platform, market, version, is_default, rules_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name.trim(),
        input.platform.trim(),
        input.market.trim(),
        isDefault ? 1 : 0,
        JSON.stringify(rules),
        now,
        now
      );

    recordActivity(db, {
      actorUserId,
      action: "export_template.create",
      objectType: "export_template",
      objectId: id,
      details: { name: input.name.trim(), platform: input.platform, market: input.market }
    });
  });

  return getExportTemplate(db, id);
}

export interface UpdateExportTemplateInput {
  name?: string;
  platform?: string;
  market?: string;
  isDefault?: boolean;
  rules?: ExportTemplateRules;
}

export function updateExportTemplate(
  db: AppDatabase,
  actorUserId: string,
  id: string,
  input: UpdateExportTemplateInput
): ExportTemplateRecord {
  const existing = getExportTemplate(db, id);
  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  const nextPlatform = input.platform !== undefined ? input.platform.trim() : existing.platform;
  const nextMarket = input.market !== undefined ? input.market.trim() : existing.market;
  const nextIsDefault = input.isDefault !== undefined ? input.isDefault : existing.isDefault;
  const nextRules = input.rules ? exportTemplateRulesSchema.parse(input.rules) : existing.rules;
  const nextVersion = existing.version + 1;
  const now = new Date().toISOString();

  db.transaction(() => {
    if (nextIsDefault) {
      db.raw
        .prepare(
          `UPDATE export_templates
           SET is_default = 0, updated_at = ?
           WHERE platform = ? AND market = ? AND id != ?`
        )
        .run(now, nextPlatform, nextMarket, id);
    }

    db.raw
      .prepare(
        `UPDATE export_templates
         SET name = ?, platform = ?, market = ?, version = ?, is_default = ?, rules_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextName,
        nextPlatform,
        nextMarket,
        nextVersion,
        nextIsDefault ? 1 : 0,
        JSON.stringify(nextRules),
        now,
        id
      );

    recordActivity(db, {
      actorUserId,
      action: "export_template.update",
      objectType: "export_template",
      objectId: id,
      details: { name: nextName, version: nextVersion, platform: nextPlatform, market: nextMarket }
    });
  });

  return getExportTemplate(db, id);
}
