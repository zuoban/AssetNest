import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/database.js";
import { getCurrentSchemaVersion, getDefaultMigrationsDir, runMigrations } from "../../src/server/db/migrator.js";
import { getProductDetail } from "../../src/server/modules/products/service.js";
import { upsertSearchDocument } from "../../src/server/modules/search/service.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-db-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SQLite database & migrator", () => {
  it("removes legacy review notes from search while preserving the original records", () => {
    const dir = makeTempDir();
    const previousMigrationsDir = path.join(dir, "previous-migrations");
    fs.mkdirSync(previousMigrationsDir);
    const migrationsDir = getDefaultMigrationsDir();
    for (const file of fs.readdirSync(migrationsDir).filter((name) => /^000[1-6]_.*\.sql$/.test(name))) {
      fs.copyFileSync(path.join(migrationsDir, file), path.join(previousMigrationsDir, file));
    }
    const db = openDatabase({ dbPath: path.join(dir, "assetnest.db"), wal: true, acquireInstanceLock: true });

    try {
      runMigrations(db, previousMigrationsDir);
      db.raw.exec(`
        INSERT INTO storage_providers (id, name, type, config_ref, created_at, updated_at)
        VALUES ('local', 'Local', 'local', 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO files (id, storage_id, object_key, sha256, size_bytes, mime_type, created_at, updated_at)
        VALUES ('file', 'local', 'file.png', 'hash', 1, 'image/png', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO assets (id, name, original_filename, asset_type, created_at, updated_at)
        VALUES ('asset', 'Blue bottle', 'file.png', 'image', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO asset_versions (
          id, asset_id, file_id, version_no, original_filename, review_status, review_note, created_at
        ) VALUES ('version', 'asset', 'file', 1, 'file.png', 'rejected', 'legacyreviewword', CURRENT_TIMESTAMP);
      `);
      upsertSearchDocument(db, "asset", "asset", "Blue bottle legacyreviewword");

      runMigrations(db);

      expect(db.raw.prepare("SELECT review_status, review_note FROM asset_versions WHERE id = 'version'").get())
        .toEqual({ review_status: "rejected", review_note: "legacyreviewword" });
      const document = db.raw.prepare("SELECT search_text FROM search_documents WHERE entity_id = 'asset'").get();
      expect(document?.search_text).toContain("Blue bottle");
      expect(document?.search_text).not.toContain("legacyreviewword");
      const match = db.raw.prepare("SELECT entity_id FROM search_fts WHERE search_fts MATCH ?");
      expect(match.all("legacyreviewword")).toEqual([]);
      expect(match.all("bottle")).toEqual([{ entity_id: "asset" }]);
    } finally {
      db.close();
    }
  });

  it("upgrades a v7 database with existing products and leaves new cost fields empty", () => {
    const dir = makeTempDir();
    const previousMigrationsDir = path.join(dir, "previous-migrations");
    fs.mkdirSync(previousMigrationsDir);
    const migrationsDir = getDefaultMigrationsDir();
    for (const file of fs.readdirSync(migrationsDir).filter((name) => /^000[1-7]_.*\.sql$/.test(name))) {
      fs.copyFileSync(path.join(migrationsDir, file), path.join(previousMigrationsDir, file));
    }
    const db = openDatabase({ dbPath: path.join(dir, "assetnest.db") });

    try {
      runMigrations(db, previousMigrationsDir);
      db.raw.exec(`
        INSERT INTO products (id, spu, name_zh, created_at, updated_at)
        VALUES ('old', 'OLD-SPU', '旧商品', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO product_specs (id, product_id, spec_key, spec_value)
        VALUES ('old-spec', 'old', '材质', '不锈钢');
      `);

      expect(runMigrations(db).map(({ name }) => name)).toContain("0008_product_costs.sql");
      expect(getProductDetail(db, "old")).toMatchObject({
        spu: "OLD-SPU", nameZh: "旧商品",
        specs: [expect.objectContaining({ specKey: "材质", specValue: "不锈钢" })],
        purchasePrice: null, cartonLengthCm: null, cartonWidthCm: null, cartonHeightCm: null,
        unitsPerCarton: null, seaFreightRate: null
      });
    } finally {
      db.close();
    }
  });

  it("enables WAL and foreign_keys, applies migrations idempotently, and blocks downgrades", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "assetnest.db");
    const db = openDatabase({ dbPath, wal: true, acquireInstanceLock: true });

    try {
      const journal = db.raw.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
      const fk = db.raw.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number };
      expect(journal.journal_mode.toLowerCase()).toBe("wal");
      expect(fk.foreign_keys).toBe(1);

      const first = runMigrations(db);
      expect(first.length).toBeGreaterThanOrEqual(2);
      expect(getCurrentSchemaVersion(db)).toBe(first.length);

      const second = runMigrations(db);
      expect(second.length).toBe(0);

      expect(() => {
        db.raw
          .prepare(
            `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
             VALUES ('s1', 'missing-user', 'hash', '2099-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
          )
          .run();
      }).toThrow(/FOREIGN KEY/i);

      db.raw
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, '999_future.sql', 'abc', '2026-01-01T00:00:00Z')"
        )
        .run();
      expect(() => runMigrations(db)).toThrow(/禁止降级启动/);
    } finally {
      db.close();
    }
  });
});
