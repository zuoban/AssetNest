import crypto from "node:crypto";
import type { FolderRecord, TagDimension, TagRecord } from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { rebuildAssetSearchDocument } from "../search/service.js";
import { recordActivity } from "../system/activity.js";

interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  asset_count: number;
  created_at: string;
  updated_at: string;
}

interface TagRow {
  id: string;
  dimension: TagDimension;
  parent_id: string | null;
  name: string;
  is_system: number;
  asset_count: number;
  created_at: string;
  updated_at: string;
}

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && err.message.toUpperCase().includes("UNIQUE");
}

export function listFolders(db: AppDatabase): FolderRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.position, f.created_at, f.updated_at,
              (SELECT COUNT(*) FROM assets a WHERE a.folder_id = f.id AND a.deleted_at IS NULL) AS asset_count
       FROM folders f
       ORDER BY f.position ASC, f.name ASC`
    )
    .all() as unknown as FolderRow[];

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    position: row.position,
    assetCount: Number(row.asset_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function createFolder(
  db: AppDatabase,
  actorUserId: string,
  input: { name: string; parentId?: string | null; position?: number }
): FolderRecord {
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = db.raw.prepare("SELECT id FROM folders WHERE id = ?").get(parentId);
    if (!parent) {
      throw new AppError(404, "NOT_FOUND", "上级目录不存在");
    }
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      db.raw
        .prepare(
          `INSERT INTO folders (id, parent_id, name, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, parentId, input.name.trim(), input.position ?? 0, now, now);

      recordActivity(db, {
        actorUserId,
        action: "folder.create",
        objectType: "folder",
        objectId: id,
        details: { name: input.name.trim(), parentId }
      });
    });
  } catch (err) {
    if (isUniqueError(err)) {
      throw new AppError(409, "CONFLICT", `同级目录 "${input.name.trim()}" 已存在`);
    }
    throw err;
  }

  return {
    id,
    parentId,
    name: input.name.trim(),
    position: input.position ?? 0,
    assetCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function updateFolder(
  db: AppDatabase,
  actorUserId: string,
  folderId: string,
  input: { name?: string; parentId?: string | null; position?: number }
): FolderRecord {
  const existing = db.raw
    .prepare("SELECT id, parent_id, name, position FROM folders WHERE id = ?")
    .get(folderId) as { id: string; parent_id: string | null; name: string; position: number } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "目录不存在");
  }

  const nextParentId = input.parentId !== undefined ? input.parentId : existing.parent_id;
  if (nextParentId === folderId) {
    throw new AppError(400, "VALIDATION_ERROR", "目录不能设置为自己的上级目录");
  }

  // Check circular ancestry
  if (nextParentId) {
    let cursor: string | null = nextParentId;
    while (cursor) {
      if (cursor === folderId) {
        throw new AppError(400, "VALIDATION_ERROR", "目录层级不能形成循环嵌套");
      }
      const parentRow = db.raw
        .prepare("SELECT parent_id FROM folders WHERE id = ?")
        .get(cursor) as { parent_id: string | null } | undefined;
      if (!parentRow) {
        throw new AppError(404, "NOT_FOUND", "指定的上级目录不存在");
      }
      cursor = parentRow.parent_id;
    }
  }

  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.raw
        .prepare(
          `UPDATE folders
           SET name = ?, parent_id = ?, position = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name !== undefined ? input.name.trim() : existing.name,
          nextParentId,
          input.position !== undefined ? input.position : existing.position,
          now,
          folderId
        );

      const linkedAssets = db.raw
        .prepare("SELECT id FROM assets WHERE folder_id = ? AND deleted_at IS NULL")
        .all(folderId) as Array<{ id: string }>;
      for (const item of linkedAssets) {
        rebuildAssetSearchDocument(db, item.id);
      }

      recordActivity(db, {
        actorUserId,
        action: "folder.update",
        objectType: "folder",
        objectId: folderId,
        details: { name: input.name?.trim(), parentId: nextParentId }
      });
    });
  } catch (err) {
    if (isUniqueError(err)) {
      throw new AppError(409, "CONFLICT", "目标层级下已存在同名目录");
    }
    throw err;
  }

  return listFolders(db).find((item) => item.id === folderId)!;
}

export function deleteFolder(
  db: AppDatabase,
  actorUserId: string,
  folderId: string
): { deleted: boolean; id: string } {
  const existing = db.raw
    .prepare("SELECT id, name FROM folders WHERE id = ?")
    .get(folderId) as { id: string; name: string } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "目录不存在");
  }

  const childCount = (
    db.raw.prepare("SELECT COUNT(*) AS count FROM folders WHERE parent_id = ?").get(folderId) as {
      count: number;
    }
  ).count;

  if (childCount > 0) {
    throw new AppError(409, "CONFLICT", "该目录下仍存在子目录，请先移除或删除子目录");
  }

  db.transaction(() => {
    const affectedAssets = db.raw
      .prepare("SELECT id FROM assets WHERE folder_id = ?")
      .all(folderId) as Array<{ id: string }>;
    db.raw.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
    for (const item of affectedAssets) {
      rebuildAssetSearchDocument(db, item.id);
    }
    recordActivity(db, {
      actorUserId,
      action: "folder.delete",
      objectType: "folder",
      objectId: folderId,
      details: { name: existing.name }
    });
  });

  return { deleted: true, id: folderId };
}

export function listTags(db: AppDatabase, dimension?: TagDimension): TagRecord[] {
  const whereSql = dimension ? "WHERE t.dimension = ?" : "";
  const params = dimension ? [dimension] : [];
  const rows = db.raw
    .prepare(
      `SELECT t.id, t.dimension, t.parent_id, t.name, t.is_system, t.created_at, t.updated_at,
              (SELECT COUNT(*)
               FROM asset_tags at
               JOIN assets a ON a.id = at.asset_id
               WHERE at.tag_id = t.id AND a.deleted_at IS NULL) AS asset_count
       FROM tags t
       ${whereSql}
       ORDER BY t.dimension ASC, t.is_system DESC, t.name ASC`
    )
    .all(...params) as unknown as TagRow[];

  return rows.map((row) => ({
    id: row.id,
    dimension: row.dimension,
    parentId: row.parent_id,
    name: row.name,
    isSystem: row.is_system === 1,
    assetCount: Number(row.asset_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function createTag(
  db: AppDatabase,
  actorUserId: string,
  input: { dimension: TagDimension; name: string; parentId?: string | null }
): TagRecord {
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = db.raw
      .prepare("SELECT id, dimension FROM tags WHERE id = ?")
      .get(parentId) as { id: string; dimension: TagDimension } | undefined;
    if (!parent) {
      throw new AppError(404, "NOT_FOUND", "上级标签不存在");
    }
    if (parent.dimension !== input.dimension) {
      throw new AppError(400, "VALIDATION_ERROR", "子标签维度必须与上级标签一致");
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      db.raw
        .prepare(
          `INSERT INTO tags (id, dimension, parent_id, name, is_system, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(id, input.dimension, parentId, input.name.trim(), now, now);

      recordActivity(db, {
        actorUserId,
        action: "tag.create",
        objectType: "tag",
        objectId: id,
        details: { dimension: input.dimension, name: input.name.trim() }
      });
    });
  } catch (err) {
    if (isUniqueError(err)) {
      throw new AppError(409, "CONFLICT", `标签 "${input.name.trim()}" 在当前维度下已存在`);
    }
    throw err;
  }

  return {
    id,
    dimension: input.dimension,
    parentId,
    name: input.name.trim(),
    isSystem: false,
    assetCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function updateTag(
  db: AppDatabase,
  actorUserId: string,
  tagId: string,
  input: { name?: string; parentId?: string | null }
): TagRecord {
  const existing = db.raw
    .prepare("SELECT id, dimension, parent_id, name FROM tags WHERE id = ?")
    .get(tagId) as { id: string; dimension: TagDimension; parent_id: string | null; name: string } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "标签不存在");
  }

  const nextParentId = input.parentId !== undefined ? input.parentId : existing.parent_id;
  if (nextParentId === tagId) {
    throw new AppError(400, "VALIDATION_ERROR", "标签不能设置为自身上级");
  }

  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.raw
        .prepare("UPDATE tags SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?")
        .run(
          input.name !== undefined ? input.name.trim() : existing.name,
          nextParentId,
          now,
          tagId
        );

      const linkedAssets = db.raw
        .prepare("SELECT asset_id FROM asset_tags WHERE tag_id = ?")
        .all(tagId) as Array<{ asset_id: string }>;
      for (const item of linkedAssets) {
        rebuildAssetSearchDocument(db, item.asset_id);
      }

      recordActivity(db, {
        actorUserId,
        action: "tag.update",
        objectType: "tag",
        objectId: tagId,
        details: { name: input.name?.trim() }
      });
    });
  } catch (err) {
    if (isUniqueError(err)) {
      throw new AppError(409, "CONFLICT", "当前维度下已存在同名标签");
    }
    throw err;
  }

  return listTags(db).find((item) => item.id === tagId)!;
}

export function deleteTag(
  db: AppDatabase,
  actorUserId: string,
  tagId: string
): { deleted: boolean; id: string } {
  const existing = db.raw
    .prepare("SELECT id, name, dimension FROM tags WHERE id = ?")
    .get(tagId) as { id: string; name: string; dimension: string } | undefined;

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "标签不存在");
  }

  const childCount = (
    db.raw.prepare("SELECT COUNT(*) AS count FROM tags WHERE parent_id = ?").get(tagId) as {
      count: number;
    }
  ).count;

  if (childCount > 0) {
    throw new AppError(409, "CONFLICT", "该标签下存在子标签，请先移除子标签");
  }

  db.transaction(() => {
    const linkedAssets = db.raw
      .prepare("SELECT asset_id FROM asset_tags WHERE tag_id = ?")
      .all(tagId) as Array<{ asset_id: string }>;
    db.raw.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
    for (const item of linkedAssets) {
      rebuildAssetSearchDocument(db, item.asset_id);
    }
    recordActivity(db, {
      actorUserId,
      action: "tag.delete",
      objectType: "tag",
      objectId: tagId,
      details: { name: existing.name, dimension: existing.dimension }
    });
  });

  return { deleted: true, id: tagId };
}
