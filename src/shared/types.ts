export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "STORAGE_OFFLINE"
  | "MAINTENANCE_MODE"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type StorageProviderType = "local" | "s3" | "webdav";

export type StorageProviderStatus =
  | "unknown"
  | "healthy"
  | "degraded"
  | "offline"
  | "missing_config";

export interface StorageProviderSummary {
  id: string;
  name: string;
  type: StorageProviderType;
  enabled: boolean;
  isDefault: boolean;
  status: StorageProviderStatus;
  lastTestedAt: string | null;
  lastError: string | null;
}

export interface HealthResponse {
  status: "ok" | "maintenance";
  initialized: boolean;
  dbReady: boolean;
  version: string;
}

export interface SetupStatusResponse {
  initialized: boolean;
  defaultStorageId: string;
  providersSummary: StorageProviderSummary[];
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  role: "admin";
  createdAt: string;
}

export interface AuthMeResponse {
  user: UserProfile;
  appName: string;
  version: string;
  timezone: string;
}

export interface JobRecord {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  priority: number;
  progressStage: string | null;
  progressCurrent: number;
  progressTotal: number | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ActivityRecord {
  id: string;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardResponse {
  counts: {
    products: number;
    assets: number;
    pendingReviews: number;
    draftListings: number;
    runningJobs: number;
    failedJobs: number;
  };
  storageSummary: StorageProviderSummary[];
  recentJobs: JobRecord[];
  recentActivities: ActivityRecord[];
}

export interface AppSettings {
  defaultStorageId: string;
  trashRetentionDays: number;
  exportTtlHours: number;
  appTimezone: string;
  initializedAt: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
