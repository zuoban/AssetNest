import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/database.js";
import { getCurrentSchemaVersion, runMigrations } from "../../src/server/db/migrator.js";

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
