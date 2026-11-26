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

export interface StorageCapabilitiesInfo {
  rangeRead: boolean;
  presignedUrl: boolean;
  multipartUpload: boolean;
}

export interface StorageProviderSummary {
  id: string;
  name: string;
  type: StorageProviderType;
  enabled: boolean;
  isDefault: boolean;
  status: StorageProviderStatus;
  capabilities: StorageCapabilitiesInfo;
  fileCount: number;
  totalBytes: number;
  lastTestedAt: string | null;
  lastError: string | null;
}

export type ConnectionErrorCode =
  | "OK"
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "INTEGRITY_MISMATCH"
  | "INVALID_CONFIG";

export interface StorageTestResponse {
  provider: StorageProviderSummary;
  result: {
    ok: boolean;
    latencyMs: number;
    code: ConnectionErrorCode;
    message: string;
  };
}

export type JobType =
  | "thumbnail"
  | "search_reindex"
  | "export_zip"
  | "storage_migrate"
  | "storage_cleanup"
  | "gc"
  | "backup"
  | "restore";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface HealthResponse {
  status: "ok" | "maintenance";
  initialized: boolean;
  dbReady: boolean;
  authEnabled: boolean;
  version: string;
}

export interface AuthStatusResponse {
  authEnabled: boolean;
  authenticated: boolean;
  appName: string;
  version: string;
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
  authEnabled: boolean;
}

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  progressStage: string | null;
  progressCurrent: number;
  progressTotal: number | null;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  lastError: string | null;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
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
  referenceNotes?: string;
  referenceAssetVersionIds?: string[];
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
  referenceAssetVersionId: string | null;
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
  lockedMasterProducts?: Array<{
    masterImageId: string;
    productId: string;
    spu: string;
    angle: string;
    isPrimary: boolean;
  }>;
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

export interface TrashListingItem {
  id: string;
  productId: string;
  productSpu: string;
  productNameZh: string;
  storeId: string;
  storeName: string;
  platform: string;
  market: string;
  displayName: string;
  language: string;
  status: ListingStatus;
  deletedAt: string;
}

export interface TrashResponse {
  assets: TrashAssetItem[];
  products: TrashProductItem[];
  listings: TrashListingItem[];
}

export interface MigrationScopeInput {
  mode: "all" | "product" | "asset_ids";
  productId?: string;
  assetIds?: string[];
}

export interface MigrationPreviewResponse {
  sourceStorageId: string;
  targetStorageId: string;
  fileCount: number;
  totalBytes: number;
  alreadyOnTargetCount: number;
  affectedAssetCount: number;
  affectedProductCount: number;
  sharedFileCount: number;
  affectedAssets: Array<{
    id: string;
    name: string;
    originalFilename: string;
    deletedAt: string | null;
  }>;
  affectedProducts: Array<{
    id: string;
    spu: string;
    nameZh: string;
    nameEn: string;
  }>;
}

