import crypto from "node:crypto";
import type { AppDatabase } from "../../db/database.js";

const REDACTED_KEYS = new Set([
  "password",
  "passwordhash",
  "secret",
  "secretaccesskey",
  "accesskeyid",
  "sessiontoken",
  "token",
  "tokenhash",
  "cookie",
  "authorization",
  "signedurl",
  "presignedurl"
]);

export function redactDetails(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => redactDetails(item));
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[_-]/g, "");
      if (REDACTED_KEYS.has(normalized)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactDetails(value);
      }
    }
    return out;
  }
  return input;
}

export interface RecordActivityInput {
  actorUserId?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  details?: Record<string, unknown>;
}

export function recordActivity(db: AppDatabase, input: RecordActivityInput): void {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeDetails = redactDetails(input.details ?? {});
  db.raw
    .prepare(
      `INSERT INTO activity_events (id, actor_user_id, action, object_type, object_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.actorUserId ?? null,
      input.action,
      input.objectType,
      input.objectId ?? null,
      JSON.stringify(safeDetails),
      createdAt
    );
}
