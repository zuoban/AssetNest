import type {
  ActivityRecord,
  AppSettings,
  DashboardResponse,
  JobRecord,
  PaginatedResponse,
  StorageCapabilitiesInfo,
  StorageProviderStatus,
  StorageProviderSummary,
  StorageProviderType
} from "../../../shared/types.js";
import type { ResolvedAppConfig } from "../../config/schema.js";
import type { AppDatabase } from "../../db/database.js";
import { ensureSystemUser } from "../auth/service.js";
import { mapJobRow, type JobRow } from "../jobs/service.js";
import { recordActivity } from "./activity.js";

function safeTableCount(db: AppDatabase, tableName: string, whereClause = ""): number {
  const exists = db.raw
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined;
  if (!exists) return 0;
  const sql = `SELECT COUNT(*) AS count FROM ${tableName}${whereClause ? ` WHERE ${whereClause}` : ""}`;
  const row = db.raw.prepare(sql).get() as { count: number };
  return Number(row.count);
}

export function syncSystemBootstrapState(db: AppDatabase, config: ResolvedAppConfig): void {
  const now = new Date().toISOString();

  db.transaction(() => {
    ensureSystemUser(db);

    const defaultSettings: Array<[string, unknown]> = [
      ["default_storage_id", config.storage.default],
      ["trash_retention_days", 30],
      ["export_ttl_hours", 72],
      ["app_timezone", config.app.timezone]
    ];

    const insertSetting = db.raw.prepare(
      "INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)"
    );
    for (const [key, value] of defaultSettings) {
      insertSetting.run(key, JSON.stringify(value), now);
    }

    const configuredIds = new Set(Object.keys(config.storage.providers));

    const existingProviders = db.raw
      .prepare("SELECT id, status FROM storage_providers")
      .all() as Array<{ id: string; status: StorageProviderStatus }>;

    const markMissing = db.raw.prepare(
      `UPDATE storage_providers
       SET enabled = 0, status = 'missing_config', last_error = ?, updated_at = ?
       WHERE id = ?`
    );
    for (const row of existingProviders) {
      if (!configuredIds.has(row.id)) {
        markMissing.run("配置文件中未找到该存储 Provider，已切换为离线只读保护状态", now, row.id);
      }
    }

    const upsertProvider = db.raw.prepare(
      `INSERT INTO storage_providers
         (id, name, type, config_ref, enabled, status, capabilities_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         config_ref = excluded.config_ref,
         enabled = excluded.enabled,
         status = CASE
           WHEN excluded.enabled = 0 THEN 'offline'
           WHEN storage_providers.status = 'missing_config' THEN 'unknown'
           ELSE storage_providers.status
         END,
         capabilities_json = excluded.capabilities_json,
         updated_at = excluded.updated_at`
    );

    for (const [id, provider] of Object.entries(config.storage.providers)) {
      const capabilities =
        provider.type === "local"
          ? { rangeRead: true, presignedUrl: false, multipartUpload: false }
          : provider.type === "s3"
            ? { rangeRead: true, presignedUrl: true, multipartUpload: true }
            : { rangeRead: false, presignedUrl: false, multipartUpload: false };

      const initialStatus: StorageProviderStatus = !provider.enabled
        ? "offline"
        : provider.type === "local"
          ? "healthy"
          : "unknown";

      upsertProvider.run(
        id,
        provider.name || id,
        provider.type,
        `storage.providers.${id}`,
        provider.enabled ? 1 : 0,
        initialStatus,
        JSON.stringify(capabilities),
        now,
        now
      );
    }
  });
}

export function getAppSettings(db: AppDatabase, fallbackTimezone: string): AppSettings {
  const rows = db.raw.prepare("SELECT key, value_json FROM settings").all() as Array<{
    key: string;
    value_json: string;
  }>;
  const map = new Map<string, unknown>();
  for (const row of rows) {
    try {
      map.set(row.key, JSON.parse(row.value_json));
    } catch {
      map.set(row.key, row.value_json);
    }
  }

  return {
    defaultStorageId: String(map.get("default_storage_id") ?? "local"),
    trashRetentionDays: Number(map.get("trash_retention_days") ?? 30),
    exportTtlHours: Number(map.get("export_ttl_hours") ?? 72),
    appTimezone: String(map.get("app_timezone") ?? fallbackTimezone),
    initializedAt: map.get("initialized_at") ? String(map.get("initialized_at")) : null
  };
}

export interface UpdateSettingsInput {
  trashRetentionDays?: number;
  exportTtlHours?: number;
  appTimezone?: string;
}

export function updateAppSettings(
  db: AppDatabase,
  actorUserId: string,
  input: UpdateSettingsInput,
  fallbackTimezone: string
): AppSettings {
  const now = new Date().toISOString();
  db.transaction(() => {
    const upsert = db.raw.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    );
    if (input.trashRetentionDays !== undefined) {
      upsert.run("trash_retention_days", JSON.stringify(input.trashRetentionDays), now);
    }
    if (input.exportTtlHours !== undefined) {
      upsert.run("export_ttl_hours", JSON.stringify(input.exportTtlHours), now);
    }
    if (input.appTimezone !== undefined) {
      upsert.run("app_timezone", JSON.stringify(input.appTimezone), now);
    }
    recordActivity(db, {
      actorUserId,
      action: "settings.update",
      objectType: "settings",
      objectId: "global",
      details: input as Record<string, unknown>
    });
  });
  return getAppSettings(db, fallbackTimezone);
}

