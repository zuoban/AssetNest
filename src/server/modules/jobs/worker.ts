import crypto from "node:crypto";
import type { JobType } from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import {
  acquireJobLock,
  releaseAllJobLocks,
  releaseJobLock,
  type JobRow
} from "./service.js";

export class JobCancelledError extends Error {
  constructor(message = "任务已被取消") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

export interface JobProgressUpdate {
  stage?: string;
  current?: number;
  total?: number | null;
}

export interface JobContext {
  jobId: string;
  type: JobType;
  attempts: number;
  maxAttempts: number;
  signal: AbortSignal;
  isCancelled(): boolean;
  throwIfCancelled(): void;
  updateProgress(update: JobProgressUpdate): void;
  acquireLock(resourceKey: string): boolean;
  releaseLock(resourceKey: string): void;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: JobContext
) => Promise<Record<string, unknown> | void>;

export interface JobWorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  retryBaseDelayMs?: number;
  onError?: (err: unknown, jobId?: string) => void;
}

export class JobWorker {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly onError?: (err: unknown, jobId?: string) => void;

  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopping = false;

  constructor(
    private readonly db: AppDatabase,
    options: JobWorkerOptions = {}
  ) {
    this.workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 3_000;
    this.onError = options.onError;
  }

  public registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  public recoverStaleJobs(includeUnexpired = false): number {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const rows = (
        includeUnexpired
          ? this.db.raw
              .prepare("SELECT id FROM jobs WHERE status = 'running'")
              .all()
          : this.db.raw
              .prepare("SELECT id FROM jobs WHERE status = 'running' AND lease_until <= ?")
              .all(now)
      ) as Array<{ id: string }>;

      if (rows.length === 0) {
        return 0;
      }

      const delLock = this.db.raw.prepare("DELETE FROM job_locks WHERE job_id = ?");
      const resetJob = this.db.raw.prepare(
        `UPDATE jobs
         SET status = 'queued',
             lease_owner = NULL,
             lease_until = NULL,
             run_after = ?,
             progress_stage = 'recovered_after_restart',
             updated_at = ?
         WHERE id = ? AND status = 'running'`
      );

      for (const row of rows) {
        delLock.run(row.id);
        resetJob.run(now, now, row.id);
      }
      return rows.length;
    });
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    this.recoverStaleJobs(true);
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.wake();
  }

  public wake(): void {
    if (this.stopping) {
      return;
    }
    queueMicrotask(() => {
      void this.tick();
    });
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    if (this.activeJobs.size > 0) {
      await Promise.allSettled(Array.from(this.activeJobs.values()));
    }
  }

  public async waitForIdle(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.tick();
      if (this.activeJobs.size > 0) {
        await Promise.allSettled(Array.from(this.activeJobs.values()));
        continue;
      }
      const now = new Date().toISOString();
      const pending = this.db.raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM jobs
           WHERE status = 'queued' AND run_after <= ?`
        )
        .get(now) as { count: number };
      if (Number(pending.count) === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`JobWorker.waitForIdle 超时 (${timeoutMs}ms)`);
  }

  public async tick(): Promise<number> {
    if (this.stopping) {
      return 0;
    }
    try {
      this.recoverStaleJobs(false);
    } catch (err) {
      this.onError?.(err);
      return 0;
    }

    let claimedCount = 0;
    while (!this.stopping && this.activeJobs.size < this.concurrency) {
      const job = this.claimNextJob();
      if (!job) {
        break;
      }
      claimedCount += 1;
      const promise = this.executeJob(job).finally(() => {
        this.activeJobs.delete(job.id);
        this.abortControllers.delete(job.id);
        if (!this.stopping) {
          this.wake();
        }
      });
      this.activeJobs.set(job.id, promise);
    }
    return claimedCount;
  }

  private claimNextJob(): JobRow | null {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + this.leaseDurationMs).toISOString();

    return this.db.transaction(() => {
      const candidate = this.db.raw
        .prepare(
          `SELECT id, type, status, priority, payload_json, result_json,
                  progress_stage, progress_current, progress_total,
                  attempts, max_attempts, run_after, lease_owner, lease_until,
                  cancel_requested, last_error, created_at, updated_at, started_at, finished_at
           FROM jobs
           WHERE status = 'queued' AND run_after <= ?
           ORDER BY priority ASC, created_at ASC
           LIMIT 1`
        )
        .get(now) as JobRow | undefined;

      if (!candidate) {
        return null;
      }

      const res = this.db.raw
        .prepare(
          `UPDATE jobs
           SET status = 'running',
               attempts = attempts + 1,
               lease_owner = ?,
               lease_until = ?,
               started_at = COALESCE(started_at, ?),
               updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(this.workerId, leaseUntil, now, now, candidate.id);

      if (res.changes === 0) {
        return null;
      }

      return {
        ...candidate,
        status: "running",
        attempts: candidate.attempts + 1,
        lease_owner: this.workerId,
        lease_until: leaseUntil
      };
    });
  }

  private renewLease(jobId: string): void {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + this.leaseDurationMs).toISOString();
    try {
      this.db.raw
        .prepare(
          `UPDATE jobs
           SET lease_until = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`
        )
        .run(leaseUntil, now, jobId, this.workerId);
    } catch (err) {
      this.onError?.(err, jobId);
    }
  }

  private isCancelRequested(jobId: string): boolean {
    if (this.stopping) {
      return true;
    }
    try {
      const row = this.db.raw
        .prepare("SELECT cancel_requested FROM jobs WHERE id = ?")
        .get(jobId) as { cancel_requested: number } | undefined;
      return row?.cancel_requested === 1;
    } catch {
      return false;
    }
  }

  private async executeJob(job: JobRow): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);

    const heartbeat = setInterval(() => {
      this.renewLease(job.id);
      if (this.isCancelRequested(job.id)) {
        controller.abort();
      }
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      const handler = this.handlers.get(job.type);
      if (!handler) {
        throw new NonRetryableJobError(`未注册任务类型 "${job.type}" 的处理器`);
      }

      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      } catch {
        throw new NonRetryableJobError("任务载荷 JSON 解析失败");
      }

      const ctx: JobContext = {
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        signal: controller.signal,
        isCancelled: () => controller.signal.aborted || this.isCancelRequested(job.id),
        throwIfCancelled: () => {
          if (controller.signal.aborted || this.isCancelRequested(job.id)) {
            throw new JobCancelledError();
          }
        },
        updateProgress: (update) => {
          const now = new Date().toISOString();
          const parts: string[] = ["updated_at = ?"];
          const params: Array<string | number | null> = [now];
          if (update.stage !== undefined) {
            parts.push("progress_stage = ?");
            params.push(update.stage);
          }
          if (update.current !== undefined) {
            parts.push("progress_current = ?");
            params.push(update.current);
          }
          if (update.total !== undefined) {
            parts.push("progress_total = ?");
            params.push(update.total);
          }
          params.push(job.id);
          this.db.raw
            .prepare(`UPDATE jobs SET ${parts.join(", ")} WHERE id = ?`)
            .run(...params);
        },
        acquireLock: (resourceKey) => acquireJobLock(this.db, resourceKey, job.id),
        releaseLock: (resourceKey) => releaseJobLock(this.db, resourceKey, job.id)
      };

      ctx.throwIfCancelled();
      const result = await handler(payload, ctx);

      const now = new Date().toISOString();
      this.db.transaction(() => {
        releaseAllJobLocks(this.db, job.id);
        this.db.raw
          .prepare(
            `UPDATE jobs
             SET status = 'succeeded',
                 result_json = ?,
                 progress_stage = 'completed',
                 lease_owner = NULL,
                 lease_until = NULL,
                 last_error = NULL,
                 finished_at = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(result ? JSON.stringify(result) : null, now, now, job.id);
      });
    } catch (err) {
      const now = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof JobCancelledError || this.isCancelRequested(job.id)) {
        // If shutdown aborted the job (not explicit user cancel), leave it queued to resume on next boot
        const dbRow = this.db.raw
          .prepare("SELECT cancel_requested FROM jobs WHERE id = ?")
          .get(job.id) as { cancel_requested: number } | undefined;
        const userCancelled = dbRow?.cancel_requested === 1;

        this.db.transaction(() => {
          releaseAllJobLocks(this.db, job.id);
          if (userCancelled) {
            this.db.raw
              .prepare(
                `UPDATE jobs
                 SET status = 'cancelled',
                     progress_stage = 'cancelled',
                     lease_owner = NULL,
                     lease_until = NULL,
                     last_error = ?,
                     finished_at = ?,
                     updated_at = ?
                 WHERE id = ?`
              )
              .run(message, now, now, job.id);
          } else {
            this.db.raw
              .prepare(
                `UPDATE jobs
                 SET status = 'queued',
                     attempts = MAX(0, attempts - 1),
                     progress_stage = 'paused_for_shutdown',
                     lease_owner = NULL,
                     lease_until = NULL,
                     run_after = ?,
                     updated_at = ?
                 WHERE id = ?`
              )
              .run(now, now, job.id);
          }
        });
        return;
      }

      this.onError?.(err, job.id);
      const canRetry = !(err instanceof NonRetryableJobError) && job.attempts < job.max_attempts;

      this.db.transaction(() => {
        releaseAllJobLocks(this.db, job.id);
        if (canRetry) {
          const delayMs = Math.min(
            60_000,
            this.retryBaseDelayMs * Math.pow(2, Math.max(0, job.attempts - 1))
          );
          const runAfter = new Date(Date.now() + delayMs).toISOString();
          this.db.raw
            .prepare(
              `UPDATE jobs
               SET status = 'queued',
                   progress_stage = 'waiting_retry',
                   lease_owner = NULL,
                   lease_until = NULL,
                   run_after = ?,
                   last_error = ?,
                   updated_at = ?
               WHERE id = ?`
            )
            .run(runAfter, message, now, job.id);
        } else {
          this.db.raw
            .prepare(
              `UPDATE jobs
               SET status = 'failed',
                   progress_stage = 'failed',
                   lease_owner = NULL,
                   lease_until = NULL,
                   last_error = ?,
                   finished_at = ?,
                   updated_at = ?
               WHERE id = ?`
            )
            .run(message, now, now, job.id);
        }
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
