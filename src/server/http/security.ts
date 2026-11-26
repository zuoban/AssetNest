import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserProfile } from "../../shared/types.js";
import type { ResolvedAppConfig } from "../config/schema.js";
import type { AppDatabase } from "../db/database.js";
import { authenticateSession, ensureSystemUser } from "../modules/auth/service.js";
import { AppError } from "./errors.js";

export const SESSION_COOKIE_NAME = "assetnest_session";
export const CSRF_HEADER_NAME = "x-assetnest-request";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: UserProfile;
    authSessionId?: string;
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  expiresAt: string,
  secure: boolean
): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: new Date(expiresAt)
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure
  });
}

export function verifyCsrfHeaderAndOrigin(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }

  const csrfHeader = request.headers[CSRF_HEADER_NAME];
  if (csrfHeader !== "1") {
    throw new AppError(403, "FORBIDDEN", "缺少 CSRF 安全请求头，已拒绝该写操作");
  }

  const origin = request.headers.origin;
  if (origin) {
    const requestHost = (request.headers["x-forwarded-host"] || request.headers.host || "")
      .toString()
      .split(",")[0]
      ?.trim()
      .toLowerCase();
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (requestHost && originHost !== requestHost) {
        throw new AppError(403, "FORBIDDEN", "跨源写请求已被拒绝");
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(403, "FORBIDDEN", "无效的 Origin 请求头");
    }
  }
}

export function createRequireAuthHook(db: AppDatabase, config: ResolvedAppConfig) {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const accessCode = config.app.accessCode;
    if (!accessCode) {
      request.authUser = ensureSystemUser(db);
      return;
    }

    const rawToken = request.cookies[SESSION_COOKIE_NAME];
    const session = authenticateSession(db, rawToken, accessCode);
    if (!session) {
      throw new AppError(401, "UNAUTHORIZED", "请先输入访问码登录后再访问");
    }
    request.authUser = session.user;
    request.authSessionId = session.sessionId;
  };
}
