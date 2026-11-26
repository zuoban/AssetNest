import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/database.js";
import { runMigrations } from "../../src/server/db/migrator.js";
import {
  acquireJobLock,
  cancelJob,
  enqueueJob,
  getJobById
} from "../../src/server/modules/jobs/service.js";
import { JobWorker } from "../../src/server/modules/jobs/worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-worker-"));
  tempDirs.push(dir);
  const db = openDatabase({ dbPath: path.join(dir, "test.db") });
  runMigrations(db);
  return db;
}

describe("Persistent JobWorker", () => {
  it("enforces concurrency cap, retries transient failures, supports cancel, and recovers expired leases", async () => {
    const db = createTempDb();
    try {
      const worker = new JobWorker(db, {
        concurrency: 2,
        pollIntervalMs: 50,
        retryBaseDelayMs: 40
      });

      let active = 0;
      let maxActive = 0;
      let transientAttempts = 0;

      worker.registerHandler("search_reindex", async (payload, ctx) => {
        if (payload.mode === "concurrency") {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 60));
          active -= 1;
          return { ok: true };
        }
        if (payload.mode === "transient") {
          transientAttempts += 1;
          if (transientAttempts === 1) {
            throw new Error("Simulated transient error");
          }
          return { recoveredOnAttempt: transientAttempts };
        }
        if (payload.mode === "cancellable") {
          for (let step = 0; step < 20; step += 1) {
            ctx.throwIfCancelled();
            await new Promise((r) => setTimeout(r, 20));
          }
          return { finished: true };
        }
        return { ok: true };
      });

      // 1. Concurrency cap test (enqueue 4 jobs with concurrency 2)
      const cJobs = [1, 2, 3, 4].map((idx) =>
        enqueueJob(db, { type: "search_reindex", payload: { mode: "concurrency", idx } })
      );
      await worker.waitForIdle();
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(maxActive).toBeGreaterThanOrEqual(1);
      for (const j of cJobs) {
        expect(getJobById(db, j.id).status).toBe("succeeded");
      }

      // 2. Retry with backoff on transient failure
      const tJob = enqueueJob(db, {
        type: "search_reindex",
        payload: { mode: "transient" },
        maxAttempts: 3
      });
      await worker.waitForIdle();
      // Wait slightly beyond backoff delay (40ms) then tick again
      await new Promise((r) => setTimeout(r, 80));
      await worker.waitForIdle();
      const tFinal = getJobById(db, tJob.id);
      expect(tFinal.status).toBe("succeeded");
      expect(tFinal.attempts).toBe(2);
      expect(tFinal.result).toEqual({ recoveredOnAttempt: 2 });

      // 3. Cooperative cancel of a queued job
      const queuedToCancel = enqueueJob(db, {
        type: "search_reindex",
        payload: { mode: "cancellable" }
      });
      // Insert a dummy admin user for activity log
      const now = new Date().toISOString();
      db.raw
        .prepare(
          "INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)"
        )
        .run("u1", "admin", "Admin", "hash", now, now);
      const cancelled = cancelJob(db, "u1", queuedToCancel.id);
      expect(cancelled.status).toBe("cancelled");

      // 4. Stale lease recovery on simulated crash
      const crashedJob = enqueueJob(db, {
        type: "search_reindex",
        payload: { mode: "recovered" }
      });
      const pastLease = new Date(Date.now() - 60_000).toISOString();
      db.raw
        .prepare(
          "UPDATE jobs SET status = 'running', lease_owner = 'dead-worker', lease_until = ? WHERE id = ?"
        )
        .run(pastLease, crashedJob.id);
      expect(acquireJobLock(db, "file:test-lock", crashedJob.id)).toBe(true);

      const recoveredCount = worker.recoverStaleJobs(false);
      expect(recoveredCount).toBe(1);
      const lockLeft = db.raw
        .prepare("SELECT COUNT(*) AS count FROM job_locks WHERE job_id = ?")
        .get(crashedJob.id) as { count: number };
      expect(Number(lockLeft.count)).toBe(0);

      await worker.waitForIdle();
      expect(getJobById(db, crashedJob.id).status).toBe("succeeded");
      await worker.stop();
    } finally {
      db.close();
    }
  });
});
