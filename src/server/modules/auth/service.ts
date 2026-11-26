import crypto from "node:crypto";
import type { UserProfile } from "../../../shared/types.js";
import type { AppDatabase } from "../../db/database.js";
import { AppError } from "../../http/errors.js";
import { recordActivity } from "../system/activity.js";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword
} from "./password.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "admin";
  created_at: string;
}

export function isSystemInitialized(db: AppDatabase): boolean {
  const row = db.raw.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return Number(row.count) > 0;
}

export interface InitAdminInput {
  username: string;
  displayName: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}

export async function initializeAdmin(
  db: AppDatabase,
  input: InitAdminInput
): Promise<{ user: UserProfile; rawToken: string; expiresAt: string }> {
  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const { rawToken, tokenHash } = generateSessionToken();

  db.transaction(() => {
    if (isSystemInitialized(db)) {
      throw new AppError(409, "CONFLICT", "系统已完成初始化，不能重复创建管理员");
    }

    db.raw
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', ?, ?)`
      )
      .run(userId, input.username.trim(), input.displayName.trim(), passwordHash, now, now);

    db.raw
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_address, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        userId,
        tokenHash,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        expiresAt,
        now,
        now
      );

    db.raw
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('initialized_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(now), now);

    recordActivity(db, {
      actorUserId: userId,
      action: "setup.init",
      objectType: "user",
      objectId: userId,
      details: { username: input.username.trim() }
    });
  });

  return {
    user: {
      id: userId,
      username: input.username.trim(),
      displayName: input.displayName.trim(),
      role: "admin",
      createdAt: now
    },
    rawToken,
    expiresAt
  };
}

export interface LoginInput {
  username: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}

export async function loginAdmin(
  db: AppDatabase,
  input: LoginInput
): Promise<{ user: UserProfile; rawToken: string; expiresAt: string }> {
  if (!isSystemInitialized(db)) {
    throw new AppError(409, "CONFLICT", "系统尚未初始化，请先完成首次管理员引导");
  }

  const userRow = db.raw
    .prepare(
      "SELECT id, username, display_name, password_hash, role, created_at FROM users WHERE username = ?"
    )
    .get(input.username.trim()) as UserRow | undefined;

  const valid = userRow ? await verifyPassword(input.password, userRow.password_hash) : false;
  if (!userRow || !valid) {
    recordActivity(db, {
      actorUserId: null,
      action: "auth.login_failed",
      objectType: "auth",
      objectId: null,
      details: { username: input.username.trim(), ipAddress: input.ipAddress ?? "unknown" }
    });
    throw new AppError(401, "UNAUTHORIZED", "用户名或密码不正确");
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const sessionId = crypto.randomUUID();
  const { rawToken, tokenHash } = generateSessionToken();

  db.transaction(() => {
    db.raw.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.raw
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_address, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        userRow.id,
        tokenHash,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        expiresAt,
        now,
        now
      );

    recordActivity(db, {
      actorUserId: userRow.id,
      action: "auth.login",
      objectType: "session",
      objectId: sessionId,
      details: { ipAddress: input.ipAddress ?? "unknown" }
    });
  });

  return {
    user: {
      id: userRow.id,
      username: userRow.username,
      displayName: userRow.display_name,
      role: userRow.role,
      createdAt: userRow.created_at
    },
    rawToken,
    expiresAt
  };
}

export function authenticateSession(
  db: AppDatabase,
  rawToken: string | undefined
): { sessionId: string; user: UserProfile } | null {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken);
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

export function revokeSession(db: AppDatabase, rawToken: string | undefined, userId?: string): void {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
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

export async function resetAdminPasswordCli(
  db: AppDatabase,
  username: string,
  newPassword: string
): Promise<{ userId: string; username: string; created: boolean }> {
  if (newPassword.length < 8) {
    throw new Error("新密码长度不能少于 8 个字符");
  }
  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  return db.transaction(() => {
    const existing = db.raw
      .prepare("SELECT id, username FROM users WHERE username = ?")
      .get(username.trim()) as { id: string; username: string } | undefined;

    if (existing) {
      db.raw
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, now, existing.id);
      db.raw.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
      recordActivity(db, {
        actorUserId: existing.id,
        action: "auth.admin_reset_cli",
        objectType: "user",
        objectId: existing.id,
        details: { username: existing.username }
      });
      return { userId: existing.id, username: existing.username, created: false };
    }

    const anyAdmin = db.raw.prepare("SELECT id, username FROM users LIMIT 1").get() as
      | { id: string; username: string }
      | undefined;
    if (anyAdmin) {
      throw new Error(
        `未找到用户名 "${username}"；当前已存在管理员 "${anyAdmin.username}"，请指定正确的用户名`
      );
    }

    const newId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', ?, ?)`
      )
      .run(newId, username.trim(), "系统管理员", passwordHash, now, now);
    db.raw
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('initialized_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(now), now);
    recordActivity(db, {
      actorUserId: newId,
      action: "auth.admin_created_cli",
      objectType: "user",
      objectId: newId,
      details: { username: username.trim() }
    });
    return { userId: newId, username: username.trim(), created: true };
  });
}
