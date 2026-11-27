import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rebuildAssetSearchDocument } from "../modules/search/service.js";
import type { AppDatabase } from "./database.js";

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export function getDefaultMigrationsDir(): string {
  return path.resolve(import.meta.dirname, "migrations");
}

export function runMigrations(
  db: AppDatabase,
  migrationsDir: string = getDefaultMigrationsDir()
): AppliedMigration[] {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const parsedFiles = files.map((fileName) => {
    const version = Number(fileName.split("_")[0]);
    const sql = fs.readFileSync(path.join(migrationsDir, fileName), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    return { version, name: fileName, sql, checksum };
  });

  const existingRows = db.raw
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number; name: string; checksum: string; applied_at: string }>;

  const maxSupportedVersion = parsedFiles.reduce((max, item) => Math.max(max, item.version), 0);
  const maxAppliedVersion = existingRows.reduce((max, item) => Math.max(max, item.version), 0);

  if (maxAppliedVersion > maxSupportedVersion) {
    throw new Error(
      `数据库 Schema 版本（v${maxAppliedVersion}）高于当前程序支持的版本（v${maxSupportedVersion}），禁止降级启动`
    );
  }

  const existingByVersion = new Map(existingRows.map((row) => [row.version, row]));
  const newlyApplied: AppliedMigration[] = [];

  for (const migration of parsedFiles) {
    const already = existingByVersion.get(migration.version);
    if (already) {
      if (already.checksum !== migration.checksum) {
        throw new Error(
          `迁移脚本校验和不匹配: v${migration.version} (${migration.name}) 已被修改`
        );
      }
      continue;
    }

    const appliedAt = new Date().toISOString();
    db.transaction(() => {
      db.raw.exec(migration.sql);
      if (migration.name === "0007_remove_image_review_indexes.sql") {
        const affectedAssets = db.raw
          .prepare("SELECT DISTINCT asset_id FROM asset_versions WHERE review_note <> ''")
          .all() as Array<{ asset_id: string }>;
        for (const { asset_id } of affectedAssets) {
          rebuildAssetSearchDocument(db, asset_id);
        }
      }
      db.raw
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        )
        .run(migration.version, migration.name, migration.checksum, appliedAt);
    });
    newlyApplied.push({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      appliedAt
    });
  }

  return newlyApplied;
}

export function getCurrentSchemaVersion(db: AppDatabase): number {
  const row = db.raw
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return Number(row.version);
}
