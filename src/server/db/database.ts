import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AppDatabase {
  readonly path: string;
  readonly raw: DatabaseSync;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  dbPath: string;
  wal?: boolean;
  acquireInstanceLock?: boolean;
}

function acquireLockFile(lockPath: string): number {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    return fd;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const pid = Number(raw.split("\n")[0]?.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, 0);
            throw new Error(
              `检测到另一个 AssetNest 实例（PID ${pid}）正在使用数据库目录，禁止多实例共享同一 SQLite 写入卷`
            );
          } catch (killErr) {
            const killCode = (killErr as NodeJS.ErrnoException).code;
            if (killCode !== "ESRCH") {
              throw killErr;
            }
          }
        }
      } catch (readErr) {
        if (readErr instanceof Error && readErr.message.includes("检测到另一个 AssetNest 实例")) {
          throw readErr;
        }
      }
      fs.rmSync(lockPath, { force: true });
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return fd;
    }
    throw err;
  }
}

export function openDatabase(options: OpenDatabaseOptions): AppDatabase {
  const { dbPath, wal = true, acquireInstanceLock = false } = options;

  let lockFd: number | null = null;
  let lockPath: string | null = null;

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (acquireInstanceLock) {
      lockPath = path.join(path.dirname(dbPath), ".instance.lock");
      lockFd = acquireLockFile(lockPath);
    }
  }

  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec("PRAGMA synchronous = FULL;");
  if (wal && dbPath !== ":memory:") {
    raw.exec("PRAGMA journal_mode = WAL;");
  }

  let txDepth = 0;
  let closed = false;

  return {
    path: dbPath,
    raw,
    transaction<T>(fn: () => T): T {
      if (txDepth === 0) {
        raw.exec("BEGIN IMMEDIATE;");
        txDepth = 1;
        try {
          const result = fn();
          raw.exec("COMMIT;");
          txDepth = 0;
          return result;
        } catch (err) {
          txDepth = 0;
          try {
            raw.exec("ROLLBACK;");
          } catch {
            // ignore secondary rollback error
          }
          throw err;
        }
      }
      const spName = `sp_${txDepth}`;
      raw.exec(`SAVEPOINT ${spName};`);
      txDepth += 1;
      try {
        const result = fn();
        raw.exec(`RELEASE SAVEPOINT ${spName};`);
        txDepth -= 1;
        return result;
      } catch (err) {
        txDepth -= 1;
        try {
          raw.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
          raw.exec(`RELEASE SAVEPOINT ${spName};`);
        } catch {
          // ignore
        }
        throw err;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        if (wal && dbPath !== ":memory:") {
          raw.exec("PRAGMA wal_checkpoint(PASSIVE);");
        }
      } catch {
        // best-effort checkpoint on shutdown
      } finally {
        raw.close();
        if (lockFd !== null) {
          try {
            fs.closeSync(lockFd);
          } catch {
            // ignore
          }
          if (lockPath) {
            fs.rmSync(lockPath, { force: true });
          }
        }
      }
    }
  };
}