export interface StorageCleanupItem {
  id: string;
  storageId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  reason: "migration_source" | "gc_unreferenced";
  sourceJobId: string | null;
  status: "awaiting_confirmation" | "queued" | "deleted" | "failed";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageCleanupQueueResponse {
  items: StorageCleanupItem[];
  summary: {
    awaitingCount: number;
    queuedCount: number;
    failedCount: number;
    deletedCount: number;
    reclaimableBytes: number;
  };
}

export interface CacheClearResult {
  clearedFiles: number;
  freedBytes: number;
}

export type BackupKind = "metadata" | "full";

export interface BackupRecord {
  id: string;
  kind: BackupKind;
  jobId: string | null;
  sizeBytes: number;
  sha256: string | null;
  schemaVersion: number;
  fileCount: number;
  status: "creating" | "ready" | "failed" | "deleted";
  lastError: string | null;
  createdAt: string;
}

// M3: E-commerce workflow types

export type DictionaryCategory = "platform" | "market" | "language";

export interface DictionaryRecord {
  category: DictionaryCategory;
  code: string;
  label: string;
  isActive: boolean;
  position: number;
}

export interface DictionariesResponse {
  items: DictionaryRecord[];
  platforms: DictionaryRecord[];
  markets: DictionaryRecord[];
  languages: DictionaryRecord[];
}

export interface ProductMasterImageRecord {
  id: string;
  productId: string;
  assetId: string;
  assetName: string;
  assetVersionId: string;
  versionNo: number;
  latestVersionId: string;
  latestVersionNo: number;
  originalFilename: string;
  angle: string;
  isPrimary: boolean;
  lockNote: string;
  lockedAt: string;
  unlockedAt: string | null;
  unlockNote: string | null;
  reviewStatus: ReviewStatus;
  thumbStatus: ThumbStatus;
  storageId: string;
  storageStatus: StorageProviderStatus;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  ext: string;
  width: number | null;
  height: number | null;
}

export type StoreStatus = "active" | "archived";

export interface StoreRecord {
  id: string;
  name: string;
  platform: string;
  market: string;
  defaultLanguage: string;
  status: StoreStatus;
  notes: string;
  listingCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ListingStatus = "draft" | "ready" | "published" | "archived";
export type AssetSetKind = "carousel" | "detail" | "sku" | "video";

export interface ListingSkuRecord {
  id: string;
  listingId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  skuAttributes: Record<string, string>;
  skuStatus: SkuStatus;
  channelCode: string;
  displayName: string;
  position: number;
}

export interface ListingSummary {
  id: string;
  productId: string;
  productSpu: string;
  productNameZh: string;
  productNameEn: string;
  storeId: string;
  storeName: string;
  platform: string;
  market: string;
  displayName: string;
  language: string;
  externalId: string | null;
  externalUrl: string | null;
  status: ListingStatus;
  notes: string;
  skuCount: number;
  carouselCount: number;
  detailCount: number;
  skuImageCount: number;
  videoCount: number;
  pdpVersionCount: number;
  pdpTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListingDetail extends ListingSummary {
  skus: ListingSkuRecord[];
}

export interface AssetSetItemRecord {
  id: string;
  setId: string;
  kind: AssetSetKind;
  position: number;
  assetVersionId: string;
  assetId: string;
  assetName: string;
  assetType: AssetType;
  assetDeleted: boolean;
  originalFilename: string;
  versionNo: number;
  latestVersionId: string;
  latestVersionNo: number;
  hasNewerVersion: boolean;
  reviewStatus: ReviewStatus;
  reviewNote: string;
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
  listingSkuId: string | null;
  skuCode: string | null;
  skuChannelCode: string | null;
  skuDisplayName: string | null;
  isDuplicateVersion: boolean;
  isDuplicateAsset: boolean;
  createdAt: string;
}

export interface ListingAssetSetsResponse {
  listingId: string;
  sets: Record<
    AssetSetKind,
    {
      id: string;
      kind: AssetSetKind;
      updatedAt: string;
      items: AssetSetItemRecord[];
    }
  >;
}

export interface PdpSpecRow {
  specKey: string;
  specValue: string;
  unit: string;
}

export interface PdpContent {
  title: string;
  shortDescription: string;
  bullets: string[];
  fullDescription: string;
  specs: PdpSpecRow[];
  packageList: string;
  usageInstructions: string;
  seoKeywords: string;
  notes: string;
}

export interface PdpDraftRecord {
  listingId: string;
  language: string;
  content: PdpContent;
  revision: number;
  basedOnVersionId: string | null;
  titleCodePoints: number;
  titleUtf8Bytes: number;
  updatedAt: string;
}

export interface PdpVersionRecord {
  id: string;
  listingId: string;
  language: string;
  versionNo: number;
  content: PdpContent;
  titleCodePoints: number;
  note: string;
  createdAt: string;
}

export interface PdpSpecDiffItem {
  specKey: string;
  kind: "added_in_product" | "changed_in_product" | "only_in_pdp";
  productValue?: string;
  productUnit?: string;
  pdpValue?: string;
  pdpUnit?: string;
}

export interface ListingPdpResponse {
  listingId: string;
  language: string;
  draft: PdpDraftRecord;
  versions: PdpVersionRecord[];
  productSpecs: PdpSpecRow[];
  specDiff: PdpSpecDiffItem[];
}

// M4: Export templates, preflight validation, immutable releases, exports & restore

export type PdpRequiredField =
  | "title"
  | "shortDescription"
  | "bullets"
  | "description"
  | "specs"
  | "packageList"
  | "usageInstructions";

export interface ExportTemplateRules {
  folders: {
    carousel: string;
    sku: string;
    detail: string;
    video: string;
    pdp: string;
  };
  carousel: {
    minCount: number;
    targetCount: number;
    maxCount: number;
    aspectRatio: string;
    aspectTolerance: number;
    minWidth: number;
    minHeight: number;
    maxFileSizeMB: number;
    allowedExts: string[];
  };
  detail: {
    minCount: number;
    maxCount: number;
    aspectRatio: string;
    aspectTolerance: number;
    minWidth: number;
    minHeight: number;
    maxFileSizeMB: number;
    allowedExts: string[];
  };
  sku: {
    required: boolean;
    minWidth: number;
    minHeight: number;
    maxFileSizeMB: number;
    allowedExts: string[];
  };
  video: {
    maxCount: number;
    maxFileSizeMB: number;
    allowedExts: string[];
  };
  pdp: {
    maxTitleCodePoints: number;
    requiredFields: PdpRequiredField[];
  };
  review: {
    requireApprovedForFormal: boolean;
  };
  naming: {
    carouselPrefix: string;
    mainImageName: string;
    detailPrefix: string;
    videoPrefix: string;
  };
}

export interface ExportTemplateRecord {
  id: string;
  name: string;
  platform: string;
  market: string;
  version: number;
  isDefault: boolean;
  rules: ExportTemplateRules;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  severity: "blocker" | "warning";
  code: string;
  message: string;
  targetKind?: "carousel" | "detail" | "sku" | "video" | "pdp" | "storage" | "listing";
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export interface ListingValidationResult {
  listingId: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  canCreateFormalRelease: boolean;
  checkedAt: string;
  blockers: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: {
    carouselCount: number;
    detailCount: number;
    skuTotalCount: number;
    skuBoundCount: number;
    videoCount: number;
    titleCodePoints: number;
  };
}

export interface ReleaseAssetRecord {
  id: string;
  releaseId: string;
  assetVersionId: string;
  kind: AssetSetKind;
  listingSkuCode: string | null;
  position: number;
  exportRelativePath: string;
  sha256: string;
  sizeBytes: number;
  originalFilename?: string;
  versionNo?: number;
  storageId?: string;
}

export type ExportStatus = "queued" | "running" | "ready" | "expired" | "failed";

export interface ExportRecord {
  id: string;
  releaseId: string;
  jobId: string | null;
  status: ExportStatus;
  fileName: string;
  sizeBytes: number | null;
  expiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseSummary {
  id: string;
  listingId: string;
  releaseNo: number;
  releaseCode: string;
  isDraftPackage: boolean;
  templateId: string;
  templateName: string;
  templateVersion: number;
  pdpVersionId: string | null;
  note: string;
  assetCount: number;
  blockerCount: number;
  warningCount: number;
  latestExport: ExportRecord | null;
  createdAt: string;
}

export interface ReleaseDetail extends ReleaseSummary {
  validationSummary: ListingValidationResult;
  snapshot: Record<string, unknown>;
  assets: ReleaseAssetRecord[];
  exports: ExportRecord[];
}

export interface RestoreBackupResult {
  backupId: string;
  kind: BackupKind;
  schemaVersion: number;
  restoredFileCount: number;
  reusedFileCount: number;
  reindexed: {
    products: number;
    assets: number;
    listings: number;
  };
  restoredAt: string;
}
