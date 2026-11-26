import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import {
  clearSessionCookie,
  createRequireAuthHook,
  SESSION_COOKIE_NAME,
  setSessionCookie
} from "../../http/security.js";
import { getAppSettings, listStorageProviders } from "../system/service.js";
import {
  initializeAdmin,
  isSystemInitialized,
  loginAdmin,
  revokeSession
} from "./service.js";

const setupInitSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "用户名至少 3 个字符")
    .max(32, "用户名不能超过 32 个字符")
    .regex(/^[a-zA-Z0-9._-]+$/, "用户名仅支持字母、数字、点、下划线和短横线"),
  displayName: z.string().trim().min(1, "显示名称不能为空").max(64).default("管理员"),
  password: z.string().min(8, "密码至少需要 8 个字符").max(128, "密码长度不能超过 128 个字符")
});

const loginSchema = z.object({
  username: z.string().trim().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码")
});

export interface AuthRoutesDeps {
  db: AppDatabase;
  config: ResolvedAppConfig;
  version: string;
  loginRateLimitMax: number;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { db, config, version, loginRateLimitMax } = deps;
  const requireAuth = createRequireAuthHook(db);

  app.get("/api/v1/setup/status", async () => {
    const settings = getAppSettings(db, config.app.timezone);
    return {
      initialized: isSystemInitialized(db),
      defaultStorageId: settings.defaultStorageId,
      providersSummary: listStorageProviders(db)
    };
  });

  app.post("/api/v1/setup/init", async (request, reply) => {
    const body = setupInitSchema.parse(request.body);
    const result = await initializeAdmin(db, {
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      userAgent: request.headers["user-agent"],
      ipAddress: request.ip
    });
    setSessionCookie(reply, result.rawToken, result.expiresAt, config.app.cookieSecure);
    return reply.status(201).send({ user: result.user });
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
      const result = await loginAdmin(db, {
        username: body.username,
        password: body.password,
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip
      });
      setSessionCookie(reply, result.rawToken, result.expiresAt, config.app.cookieSecure);
      return { user: result.user };
    }
  );

  app.post("/api/v1/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    revokeSession(db, request.cookies[SESSION_COOKIE_NAME], request.authUser?.id);
    clearSessionCookie(reply, config.app.cookieSecure);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: requireAuth }, async (request) => {
    const settings = getAppSettings(db, config.app.timezone);
    return {
      user: request.authUser,
      appName: config.app.name,
      version,
      timezone: settings.appTimezone
    };
  });
}
