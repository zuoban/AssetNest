import crypto from "node:crypto";
import type {
  ListingPdpResponse,
  PdpContent,
  PdpDraftRecord,
  PdpSpecDiffItem,
  PdpSpecRow,
  PdpVersionRecord
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { rebuildListingSearchDocument } from "../search/service.js";
import { recordActivity } from "../system/activity.js";

export function createEmptyPdpContent(): PdpContent {
  return {
    title: "",
    shortDescription: "",
    bullets: [],
    fullDescription: "",
    specs: [],
    packageList: "",
    usageInstructions: "",
    seoKeywords: "",
    notes: ""
  };
}

export function normalizePdpContent(raw: Partial<PdpContent> | null | undefined): PdpContent {
  const base = createEmptyPdpContent();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    shortDescription: typeof raw.shortDescription === "string" ? raw.shortDescription : "",
    bullets: Array.isArray(raw.bullets)
      ? raw.bullets.filter((item): item is string => typeof item === "string")
      : [],
    fullDescription: typeof raw.fullDescription === "string" ? raw.fullDescription : "",
    specs: Array.isArray(raw.specs)
      ? raw.specs
          .filter((row): row is PdpSpecRow => Boolean(row && typeof row.specKey === "string"))
          .map((row) => ({
            specKey: String(row.specKey ?? "").trim(),
            specValue: String(row.specValue ?? "").trim(),
            unit: String(row.unit ?? "").trim()
          }))
          .filter((row) => row.specKey.length > 0 || row.specValue.length > 0)
      : [],
    packageList: typeof raw.packageList === "string" ? raw.packageList : "",
    usageInstructions: typeof raw.usageInstructions === "string" ? raw.usageInstructions : "",
    seoKeywords: typeof raw.seoKeywords === "string" ? raw.seoKeywords : "",
    notes: typeof raw.notes === "string" ? raw.notes : ""
  };
}

export function parsePdpContentJson(raw: string): PdpContent {
  try {
    return normalizePdpContent(JSON.parse(raw) as Partial<PdpContent>);
  } catch {
    return createEmptyPdpContent();
  }
}

export function countUnicodeCodePoints(text: string): number {
  return Array.from(text).length;
}

function ensureActiveListing(
  db: AppDatabase,
  listingId: string
): { id: string; product_id: string; language: string; display_name: string } {
  const row = db.raw
    .prepare(
      "SELECT id, product_id, language, display_name FROM listings WHERE id = ? AND deleted_at IS NULL"
    )
    .get(listingId) as
    | { id: string; product_id: string; language: string; display_name: string }
    | undefined;
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "上架链接不存在或已移入回收站");
  }
  return row;
}

function computeSpecDiff(productSpecs: PdpSpecRow[], pdpSpecs: PdpSpecRow[]): PdpSpecDiffItem[] {
  const pdpByKey = new Map<string, PdpSpecRow>();
  for (const row of pdpSpecs) {
    const key = row.specKey.trim().toLowerCase();
    if (key) {
      pdpByKey.set(key, row);
    }
  }
  const productKeys = new Set<string>();
  const diff: PdpSpecDiffItem[] = [];

  for (const prod of productSpecs) {
    const normKey = prod.specKey.trim().toLowerCase();
    if (!normKey) continue;
    productKeys.add(normKey);
    const existing = pdpByKey.get(normKey);
    if (!existing) {
      diff.push({
        specKey: prod.specKey,
        kind: "added_in_product",
        productValue: prod.specValue,
        productUnit: prod.unit
      });
    } else if (existing.specValue !== prod.specValue || existing.unit !== prod.unit) {
      diff.push({
        specKey: prod.specKey,
        kind: "changed_in_product",
        productValue: prod.specValue,
        productUnit: prod.unit,
        pdpValue: existing.specValue,
        pdpUnit: existing.unit
      });
    }
  }

  for (const row of pdpSpecs) {
    const normKey = row.specKey.trim().toLowerCase();
    if (normKey && !productKeys.has(normKey)) {
      diff.push({
        specKey: row.specKey,
        kind: "only_in_pdp",
        pdpValue: row.specValue,
        pdpUnit: row.unit
      });
    }
  }

  return diff;
}

