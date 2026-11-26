import crypto from "node:crypto";
import type { StoreRecord, StoreStatus } from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";

interface StoreRow {
  id: string;
  name: string;
  platform: string;
  market: string;
  default_language: string;
  status: StoreStatus;
  notes: string;
  listing_count: number;
  created_at: string;
  updated_at: string;
}

function mapStoreRow(row: StoreRow): StoreRecord {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    market: row.market,
    defaultLanguage: row.default_language,
    status: row.status,
    notes: row.notes,
    listingCount: Number(row.listing_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface StoreListQuery {
  q?: string;
  platform?: string;
  market?: string;
  status?: StoreStatus;
}

export function listStores(db: AppDatabase, query: StoreListQuery = {}): StoreRecord[] {
  const clauses: string[] = ["1 = 1"];
  const params: Array<string> = [];

  if (query.platform) {
    clauses.push("s.platform = ?");
    params.push(query.platform);
  }
  if (query.market) {
    clauses.push("s.market = ?");
    params.push(query.market);
  }
  if (query.status) {
    clauses.push("s.status = ?");
    params.push(query.status);
  }
  if (query.q && query.q.trim()) {
    clauses.push(
      "(instr(lower(s.name), lower(?)) > 0 OR instr(lower(s.platform), lower(?)) > 0 OR instr(lower(s.market), lower(?)) > 0 OR instr(lower(s.notes), lower(?)) > 0)"
    );
    const term = query.q.trim();
    params.push(term, term, term, term);
  }

  const rows = db.raw
    .prepare(
      `SELECT
         s.*,
         (SELECT COUNT(*) FROM listings l WHERE l.store_id = s.id AND l.deleted_at IS NULL) AS listing_count
       FROM stores s
       WHERE ${clauses.join(" AND ")}
       ORDER BY (s.status = 'archived') ASC, s.platform ASC, s.market ASC, s.name COLLATE NOCASE ASC`
    )
    .all(...params) as unknown as StoreRow[];

  return rows.map(mapStoreRow);
}

export function getStoreById(db: AppDatabase, storeId: string): StoreRecord {
  const row = db.raw
    .prepare(
      `SELECT
         s.*,
         (SELECT COUNT(*) FROM listings l WHERE l.store_id = s.id AND l.deleted_at IS NULL) AS listing_count
       FROM stores s
       WHERE s.id = ?`
    )
    .get(storeId) as unknown as StoreRow | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "店铺不存在");
  }
  return mapStoreRow(row);
}

export interface CreateStoreInput {
  name: string;
  platform: string;
  market: string;
  defaultLanguage: string;
  status?: StoreStatus;
  notes?: string;
}

export function createStore(
  db: AppDatabase,
  actorUserId: string,
  input: CreateStoreInput
): StoreRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = input.name.trim();
  const platform = input.platform.trim();
  const market = input.market.trim();
  const defaultLanguage = input.defaultLanguage.trim();

  db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO stores (
           id, name, platform, market, default_language, status, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        platform,
        market,
        defaultLanguage,
        input.status ?? "active",
        (input.notes ?? "").trim(),
        now,
        now
      );

    recordActivity(db, {
      actorUserId,
      action: "store.create",
      objectType: "store",
      objectId: id,
      details: { name, platform, market, defaultLanguage }
    });
  });

  return getStoreById(db, id);
}

export interface UpdateStoreInput {
  name?: string;
  platform?: string;
  market?: string;
  defaultLanguage?: string;
  status?: StoreStatus;
  notes?: string;
}

export function updateStore(
  db: AppDatabase,
  actorUserId: string,
  storeId: string,
  input: UpdateStoreInput
): StoreRecord {
  const existing = getStoreById(db, storeId);
  const now = new Date().toISOString();

  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  const nextPlatform = input.platform !== undefined ? input.platform.trim() : existing.platform;
  const nextMarket = input.market !== undefined ? input.market.trim() : existing.market;
  const nextLang =
    input.defaultLanguage !== undefined ? input.defaultLanguage.trim() : existing.defaultLanguage;
  const nextStatus = input.status ?? existing.status;
  const nextNotes = input.notes !== undefined ? input.notes.trim() : existing.notes;

  db.transaction(() => {
    db.raw
      .prepare(
        `UPDATE stores
         SET name = ?, platform = ?, market = ?, default_language = ?,
             status = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextName, nextPlatform, nextMarket, nextLang, nextStatus, nextNotes, now, storeId);

    recordActivity(db, {
      actorUserId,
      action: "store.update",
      objectType: "store",
      objectId: storeId,
      details: { updatedFields: Object.keys(input) }
    });
  });

  return getStoreById(db, storeId);
}

export function deleteStore(
  db: AppDatabase,
  actorUserId: string,
  storeId: string
): { deleted: boolean; id: string } {
  const existing = getStoreById(db, storeId);
  const refRow = db.raw
    .prepare("SELECT COUNT(*) AS count FROM listings WHERE store_id = ?")
    .get(storeId) as { count: number };
  if (Number(refRow.count) > 0) {
    throw new AppError(
      409,
      "CONFLICT",
      `店铺 "${existing.name}" 下存在 ${refRow.count} 条上架链接记录，禁止删除；请改为归档状态`
    );
  }

  db.transaction(() => {
    db.raw.prepare("DELETE FROM stores WHERE id = ?").run(storeId);
    recordActivity(db, {
      actorUserId,
      action: "store.delete",
      objectType: "store",
      objectId: storeId,
      details: { name: existing.name, platform: existing.platform, market: existing.market }
    });
  });

  return { deleted: true, id: storeId };
}
