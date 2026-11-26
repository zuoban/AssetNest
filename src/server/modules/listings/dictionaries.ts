import type {
  DictionariesResponse,
  DictionaryCategory,
  DictionaryRecord
} from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";

interface DictionaryRow {
  category: DictionaryCategory;
  code: string;
  label: string;
  is_active: number;
  position: number;
}

function mapDictionaryRow(row: DictionaryRow): DictionaryRecord {
  return {
    category: row.category,
    code: row.code,
    label: row.label,
    isActive: row.is_active === 1,
    position: row.position
  };
}

export function listDictionaries(
  db: AppDatabase,
  options: { category?: DictionaryCategory; activeOnly?: boolean } = {}
): DictionariesResponse {
  const clauses: string[] = ["1 = 1"];
  const params: Array<string | number> = [];
  if (options.category) {
    clauses.push("category = ?");
    params.push(options.category);
  }
  if (options.activeOnly) {
    clauses.push("is_active = 1");
  }

  const rows = db.raw
    .prepare(
      `SELECT category, code, label, is_active, position
       FROM dictionaries
       WHERE ${clauses.join(" AND ")}
       ORDER BY category ASC, position ASC, code ASC`
    )
    .all(...params) as unknown as DictionaryRow[];

  const items = rows.map(mapDictionaryRow);
  return {
    items,
    platforms: items.filter((item) => item.category === "platform"),
    markets: items.filter((item) => item.category === "market"),
    languages: items.filter((item) => item.category === "language")
  };
}

export interface UpsertDictionaryInput {
  category: DictionaryCategory;
  code: string;
  label: string;
  isActive?: boolean;
  position?: number;
}

export function upsertDictionaryItem(
  db: AppDatabase,
  actorUserId: string,
  input: UpsertDictionaryInput
): DictionaryRecord {
  const code = input.code.trim();
  const label = input.label.trim();
  if (!code || !label) {
    throw new AppError(400, "VALIDATION_ERROR", "字典编码与显示名称不能为空");
  }

  db.transaction(() => {
    const existing = db.raw
      .prepare("SELECT position FROM dictionaries WHERE category = ? AND code = ?")
      .get(input.category, code) as { position: number } | undefined;

    let position = input.position;
    if (position === undefined) {
      if (existing) {
        position = existing.position;
      } else {
        const maxRow = db.raw
          .prepare("SELECT COALESCE(MAX(position), 0) AS max_pos FROM dictionaries WHERE category = ?")
          .get(input.category) as { max_pos: number };
        position = Number(maxRow.max_pos) + 10;
      }
    }

    db.raw
      .prepare(
        `INSERT INTO dictionaries (category, code, label, is_active, position)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(category, code) DO UPDATE SET
           label = excluded.label,
           is_active = excluded.is_active,
           position = excluded.position`
      )
      .run(input.category, code, label, input.isActive === false ? 0 : 1, position);

    recordActivity(db, {
      actorUserId,
      action: "dictionary.upsert",
      objectType: "dictionary",
      objectId: `${input.category}:${code}`,
      details: { category: input.category, code, label, isActive: input.isActive !== false }
    });
  });

  const row = db.raw
    .prepare("SELECT category, code, label, is_active, position FROM dictionaries WHERE category = ? AND code = ?")
    .get(input.category, code) as unknown as DictionaryRow;
  return mapDictionaryRow(row);
}

export function updateDictionaryItem(
  db: AppDatabase,
  actorUserId: string,
  category: DictionaryCategory,
  code: string,
  input: { label?: string; isActive?: boolean; position?: number }
): DictionaryRecord {
  const existing = db.raw
    .prepare("SELECT category, code, label, is_active, position FROM dictionaries WHERE category = ? AND code = ?")
    .get(category, code) as unknown as DictionaryRow | undefined;
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "字典项不存在");
  }

  const nextLabel = input.label !== undefined ? input.label.trim() : existing.label;
  if (!nextLabel) {
    throw new AppError(400, "VALIDATION_ERROR", "字典显示名称不能为空");
  }
  const nextActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active;
  const nextPosition = input.position !== undefined ? input.position : existing.position;

  db.transaction(() => {
    db.raw
      .prepare(
        "UPDATE dictionaries SET label = ?, is_active = ?, position = ? WHERE category = ? AND code = ?"
      )
      .run(nextLabel, nextActive, nextPosition, category, code);
    recordActivity(db, {
      actorUserId,
      action: "dictionary.update",
      objectType: "dictionary",
      objectId: `${category}:${code}`,
      details: { label: nextLabel, isActive: nextActive === 1, position: nextPosition }
    });
  });

  return {
    category,
    code,
    label: nextLabel,
    isActive: nextActive === 1,
    position: nextPosition
  };
}
