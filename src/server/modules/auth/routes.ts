import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthStatusResponse } from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import {
  clearSessionCookie,
  createRequireAuthHook,
  SESSION_COOKIE_NAME,
  setSessionCookie
} from "../../http/security.js";
import { getAppSettings } from "../system/service.js";
import {
  authenticateSession,
  isAuthEnabled,
  loginWithAccessCode,
  revokeSession
} from "./service.js";

const loginSchema = z.object({
  accessCode: z.string().min(1, "请输入访问码")
});

export interface AuthRoutesDeps {
  db: AppDatabase;
  config: ResolvedAppConfig;
  version: string;
  loginRateLimitMax: number;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { db, config, version, loginRateLimitMax } = deps;
  const requireAuth = createRequireAuthHook(db, config);

  app.get("/api/v1/auth/status", async (request): Promise<AuthStatusResponse> => {
    const authEnabled = isAuthEnabled(config);
    const authenticated = authEnabled
      ? Boolean(
          authenticateSession(db, request.cookies[SESSION_COOKIE_NAME], config.app.accessCode!)
        )
      : true;
    return {
      authEnabled,
      authenticated,
      appName: config.app.name,
      version
    };
  });

  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: loginRateLimitMax,
          timeWindow: "15 minutes"
        }
      }
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const result = loginWithAccessCode(db, config, {
        accessCode: body.accessCode,
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip
      });
      setSessionCookie(reply, result.rawToken, result.expiresAt, config.app.cookieSecure);
      return { user: result.user };
    }
  );

  app.post("/api/v1/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    revokeSession(
      db,
      request.cookies[SESSION_COOKIE_NAME],
      config.app.accessCode,
      request.authUser?.id
    );
    clearSessionCookie(reply, config.app.cookieSecure);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: requireAuth }, async (request) => {
    const settings = getAppSettings(db, config.app.timezone);
    return {
      user: request.authUser,
      appName: config.app.name,
      version,
      timezone: settings.appTimezone,
      authEnabled: isAuthEnabled(config)
    };
  });
}
