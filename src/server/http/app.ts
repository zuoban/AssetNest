import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "../../shared/types.js";
import { ensureRuntimeDirectories } from "../config/loader.js";
import type { ResolvedAppConfig } from "../config/schema.js";
import { openDatabase, type AppDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { registerAssetRoutes } from "../modules/assets/routes.js";
import { ensureThumbnailReady, resolveAssetVersionFile } from "../modules/assets/service.js";
import { registerAuthRoutes } from "../modules/auth/routes.js";
import { isAuthEnabled } from "../modules/auth/service.js";
import { registerBackupRoutes } from "../modules/backups/routes.js";
import { executeBackupJob } from "../modules/backups/service.js";
import { registerJobRoutes } from "../modules/jobs/routes.js";
import { JobWorker } from "../modules/jobs/worker.js";
import { registerListingRoutes } from "../modules/listings/routes.js";
import { registerProductRoutes } from "../modules/products/routes.js";
import { executeReleaseExportJob } from "../modules/releases/exporter.js";
import { registerReleaseRoutes } from "../modules/releases/routes.js";
import {
  rebuildAssetSearchDocument,
  rebuildListingSearchDocument,
  rebuildProductSearchDocument
} from "../modules/search/service.js";
import { registerStorageOpsRoutes } from "../modules/storage-ops/routes.js";
import {
  executeStorageCleanupJob,
  executeStorageMigrationJob
} from "../modules/storage-ops/service.js";
import { registerSystemRoutes } from "../modules/system/routes.js";
import { syncSystemBootstrapState } from "../modules/system/service.js";
import { registerTaxonomyRoutes } from "../modules/taxonomy/routes.js";
import { executeGcJob } from "../modules/trash/gc.js";
import { registerTrashRoutes } from "../modules/trash/routes.js";
import { StorageRegistry } from "../storage/registry.js";
import { AppError, registerErrorHandler } from "./errors.js";
import { verifyCsrfHeaderAndOrigin } from "./security.js";

export const APP_VERSION = "0.2.0";

function extractRequestPathname(rawUrl: string): string {
  const endIndex = rawUrl.search(/[?#]/);
  return endIndex >= 0 ? rawUrl.slice(0, endIndex) : rawUrl;
}

export interface CreateAppOptions {
  config: ResolvedAppConfig;
  acquireInstanceLock?: boolean;
  logger?: boolean;
  webDistDir?: string;
  loginRateLimitMax?: number;
  startWorker?: boolean;
  workerPollIntervalMs?: number;
  workerRetryBaseDelayMs?: number;
}

export interface AppRuntime {
  app: FastifyInstance;
  db: AppDatabase;
  config: ResolvedAppConfig;
  storageRegistry: StorageRegistry;
  worker: JobWorker;
  setMaintenanceMode(enabled: boolean): void;
  close(): Promise<void>;
}

export async function createApp(options: CreateAppOptions): Promise<AppRuntime> {
  const {
    config,
    acquireInstanceLock = false,
    logger = true,
    webDistDir = path.resolve(import.meta.dirname, "../../../dist/web"),
    loginRateLimitMax = 10,
    startWorker = true,
    workerPollIntervalMs = 1500,
    workerRetryBaseDelayMs = 3000
  } = options;

  ensureRuntimeDirectories(config);

  const db = openDatabase({
    dbPath: config.database.path,
    wal: config.database.wal,
    acquireInstanceLock
  });

  let app: FastifyInstance | null = null;
  try {
    runMigrations(db);
    syncSystemBootstrapState(db, config);

    const storageRegistry = new StorageRegistry(config);
    let maintenanceMode = false;

    app = Fastify({
      logger: logger
        ? {
            level: process.env.LOG_LEVEL || "info",
            redact: {
              paths: [
                "req.headers.cookie",
                "req.headers.authorization",
                "*.accessCode",
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

    const worker = new JobWorker(db, {
      concurrency: config.worker.concurrency,
      pollIntervalMs: workerPollIntervalMs,
      retryBaseDelayMs: workerRetryBaseDelayMs,
      onError: (err, jobId) => {
        app!.log.error({ err, jobId }, "Background job error");
      }
    });

    worker.registerHandler("storage_migrate", (payload, ctx) =>
      executeStorageMigrationJob(db, config, storageRegistry, payload, ctx)
    );
    worker.registerHandler("storage_cleanup", (payload, ctx) =>
      executeStorageCleanupJob(db, storageRegistry, payload, ctx)
    );
    worker.registerHandler("gc", (payload, ctx) =>
      executeGcJob(db, config, storageRegistry, payload, ctx)
    );
    worker.registerHandler("backup", (payload, ctx) =>
      executeBackupJob(db, config, storageRegistry, APP_VERSION, payload, ctx)
    );
    worker.registerHandler("export_zip", (payload, ctx) =>
      executeReleaseExportJob(db, config, storageRegistry, payload, ctx)
    );
    worker.registerHandler("thumbnail", async (payload) => {
      const assetId = String(payload.assetId ?? "");
      const versionId = String(payload.versionId ?? "");
      if (!assetId || !versionId) {
        return { skipped: true };
      }
      const versionInfo = resolveAssetVersionFile(db, assetId, versionId);
      const res = await ensureThumbnailReady(db, config, storageRegistry, versionInfo, false);
      return { thumbStatus: res.thumbStatus, regenerated: res.regenerated };
    });
    worker.registerHandler("search_reindex", async (payload) => {
      const entityType = payload.entityType;
      const entityId = String(payload.entityId ?? "");
      if (entityType === "asset" && entityId) {
        rebuildAssetSearchDocument(db, entityId);
      } else if (entityType === "product" && entityId) {
        rebuildProductSearchDocument(db, entityId);
      } else if (entityType === "listing" && entityId) {
        rebuildListingSearchDocument(db, entityId);
      }
      return { reindexed: true };
    });

    await app.register(cookie);
    await app.register(multipart, {
      limits: {
        fileSize: config.uploads.maxFileSizeMB * 1024 * 1024,
        files: 50,
        fields: 50
      }
    });
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
      const pathname = extractRequestPathname(request.url);
      const isHealthProbe =
        (request.method === "GET" || request.method === "HEAD") && pathname === "/healthz";
      if (maintenanceMode && !isHealthProbe) {
        throw new AppError(503, "MAINTENANCE_MODE", "系统正在执行维护恢复，请稍候重试");
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        verifyCsrfHeaderAndOrigin(request);
      }
    });

    app.get("/healthz", async (): Promise<HealthResponse> => {
      let dbReady = false;
      try {
        db.raw.prepare("SELECT 1").get();
        dbReady = true;
      } catch {
        dbReady = false;
      }
      return {
        status: maintenanceMode ? "maintenance" : "ok",
        initialized: dbReady,
        dbReady,
        authEnabled: isAuthEnabled(config),
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
    registerJobRoutes(app, db, config, worker);
    registerStorageOpsRoutes(app, db, config, storageRegistry, worker);
    registerBackupRoutes(app, db, config, storageRegistry, worker, (enabled) => {
      maintenanceMode = enabled;
    });
    registerProductRoutes(app, db, config);
    registerTaxonomyRoutes(app, db, config);
    registerAssetRoutes(app, db, config, storageRegistry);
    registerListingRoutes(app, db, config);
    registerReleaseRoutes(app, db, config, storageRegistry, worker);
    registerTrashRoutes(app, db, config, worker);

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
        const pathname = extractRequestPathname(request.url);
        if (request.method === "GET" && pathname !== "/api" && !pathname.startsWith("/api/")) {
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

    if (startWorker) {
      worker.start();
    }

    const initializedApp = app;
    let closePromise: Promise<void> | null = null;
    function close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      closePromise = (async () => {
        let firstError: unknown;
        try {
          await initializedApp.close();
        } catch (err) {
          firstError = err;
        }
        try {
          await worker.stop();
        } catch (err) {
          firstError ??= err;
        }
        try {
          db.close();
        } catch (err) {
          firstError ??= err;
        }
        if (firstError !== undefined) {
          throw firstError;
        }
      })();
      return closePromise;
    }

    return {
      app: initializedApp,
      db,
      config,
      storageRegistry,
      worker,
      setMaintenanceMode(enabled: boolean) {
        maintenanceMode = enabled;
      },
      close
    };
  } catch (err) {
    if (app) {
      await app.close().catch(() => {});
    }
    db.close();
    throw err;
  }
}
