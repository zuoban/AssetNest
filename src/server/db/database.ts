import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AppDatabase {
  readonly path: string;
  readonly raw: DatabaseSync;
  transaction<T>(fn: () => T): T;
  replaceFileAndReopen(stagedDbPath: string): void;
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

  function openConfiguredHandle(): DatabaseSync {
    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA foreign_keys = ON;");
    handle.exec("PRAGMA busy_timeout = 5000;");
    handle.exec("PRAGMA synchronous = FULL;");
    if (wal && dbPath !== ":memory:") {
      handle.exec("PRAGMA journal_mode = WAL;");
    }
    return handle;
  }

  let currentRaw = openConfiguredHandle();

  let txDepth = 0;
  let closed = false;

  return {
    path: dbPath,
    get raw(): DatabaseSync {
      return currentRaw;
    },
    transaction<T>(fn: () => T): T {
      if (txDepth === 0) {
        currentRaw.exec("BEGIN IMMEDIATE;");
        txDepth = 1;
        try {
          const result = fn();
          currentRaw.exec("COMMIT;");
          txDepth = 0;
          return result;
        } catch (err) {
          txDepth = 0;
          try {
            currentRaw.exec("ROLLBACK;");
          } catch {
            // ignore secondary rollback error
          }
          throw err;
        }
      }
      const spName = `sp_${txDepth}`;
      currentRaw.exec(`SAVEPOINT ${spName};`);
      txDepth += 1;
      try {
        const result = fn();
        currentRaw.exec(`RELEASE SAVEPOINT ${spName};`);
        txDepth -= 1;
        return result;
      } catch (err) {
        txDepth -= 1;
        try {
          currentRaw.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
          currentRaw.exec(`RELEASE SAVEPOINT ${spName};`);
        } catch {
          // ignore
        }
        throw err;
      }
    },
    replaceFileAndReopen(stagedDbPath: string): void {
      if (closed) {
        throw new Error("数据库已关闭，无法执行原子替换");
      }
      if (dbPath === ":memory:") {
        throw new Error("内存数据库不支持文件原子替换恢复");
      }
      if (txDepth > 0) {
        throw new Error("当前存在未提交事务，禁止切换数据库文件");
      }
      if (!fs.existsSync(stagedDbPath)) {
        throw new Error(`暂存数据库文件不存在: ${stagedDbPath}`);
      }

      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      const backupBase = `${dbPath}.pre-restore`;
      const backupWal = `${backupBase}-wal`;
      const backupShm = `${backupBase}-shm`;

      try {
        if (wal) {
          currentRaw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        }
      } catch {
        // best-effort checkpoint before close
      }
      currentRaw.close();

      fs.rmSync(backupBase, { force: true });
      fs.rmSync(backupWal, { force: true });
      fs.rmSync(backupShm, { force: true });

      if (fs.existsSync(dbPath)) {
        fs.renameSync(dbPath, backupBase);
      }
      if (fs.existsSync(walPath)) {
        fs.renameSync(walPath, backupWal);
      }
      if (fs.existsSync(shmPath)) {
        fs.renameSync(shmPath, backupShm);
      }

      try {
        fs.copyFileSync(stagedDbPath, dbPath);
        fs.rmSync(walPath, { force: true });
        fs.rmSync(shmPath, { force: true });

        const reopened = openConfiguredHandle();
        const check = reopened.prepare("PRAGMA integrity_check;").get() as
          | { integrity_check: string }
          | undefined;
        if (!check || check.integrity_check !== "ok") {
          reopened.close();
          throw new Error("替换后的数据库完整性检查失败");
        }
        currentRaw = reopened;

        fs.rmSync(backupBase, { force: true });
        fs.rmSync(backupWal, { force: true });
        fs.rmSync(backupShm, { force: true });
      } catch (err) {
        fs.rmSync(dbPath, { force: true });
        fs.rmSync(walPath, { force: true });
        fs.rmSync(shmPath, { force: true });
        if (fs.existsSync(backupBase)) {
          fs.renameSync(backupBase, dbPath);
        }
        if (fs.existsSync(backupWal)) {
          fs.renameSync(backupWal, walPath);
        }
        if (fs.existsSync(backupShm)) {
          fs.renameSync(backupShm, shmPath);
        }
        currentRaw = openConfiguredHandle();
        throw err;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        if (wal && dbPath !== ":memory:") {
          currentRaw.exec("PRAGMA wal_checkpoint(PASSIVE);");
        }
      } catch {
        // best-effort checkpoint on shutdown
      } finally {
        currentRaw.close();
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
