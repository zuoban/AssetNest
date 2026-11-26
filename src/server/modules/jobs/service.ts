import crypto from "node:crypto";
import type { JobRecord, JobStatus, JobType } from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";

export interface EnqueueJobInput {
  type: JobType;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  progressStage?: string | null;
  progressTotal?: number | null;
  runAfter?: string;
}

export interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload_json: string;
  result_json: string | null;
  progress_stage: string | null;
  progress_current: number;
  progress_total: number | null;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_until: string | null;
  cancel_requested: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function mapJobRow(row: JobRow): JobRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  let result: Record<string, unknown> | null = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json) as Record<string, unknown>;
    } catch {
      result = null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    progressStage: row.progress_stage,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    cancelRequested: row.cancel_requested === 1,
    lastError: row.last_error,
    payload,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export function enqueueJob(db: AppDatabase, input: EnqueueJobInput): JobRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const runAfter = input.runAfter ?? now;
  const priority = input.priority ?? 100;
  const maxAttempts = input.maxAttempts ?? 3;

  db.raw
    .prepare(
      `INSERT INTO jobs (
         id, type, status, priority, payload_json, progress_stage,
         progress_current, progress_total, attempts, max_attempts,
         run_after, cancel_requested, created_at, updated_at
       ) VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, 0, ?, ?, 0, ?, ?)`
    )
    .run(
      id,
      input.type,
      priority,
      JSON.stringify(input.payload),
      input.progressStage ?? "queued",
      input.progressTotal ?? null,
      maxAttempts,
      runAfter,
      now,
      now
    );

  return getJobById(db, id);
}

export function getJobById(db: AppDatabase, jobId: string): JobRecord {
  const row = db.raw
    .prepare(
      `SELECT id, type, status, priority, payload_json, result_json,
              progress_stage, progress_current, progress_total,
              attempts, max_attempts, run_after, lease_owner, lease_until,
              cancel_requested, last_error, created_at, updated_at, started_at, finished_at
       FROM jobs
       WHERE id = ?`
    )
    .get(jobId) as JobRow | undefined;

  if (!row) {
    throw new AppError(404, "NOT_FOUND", "指定的后台任务不存在");
  }
  return mapJobRow(row);
}

export function retryJob(db: AppDatabase, actorUserId: string, jobId: string): JobRecord {
  const now = new Date().toISOString();

  db.transaction(() => {
    const existing = db.raw
      .prepare("SELECT id, type, status FROM jobs WHERE id = ?")
      .get(jobId) as { id: string; type: JobType; status: JobStatus } | undefined;

    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "指定的后台任务不存在");
    }
    if (existing.status !== "failed" && existing.status !== "cancelled") {
      throw new AppError(
        409,
        "CONFLICT",
        `仅失败或已取消的任务支持重试（当前状态：${existing.status}）`
      );
    }

    db.raw.prepare("DELETE FROM job_locks WHERE job_id = ?").run(jobId);
    db.raw
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             attempts = 0,
             cancel_requested = 0,
             lease_owner = NULL,
             lease_until = NULL,
             last_error = NULL,
             run_after = ?,
             finished_at = NULL,
             progress_stage = 'retrying',
             updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, jobId);

    recordActivity(db, {
      actorUserId,
      action: "job.retry",
      objectType: "job",
      objectId: jobId,
      details: { type: existing.type }
    });
  });

  return getJobById(db, jobId);
}

export function cancelJob(db: AppDatabase, actorUserId: string, jobId: string): JobRecord {
  const now = new Date().toISOString();

  db.transaction(() => {
    const existing = db.raw
      .prepare("SELECT id, type, status FROM jobs WHERE id = ?")
      .get(jobId) as { id: string; type: JobType; status: JobStatus } | undefined;

    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "指定的后台任务不存在");
    }
    if (existing.status === "queued") {
      db.raw
        .prepare(
          `UPDATE jobs
           SET status = 'cancelled',
               cancel_requested = 1,
               progress_stage = 'cancelled',
               finished_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(now, now, jobId);
    } else if (existing.status === "running") {
      db.raw
        .prepare(
          `UPDATE jobs
           SET cancel_requested = 1,
               progress_stage = 'cancelling',
               updated_at = ?
           WHERE id = ?`
        )
        .run(now, jobId);
    } else {
      throw new AppError(
        409,
        "CONFLICT",
        `仅排队中或运行中的任务支持取消（当前状态：${existing.status}）`
      );
    }

    recordActivity(db, {
      actorUserId,
      action: "job.cancel",
      objectType: "job",
      objectId: jobId,
      details: { type: existing.type, previousStatus: existing.status }
    });
  });

  return getJobById(db, jobId);
}

export function acquireJobLock(db: AppDatabase, resourceKey: string, jobId: string): boolean {
  const now = new Date().toISOString();
  const res = db.raw
    .prepare(
      `INSERT OR IGNORE INTO job_locks (resource_key, job_id, acquired_at)
       VALUES (?, ?, ?)`
    )
    .run(resourceKey, jobId, now);
  if (res.changes > 0) {
    return true;
  }
  const owner = db.raw
    .prepare("SELECT job_id FROM job_locks WHERE resource_key = ?")
    .get(resourceKey) as { job_id: string } | undefined;
  return owner?.job_id === jobId;
}

export function releaseJobLock(db: AppDatabase, resourceKey: string, jobId: string): void {
  db.raw
    .prepare("DELETE FROM job_locks WHERE resource_key = ? AND job_id = ?")
    .run(resourceKey, jobId);
}

export function releaseAllJobLocks(db: AppDatabase, jobId: string): void {
  db.raw.prepare("DELETE FROM job_locks WHERE job_id = ?").run(jobId);
}