export function getListingPdp(db: AppDatabase, listingId: string): ListingPdpResponse {
  const listing = ensureActiveListing(db, listingId);
  let draftRow = db.raw
    .prepare(
      `SELECT listing_id, language, content_json, revision, based_on_version_id, updated_at
       FROM listing_pdp_drafts
       WHERE listing_id = ?`
    )
    .get(listingId) as
    | {
        listing_id: string;
        language: string;
        content_json: string;
        revision: number;
        based_on_version_id: string | null;
        updated_at: string;
      }
    | undefined;

  if (!draftRow) {
    const now = new Date().toISOString();
    const emptyJson = JSON.stringify(createEmptyPdpContent());
    db.transaction(() => {
      db.raw
        .prepare(
          `INSERT OR IGNORE INTO listing_pdp_drafts
             (listing_id, language, content_json, revision, based_on_version_id, updated_at)
           VALUES (?, ?, ?, 1, NULL, ?)`
        )
        .run(listingId, listing.language, emptyJson, now);
    });
    draftRow = db.raw
      .prepare(
        `SELECT listing_id, language, content_json, revision, based_on_version_id, updated_at
         FROM listing_pdp_drafts
         WHERE listing_id = ?`
      )
      .get(listingId) as typeof draftRow;
  }

  const draftContent = parsePdpContentJson(draftRow!.content_json);
  const draft: PdpDraftRecord = {
    listingId: draftRow!.listing_id,
    language: draftRow!.language,
    content: draftContent,
    revision: draftRow!.revision,
    basedOnVersionId: draftRow!.based_on_version_id,
    titleCodePoints: countUnicodeCodePoints(draftContent.title),
    titleUtf8Bytes: Buffer.byteLength(draftContent.title, "utf8"),
    updatedAt: draftRow!.updated_at
  };

  const versionRows = db.raw
    .prepare(
      `SELECT id, listing_id, language, version_no, content_json, note, created_at
       FROM pdp_versions
       WHERE listing_id = ?
       ORDER BY version_no DESC`
    )
    .all(listingId) as Array<{
    id: string;
    listing_id: string;
    language: string;
    version_no: number;
    content_json: string;
    note: string;
    created_at: string;
  }>;

  const versions: PdpVersionRecord[] = versionRows.map((row) => {
    const parsed = parsePdpContentJson(row.content_json);
    return {
      id: row.id,
      listingId: row.listing_id,
      language: row.language,
      versionNo: row.version_no,
      content: parsed,
      titleCodePoints: countUnicodeCodePoints(parsed.title),
      note: row.note,
      createdAt: row.created_at
    };
  });

  const productSpecRows = db.raw
    .prepare(
      `SELECT spec_key, spec_value, unit
       FROM product_specs
       WHERE product_id = ?
       ORDER BY position ASC, id ASC`
    )
    .all(listing.product_id) as Array<{ spec_key: string; spec_value: string; unit: string }>;

  const productSpecs: PdpSpecRow[] = productSpecRows.map((row) => ({
    specKey: row.spec_key,
    specValue: row.spec_value,
    unit: row.unit
  }));

  return {
    listingId,
    language: draft.language,
    draft,
    versions,
    productSpecs,
    specDiff: computeSpecDiff(productSpecs, draft.content.specs)
  };
}

export function saveListingPdpDraft(
  db: AppDatabase,
  actorUserId: string,
  listingId: string,
  input: { language?: string; content: Partial<PdpContent> }
): ListingPdpResponse {
  const listing = ensureActiveListing(db, listingId);
  const normalized = normalizePdpContent(input.content);
  const nextLanguage = (input.language ?? listing.language).trim() || listing.language;
  const now = new Date().toISOString();

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO listing_pdp_drafts
           (listing_id, language, content_json, revision, based_on_version_id, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
           language = excluded.language,
           content_json = excluded.content_json,
           revision = listing_pdp_drafts.revision + 1,
           updated_at = excluded.updated_at`
      )
      .run(listingId, nextLanguage, JSON.stringify(normalized), now);

    db.raw
      .prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
      .run(now, listingId);

    rebuildListingSearchDocument(db, listingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.pdp.draft_save",
      objectType: "listing",
      objectId: listingId,
      details: {
        language: nextLanguage,
        titleCodePoints: countUnicodeCodePoints(normalized.title)
      }
    });
  });

  return getListingPdp(db, listingId);
}

export function createListingPdpVersion(
  db: AppDatabase,
  actorUserId: string,
  listingId: string,
  input: { note?: string } = {}
): { version: PdpVersionRecord; pdp: ListingPdpResponse } {
  ensureActiveListing(db, listingId);
  const current = getListingPdp(db, listingId);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const note = (input.note ?? "").trim();
  let versionNo = 1;

  db.transaction(() => {
    const maxRow = db.raw
      .prepare("SELECT COALESCE(MAX(version_no), 0) AS max_no FROM pdp_versions WHERE listing_id = ?")
      .get(listingId) as { max_no: number };
    versionNo = Number(maxRow.max_no) + 1;

    db.raw
      .prepare(
        `INSERT INTO pdp_versions
           (id, listing_id, language, version_no, content_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        versionId,
        listingId,
        current.draft.language,
        versionNo,
        JSON.stringify(current.draft.content),
        note,
        now
      );

    db.raw
      .prepare(
        "UPDATE listing_pdp_drafts SET based_on_version_id = ?, updated_at = ? WHERE listing_id = ?"
      )
      .run(versionId, now, listingId);

    recordActivity(db, {
      actorUserId,
      action: "listing.pdp.version_create",
      objectType: "pdp_version",
      objectId: versionId,
      details: { listingId, versionNo, language: current.draft.language, note }
    });
  });

  const updatedPdp = getListingPdp(db, listingId);
  const createdVersion = updatedPdp.versions.find((ver) => ver.id === versionId)!;
  return { version: createdVersion, pdp: updatedPdp };
}

