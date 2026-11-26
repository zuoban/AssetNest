import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "../../shared/types.js";
import { ensureRuntimeDirectories } from "../config/loader.js";
import type { ResolvedAppConfig } from "../config/schema.js";
import { openDatabase, type AppDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { registerAuthRoutes } from "../modules/auth/routes.js";
import { isSystemInitialized } from "../modules/auth/service.js";
import { registerSystemRoutes } from "../modules/system/routes.js";
import { syncSystemBootstrapState } from "../modules/system/service.js";
import { AppError, registerErrorHandler } from "./errors.js";
import { verifyCsrfHeaderAndOrigin } from "./security.js";

export const APP_VERSION = "0.1.0";

export interface CreateAppOptions {
  config: ResolvedAppConfig;
  acquireInstanceLock?: boolean;
  logger?: boolean;
  webDistDir?: string;
  loginRateLimitMax?: number;
}

export interface AppRuntime {
  app: FastifyInstance;
  db: AppDatabase;
  config: ResolvedAppConfig;
  setMaintenanceMode(enabled: boolean): void;
  close(): Promise<void>;
}

export async function createApp(options: CreateAppOptions): Promise<AppRuntime> {
  const {
    config,
    acquireInstanceLock = false,
    logger = true,
    webDistDir = path.resolve(import.meta.dirname, "../../../dist/web"),
    loginRateLimitMax = 10
  } = options;

  ensureRuntimeDirectories(config);

  const db = openDatabase({
    dbPath: config.database.path,
    wal: config.database.wal,
    acquireInstanceLock
  });

  try {
    runMigrations(db);
    syncSystemBootstrapState(db, config);
  } catch (err) {
    db.close();
    throw err;
  }

  let maintenanceMode = false;

  const app = Fastify({
    logger: logger
      ? {
          level: process.env.LOG_LEVEL || "info",
          redact: {
            paths: [
              "req.headers.cookie",
              "req.headers.authorization",
              "*.password",
              "*.secretAccessKey",
              "*.token",
              "*.signedUrl"
            ],
            censor: "[REDACTED]"
          }
        }
      : false
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false
  });

  registerErrorHandler(app);

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    return payload;
  });

  app.addHook("onRequest", async (request) => {
    if (maintenanceMode && request.url !== "/healthz") {
      throw new AppError(503, "MAINTENANCE_MODE", "系统正在执行维护恢复，请稍候重试");
    }
    if (request.url.startsWith("/api/")) {
      verifyCsrfHeaderAndOrigin(request);
    }
  });

  app.get("/healthz", async (): Promise<HealthResponse> => {
    let dbReady = false;
    let initialized = false;
    try {
      db.raw.prepare("SELECT 1").get();
      dbReady = true;
      initialized = isSystemInitialized(db);
    } catch {
      dbReady = false;
    }
    return {
      status: maintenanceMode ? "maintenance" : "ok",
      initialized,
      dbReady,
      version: APP_VERSION
    };
  });

  registerAuthRoutes(app, {
    db,
    config,
    version: APP_VERSION,
    loginRateLimitMax
  });
  registerSystemRoutes(app, db, config);

  app.all("/api/*", async () => {
    throw new AppError(404, "NOT_FOUND", "请求的 API 接口不存在");
  });

  if (fs.existsSync(path.join(webDistDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      wildcard: false
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "资源不存在"
        }
      });
    });
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await app.close();
    } finally {
      db.close();
    }
  }

  return {
    app,
    db,
    config,
    setMaintenanceMode(enabled: boolean) {
      maintenanceMode = enabled;
    },
    close
  };
}
