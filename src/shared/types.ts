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
  | "INVALID_OBJECT_KEY"
  | "PATH_TRAVERSAL"
  | "RANGE_NOT_SATISFIABLE"
  | "STORAGE_OBJECT_NOT_FOUND"
  | "STORAGE_INVALID_OBJECT"
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

export type AssetType = "image" | "video" | "document" | "archive" | "other";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type ThumbStatus = "pending" | "ready" | "unsupported" | "failed";
export type TagDimension = "market" | "platform" | "purpose" | "color" | "scene" | "custom";
export type ProductStatus = "draft" | "active" | "archived";
export type SkuStatus = "active" | "inactive";

export interface ProductSpec {
  id?: string;
  specKey: string;
  specValue: string;
  unit: string;
  position: number;
}

export interface AppearanceConstraints {
  structure?: string;
  proportion?: string;
  color?: string;
  dimensions?: string;
  forbiddenChanges?: string;
}

export interface SkuRecord {
  id: string;
  productId: string;
  code: string;
  name: string;
  attributes: Record<string, string>;
  attributesCanonical: string;
  extraSpecs: Array<{ specKey: string; specValue: string; unit?: string }>;
  primaryAssetVersionId: string | null;
  status: SkuStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSummary {
  id: string;
  spu: string;
  nameZh: string;
  nameEn: string;
  category: string;
  brandModel: string;
  supplierName: string;
  supplierUrl: string;
  coverVersionId: string | null;
  coverAssetId: string | null;
  status: ProductStatus;
  notes: string;
  skuCount: number;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDetail extends ProductSummary {
  appearanceConstraints: AppearanceConstraints;
  specs: ProductSpec[];
  skus: SkuRecord[];
}

export interface FolderRecord {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagRecord {
  id: string;
  dimension: TagDimension;
  parentId: string | null;
  name: string;
  isSystem: boolean;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetVersionRecord {
  id: string;
  assetId: string;
  fileId: string;
  versionNo: number;
  originalFilename: string;
  changeNote: string;
  promptText: string;
  reviewStatus: ReviewStatus;
  reviewNote: string;
  reviewedAt: string | null;
  thumbStatus: ThumbStatus;
  storageId: string;
  storageStatus: StorageProviderStatus;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  ext: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AssetLinkedProduct {
  id: string;
  spu: string;
  nameZh: string;
  nameEn: string;
}

export interface AssetListItem {
  id: string;
  name: string;
  originalFilename: string;
  assetType: AssetType;
  purpose: string;
  folderId: string | null;
  folderName: string | null;
  currentVersionId: string;
  versionNo: number;
  reviewStatus: ReviewStatus;
  thumbStatus: ThumbStatus;
  isFavorite: boolean;
  source: string;
  sourceUrl: string | null;
  notes: string;
  storageId: string;
  storageStatus: StorageProviderStatus;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  ext: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  tags: Array<{ id: string; dimension: TagDimension; name: string }>;
  products: AssetLinkedProduct[];
  createdAt: string;
  updatedAt: string;
}

export interface AssetDetail extends AssetListItem {
  versions: AssetVersionRecord[];
}

export interface TrashAssetItem {
  id: string;
  name: string;
  originalFilename: string;
  assetType: AssetType;
  sizeBytes: number;
  currentVersionId: string;
  thumbStatus: ThumbStatus;
  productCount: number;
  tagCount: number;
  deletedAt: string;
}

export interface TrashProductItem {
  id: string;
  spu: string;
  nameZh: string;
  nameEn: string;
  skuCount: number;
  assetCount: number;
  deletedAt: string;
}

export interface TrashResponse {
  assets: TrashAssetItem[];
  products: TrashProductItem[];
}