export function restoreListingPdpVersion(
  db: AppDatabase,
  actorUserId: string,
  listingId: string,
  versionId: string
): ListingPdpResponse {
  ensureActiveListing(db, listingId);
  const versionRow = db.raw
    .prepare(
      `SELECT id, listing_id, language, version_no, content_json
       FROM pdp_versions
       WHERE id = ? AND listing_id = ?`
    )
    .get(versionId, listingId) as
    | {
        id: string;
        listing_id: string;
        language: string;
        version_no: number;
        content_json: string;
      }
    | undefined;

  if (!versionRow) {
    throw new AppError(404, "NOT_FOUND", "历史 PDP 文案版本不存在");
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO listing_pdp_drafts
           (listing_id, language, content_json, revision, based_on_version_id, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
           language = excluded.language,
           content_json = excluded.content_json,
           revision = listing_pdp_drafts.revision + 1,
           based_on_version_id = excluded.based_on_version_id,
           updated_at = excluded.updated_at`
      )
      .run(listingId, versionRow.language, versionRow.content_json, versionRow.id, now);

    db.raw
      .prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
      .run(now, listingId);

    rebuildListingSearchDocument(db, listingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.pdp.restore_draft",
      objectType: "listing",
      objectId: listingId,
      details: { fromVersionId: versionId, fromVersionNo: versionRow.version_no }
    });
  });

  return getListingPdp(db, listingId);
}

export function copyListingPdpTo(
  db: AppDatabase,
  actorUserId: string,
  sourceListingId: string,
  input: { targetListingId: string; versionId?: string; keepTargetLanguage?: boolean }
): ListingPdpResponse {
  ensureActiveListing(db, sourceListingId);
  const targetListing = ensureActiveListing(db, input.targetListingId);

  if (sourceListingId === input.targetListingId) {
    throw new AppError(400, "VALIDATION_ERROR", "目标上架链接不能与来源相同");
  }

  let sourceLanguage: string;
  let sourceContentJson: string;
  if (input.versionId) {
    const ver = db.raw
      .prepare("SELECT language, content_json FROM pdp_versions WHERE id = ? AND listing_id = ?")
      .get(input.versionId, sourceListingId) as
      | { language: string; content_json: string }
      | undefined;
    if (!ver) {
      throw new AppError(404, "NOT_FOUND", "指定的来源 PDP 历史版本不存在");
    }
    sourceLanguage = ver.language;
    sourceContentJson = ver.content_json;
  } else {
    const sourcePdp = getListingPdp(db, sourceListingId);
    sourceLanguage = sourcePdp.draft.language;
    sourceContentJson = JSON.stringify(sourcePdp.draft.content);
  }

  const targetLanguage = input.keepTargetLanguage ? targetListing.language : sourceLanguage;
  const now = new Date().toISOString();

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO listing_pdp_drafts
           (listing_id, language, content_json, revision, based_on_version_id, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
           language = excluded.language,
           content_json = excluded.content_json,
           revision = listing_pdp_drafts.revision + 1,
           based_on_version_id = NULL,
           updated_at = excluded.updated_at`
      )
      .run(input.targetListingId, targetLanguage, sourceContentJson, now);

    db.raw
      .prepare("UPDATE listings SET updated_at = ? WHERE id = ?")
      .run(now, input.targetListingId);

    rebuildListingSearchDocument(db, input.targetListingId);
    recordActivity(db, {
      actorUserId,
      action: "listing.pdp.copy_to",
      objectType: "listing",
      objectId: input.targetListingId,
      details: {
        sourceListingId,
        sourceVersionId: input.versionId ?? null,
        targetLanguage
      }
    });
  });

  return getListingPdp(db, input.targetListingId);
}