export function listStorageProviders(db: AppDatabase): StorageProviderSummary[] {
  const settings = getAppSettings(db, "Asia/Shanghai");
  const rows = db.raw
    .prepare(
      `SELECT id, name, type, enabled, status, capabilities_json, last_tested_at, last_error
       FROM storage_providers
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC`
    )
    .all(settings.defaultStorageId) as Array<{
    id: string;
    name: string;
    type: StorageProviderType;
    enabled: number;
    status: StorageProviderStatus;
    capabilities_json: string;
    last_tested_at: string | null;
    last_error: string | null;
  }>;

  const statsByStorage = new Map<string, { fileCount: number; totalBytes: number }>();
  const filesTableExists = db.raw
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'files'")
    .get() as { ok: number } | undefined;
  if (filesTableExists) {
    const statRows = db.raw
      .prepare(
        `SELECT storage_id, COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
         FROM files
         WHERE state = 'ready'
         GROUP BY storage_id`
      )
      .all() as Array<{ storage_id: string; file_count: number; total_bytes: number }>;
    for (const stat of statRows) {
      statsByStorage.set(stat.storage_id, {
        fileCount: Number(stat.file_count),
        totalBytes: Number(stat.total_bytes)
      });
    }
  }

  return rows.map((row) => {
    let capabilities: StorageCapabilitiesInfo = {
      rangeRead: row.type === "local" || row.type === "s3",
      presignedUrl: row.type === "s3",
      multipartUpload: row.type === "s3"
    };
    try {
      const parsed = JSON.parse(row.capabilities_json) as Partial<StorageCapabilitiesInfo>;
      capabilities = {
        rangeRead: Boolean(parsed.rangeRead ?? capabilities.rangeRead),
        presignedUrl: Boolean(parsed.presignedUrl ?? capabilities.presignedUrl),
        multipartUpload: Boolean(parsed.multipartUpload ?? capabilities.multipartUpload)
      };
    } catch {
      // keep defaults
    }
    const stats = statsByStorage.get(row.id) ?? { fileCount: 0, totalBytes: 0 };
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      isDefault: row.id === settings.defaultStorageId,
      status: row.status,
      capabilities,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      lastTestedAt: row.last_tested_at,
      lastError: row.last_error
    };
  });
}

export function listJobs(
  db: AppDatabase,
  page = 1,
  pageSize = 20
): PaginatedResponse<JobRecord> {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(100, Math.max(1, pageSize));
  const offset = (safePage - 1) * safeSize;

  const totalRow = db.raw.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number };
  const rows = db.raw
    .prepare(
      `SELECT id, type, status, priority, payload_json, result_json,
              progress_stage, progress_current, progress_total,
              attempts, max_attempts, run_after, lease_owner, lease_until,
              cancel_requested, last_error, created_at, updated_at, started_at, finished_at
       FROM jobs
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(safeSize, offset) as unknown as JobRow[];

  return {
    items: rows.map(mapJobRow),
    total: Number(totalRow.count),
    page: safePage,
    pageSize: safeSize
  };
}

export function listActivities(
  db: AppDatabase,
  page = 1,
  pageSize = 20
): PaginatedResponse<ActivityRecord> {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(100, Math.max(1, pageSize));
  const offset = (safePage - 1) * safeSize;

  const totalRow = db.raw.prepare("SELECT COUNT(*) AS count FROM activity_events").get() as {
    count: number;
  };
  const rows = db.raw
    .prepare(
      `SELECT id, actor_user_id, action, object_type, object_id, details_json, created_at
       FROM activity_events
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(safeSize, offset) as Array<{
    id: string;
    actor_user_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    details_json: string;
    created_at: string;
  }>;

  return {
    items: rows.map((row) => {
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(row.details_json) as Record<string, unknown>;
      } catch {
        details = {};
      }
      return {
        id: row.id,
        actorUserId: row.actor_user_id,
        action: row.action,
        objectType: row.object_type,
        objectId: row.object_id,
        details,
        createdAt: row.created_at
      };
    }),
    total: Number(totalRow.count),
    page: safePage,
    pageSize: safeSize
  };
}

export function getDashboardSummary(db: AppDatabase): DashboardResponse {
  return {
    counts: {
      products: safeTableCount(db, "products", "deleted_at IS NULL"),
      assets: safeTableCount(db, "assets", "deleted_at IS NULL"),
      draftListings: safeTableCount(db, "listings", "deleted_at IS NULL AND status = 'draft'"),
      runningJobs: safeTableCount(db, "jobs", "status IN ('queued', 'running')"),
      failedJobs: safeTableCount(db, "jobs", "status = 'failed'")
    },
    storageSummary: listStorageProviders(db),
    recentJobs: listJobs(db, 1, 8).items,
    recentActivities: listActivities(db, 1, 10).items
  };
}
