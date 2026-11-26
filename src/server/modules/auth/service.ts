import crypto from "node:crypto";
import type { UserProfile } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";
import { generateSessionToken, hashSessionToken, verifyAccessCode } from "./password.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SYSTEM_USER_ID = "system-admin";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: "admin";
  created_at: string;
}

export function isAuthEnabled(config: ResolvedAppConfig): boolean {
  return config.app.accessCode !== null && config.app.accessCode.length > 0;
}

export function ensureSystemUser(db: AppDatabase): UserProfile {
  const existing = db.raw
    .prepare(
      "SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at ASC LIMIT 1"
    )
    .get() as UserRow | undefined;

  if (existing) {
    const now = new Date().toISOString();
    db.raw
      .prepare("INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('initialized_at', ?, ?)")
      .run(JSON.stringify(existing.created_at || now), now);

    return {
      id: existing.id,
      username: existing.username,
      displayName: existing.display_name,
      role: existing.role,
      createdAt: existing.created_at
    };
  }

  const now = new Date().toISOString();
  return db.transaction(() => {
    const recheck = db.raw
      .prepare(
        "SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at ASC LIMIT 1"
      )
      .get() as UserRow | undefined;
    if (recheck) {
      return {
        id: recheck.id,
        username: recheck.username,
        displayName: recheck.display_name,
        role: recheck.role,
        createdAt: recheck.created_at
      };
    }

    db.raw
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', ?, ?)`
      )
      .run(SYSTEM_USER_ID, "admin", "管理员", "access_code_managed", now, now);

    db.raw
      .prepare(
        "INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('initialized_at', ?, ?)"
      )
      .run(JSON.stringify(now), now);

    return {
      id: SYSTEM_USER_ID,
      username: "admin",
      displayName: "管理员",
      role: "admin",
      createdAt: now
    };
  });
}

export interface AccessCodeLoginInput {
  accessCode: string;
  userAgent?: string;
  ipAddress?: string;
}

export function loginWithAccessCode(
  db: AppDatabase,
  config: ResolvedAppConfig,
  input: AccessCodeLoginInput
): { user: UserProfile; rawToken: string; expiresAt: string } {
  const configuredCode = config.app.accessCode;
  if (!configuredCode) {
    throw new AppError(409, "CONFLICT", "当前未配置访问码，无需登录");
  }

  const valid = verifyAccessCode(input.accessCode, configuredCode);
  if (!valid) {
    recordActivity(db, {
      actorUserId: null,
      action: "auth.login_failed",
      objectType: "auth",
      objectId: null,
      details: { ipAddress: input.ipAddress ?? "unknown" }
    });
    throw new AppError(401, "UNAUTHORIZED", "访问码不正确");
  }

  const user = ensureSystemUser(db);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const sessionId = crypto.randomUUID();
  const { rawToken, tokenHash } = generateSessionToken(configuredCode);

  db.transaction(() => {
    db.raw.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.raw
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_address, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        user.id,
        tokenHash,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        expiresAt,
        now,
        now
      );

    recordActivity(db, {
      actorUserId: user.id,
      action: "auth.login",
      objectType: "session",
      objectId: sessionId,
      details: { ipAddress: input.ipAddress ?? "unknown" }
    });
  });

  return {
    user,
    rawToken,
    expiresAt
  };
}

export function authenticateSession(
  db: AppDatabase,
  rawToken: string | undefined,
  accessCode: string
): { sessionId: string; user: UserProfile } | null {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken, accessCode);
  const now = new Date().toISOString();

  const row = db.raw
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id, u.username, u.display_name, u.role, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as
    | {
        session_id: string;
        expires_at: string;
        id: string;
        username: string;
        display_name: string;
        role: "admin";
        created_at: string;
      }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= now) {
    db.raw.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }

  db.raw.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, row.session_id);

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at
    }
  };
}

export function revokeSession(
  db: AppDatabase,
  rawToken: string | undefined,
  accessCode: string | null,
  userId?: string
): void {
  if (!rawToken || !accessCode) return;
  const tokenHash = hashSessionToken(rawToken, accessCode);
  db.transaction(() => {
    db.raw.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    if (userId) {
      recordActivity(db, {
        actorUserId: userId,
        action: "auth.logout",
        objectType: "user",
        objectId: userId
      });
    }
  });
}

export function revokeAllSessions(db: AppDatabase): number {
  return db.transaction(() => {
    const result = db.raw.prepare("DELETE FROM sessions").run();
    return Number(result.changes ?? 0);
  });
}
