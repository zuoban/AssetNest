import type {
  ActivityRecord,
  ApiErrorBody,
  AppSettings,
  AppearanceConstraints,
  AssetDetail,
  AssetListItem,
  AssetSetKind,
  AssetType,
  AssetVersionRecord,
  AuthMeResponse,
  AuthStatusResponse,
  BackupKind,
  BackupRecord,
  CacheClearResult,
  DashboardResponse,
  DictionariesResponse,
  DictionaryCategory,
  DictionaryRecord,
  ExportRecord,
  ExportTemplateRecord,
  ExportTemplateRules,
  FolderRecord,
  JobRecord,
  ListingAssetSetsResponse,
  ListingDetail,
  ListingPdpResponse,
  ListingStatus,
  ListingSummary,
  ListingValidationResult,
  MigrationPreviewResponse,
  MigrationScopeInput,
  PaginatedResponse,
  PdpContent,
  PdpVersionRecord,
  ProductDetail,
  ProductMasterImageRecord,
  ProductSpec,
  ProductStatus,
  ProductSummary,
  ReleaseDetail,
  ReleaseSummary,
  RestoreBackupResult,
  SkuRecord,
  SkuStatus,
  StorageCleanupItem,
  StorageCleanupQueueResponse,
  StorageProviderSummary,
  StorageTestResponse,
  StoreRecord,
  StoreStatus,
  TagDimension,
  TagRecord,
  TrashResponse,
  UserProfile
} from "../../shared/types";
import {
  compressFilesWithProgress,
  computeImageUploadSizes,
  type CompressionBatchProgress,
  type ImageUploadSizes,
  type PreparedUploadFile
} from "../utils/uploadPreparation";

export type { CompressionBatchProgress, ImageUploadSizes, PreparedUploadFile };

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-AssetNest-Request", "1");
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: "same-origin"
  });

  if (!res.ok) {
    let code = "HTTP_ERROR";
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const parsed = (await res.json()) as Partial<ApiErrorBody>;
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // ignore non-json error body
    }
    throw new ApiClientError(res.status, code, message);
  }

  return (await res.json()) as T;
}

export interface UploadTransferProgress {
  loaded: number;
  total: number;
  percent: number;
  phase: "uploading" | "processing";
}

export function uploadFormJson<T>(
  url: string,
  form: FormData,
  onProgress?: (progress: UploadTransferProgress) => void,
  fallbackTotalBytes = 0
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("X-AssetNest-Request", "1");

    let lastLoaded = 0;
    let lastTotal = fallbackTotalBytes;

    if (onProgress && xhr.upload) {
      xhr.upload.onloadstart = (event: ProgressEvent) => {
        const total =
          event.lengthComputable && event.total > 0 ? event.total : fallbackTotalBytes;
        lastTotal = total;
        onProgress({
          loaded: 0,
          total,
          percent: 0,
          phase: "uploading"
        });
      };

      xhr.upload.onprogress = (event: ProgressEvent) => {
        const total =
          event.lengthComputable && event.total > 0
            ? event.total
            : Math.max(event.total || 0, lastTotal, event.loaded || 0);
        const loaded = total > 0 ? Math.min(event.loaded, total) : event.loaded;
        lastLoaded = loaded;
        lastTotal = total;
        const percent =
          total > 0 ? Math.min(100, Math.max(0, Math.round((loaded / total) * 100))) : 0;
        onProgress({
          loaded,
          total,
          percent,
          phase: "uploading"
        });
      };

      xhr.upload.onload = (event: ProgressEvent) => {
        const total =
          event.lengthComputable && event.total > 0
            ? event.total
            : Math.max(lastTotal, lastLoaded, fallbackTotalBytes);
        onProgress({
          loaded: total,
          total,
          percent: 100,
          phase: "processing"
        });
      };
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let code = "HTTP_ERROR";
        let message = `请求失败（HTTP ${xhr.status}）`;
        try {
          const parsed = JSON.parse(xhr.responseText) as Partial<ApiErrorBody>;
          if (parsed.error?.code) code = parsed.error.code;
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          // ignore non-json error body
        }
        reject(new ApiClientError(xhr.status, code, message));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as T);
      } catch {
        reject(new ApiClientError(xhr.status, "INVALID_RESPONSE", "服务器返回了无效的响应格式"));
      }
    };

    xhr.onerror = () => {
      reject(new ApiClientError(0, "NETWORK_ERROR", "网络请求失败，请检查网络连接"));
    };

    xhr.onabort = () => {
      reject(new ApiClientError(0, "UPLOAD_ABORTED", "上传已取消"));
    };

    xhr.send(form);
  });
}

async function appendUploadFiles(
  form: FormData,
  field: "files" | "file",
  files: File[],
  options: {
    compressImages?: boolean;
    preparedFiles?: PreparedUploadFile[];
    compressionSummary?: ImageUploadSizes | null;
    onCompressionProgress?: (progress: CompressionBatchProgress) => void;
  } = {}
): Promise<{ compression: ImageUploadSizes | null; totalBytes: number }> {
  if (options.preparedFiles && options.preparedFiles.length > 0) {
    let totalBytes = 0;
    for (const { original, upload } of options.preparedFiles) {
      form.append(field, upload, original.name);
      totalBytes += upload.size;
    }
    const compression =
      options.compressionSummary !== undefined
        ? options.compressionSummary
        : options.compressImages
          ? computeImageUploadSizes(options.preparedFiles)
          : null;
    return { compression, totalBytes };
  }

  if (options.compressImages) {
    const { prepared, compression } = await compressFilesWithProgress(files, {
      onProgress: options.onCompressionProgress
    });
    let totalBytes = 0;
    for (const { original, upload } of prepared) {
      form.append(field, upload, original.name);
      totalBytes += upload.size;
    }
    return { compression, totalBytes };
  }

  let totalBytes = 0;
  for (const original of files) {
    form.append(field, original, original.name);
    totalBytes += original.size;
  }
  return { compression: null, totalBytes };
}

export const api = {
  getAuthStatus(): Promise<AuthStatusResponse> {
    return requestJson("/api/v1/auth/status");
  },
  login(payload: { accessCode: string }): Promise<{ user: UserProfile }> {
    return requestJson("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  logout(): Promise<{ ok: boolean }> {
    return requestJson("/api/v1/auth/logout", {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  getMe(): Promise<AuthMeResponse> {
    return requestJson("/api/v1/auth/me");
  },
  getDashboard(): Promise<DashboardResponse> {
    return requestJson("/api/v1/dashboard");
  },
  getSettings(): Promise<AppSettings> {
    return requestJson("/api/v1/settings");
  },
  updateSettings(payload: {
    trashRetentionDays?: number;
    exportTtlHours?: number;
    appTimezone?: string;
  }): Promise<AppSettings> {
    return requestJson("/api/v1/settings", {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  getStorageProviders(): Promise<{ items: StorageProviderSummary[] }> {
    return requestJson("/api/v1/storage/providers");
  },
  getJobs(page = 1, pageSize = 20): Promise<PaginatedResponse<JobRecord>> {
    return requestJson(`/api/v1/jobs?page=${page}&pageSize=${pageSize}`);
  },
  getActivities(page = 1, pageSize = 20): Promise<PaginatedResponse<ActivityRecord>> {
    return requestJson(`/api/v1/activities?page=${page}&pageSize=${pageSize}`);
  },
  listProducts(params: {
    q?: string;
    status?: ProductStatus;
    category?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<PaginatedResponse<ProductSummary>> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.status) qs.set("status", params.status);
    if (params.category) qs.set("category", params.category);
    if (params.page) qs.set("page", String(params.page));
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    const query = qs.toString();
    return requestJson(`/api/v1/products${query ? `?${query}` : ""}`);
  },
  createProduct(payload: {
    spu: string;
    nameZh: string;
    nameEn?: string;
    category?: string;
    brandModel?: string;
    supplierName?: string;
    supplierUrl?: string;
    status?: ProductStatus;
    notes?: string;
    appearanceConstraints?: AppearanceConstraints;
    specs?: Array<Omit<ProductSpec, "id">>;
  }): Promise<ProductDetail> {
    return requestJson("/api/v1/products", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  getProduct(id: string): Promise<ProductDetail> {
    return requestJson(`/api/v1/products/${id}`);
  },
  updateProduct(
    id: string,
    payload: {
      spu?: string;
      nameZh?: string;
      nameEn?: string;
      category?: string;
      brandModel?: string;
      supplierName?: string;
      supplierUrl?: string;
      coverVersionId?: string | null;
      status?: ProductStatus;
      notes?: string;
      appearanceConstraints?: AppearanceConstraints;
      specs?: Array<Omit<ProductSpec, "id">>;
    }
  ): Promise<ProductDetail> {
    return requestJson(`/api/v1/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  deleteProduct(id: string): Promise<{
    id: string;
    deletedAt: string;
    impact: { skuCount: number; linkedAssetCount: number; warning: string | null };
  }> {
    return requestJson(`/api/v1/products/${id}`, {
      method: "DELETE"
    });
  },
  createSku(
    productId: string,
    payload: {
      code: string;
      name: string;
      attributes: Record<string, string>;
      status?: SkuStatus;
    }
  ): Promise<SkuRecord> {
    return requestJson(`/api/v1/products/${productId}/skus`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateSku(
    productId: string,
    skuId: string,
    payload: {
      code?: string;
      name?: string;
      attributes?: Record<string, string>;
      status?: SkuStatus;
    }
  ): Promise<SkuRecord> {
    return requestJson(`/api/v1/products/${productId}/skus/${skuId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  deleteSku(productId: string, skuId: string): Promise<{ deleted: boolean; id: string }> {
    return requestJson(`/api/v1/products/${productId}/skus/${skuId}`, {
      method: "DELETE"
    });
  },
  listFolders(): Promise<{ items: FolderRecord[] }> {
    return requestJson("/api/v1/folders");
  },
  createFolder(payload: { name: string; parentId?: string | null }): Promise<FolderRecord> {
    return requestJson("/api/v1/folders", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateFolder(
    id: string,
    payload: { name?: string; parentId?: string | null; position?: number }
  ): Promise<FolderRecord> {
    return requestJson(`/api/v1/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  deleteFolder(
    id: string,
    options?: { recursive?: boolean }
  ): Promise<{ deleted: boolean; id: string; deletedIds?: string[] }> {
    const qs = options?.recursive ? "?recursive=1" : "";
    return requestJson(`/api/v1/folders/${id}${qs}`, {
      method: "DELETE"
    });
  },
  listTags(dimension?: TagDimension): Promise<{ items: TagRecord[] }> {
    return requestJson(`/api/v1/tags${dimension ? `?dimension=${dimension}` : ""}`);
  },
  createTag(payload: { dimension: TagDimension; name: string; parentId?: string | null }): Promise<TagRecord> {
    return requestJson("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  deleteTag(id: string): Promise<{ deleted: boolean; id: string }> {
    return requestJson(`/api/v1/tags/${id}`, {
      method: "DELETE"
    });
  },
  listAssets(params: {
    q?: string;
    productId?: string;
    storeId?: string;
    market?: string;
    platform?: string;
    purpose?: string;
    scene?: string;
    color?: string;
    tagId?: string;
    type?: AssetType;
    folderId?: string;
    includeSubfolders?: boolean;
    unfiled?: boolean;
    favorite?: boolean;
    storageId?: string;
    minWidth?: number;
    sort?: "newest" | "oldest" | "name_asc" | "size_desc";
    page?: number;
    pageSize?: number;
  } = {}): Promise<PaginatedResponse<AssetListItem>> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.productId) qs.set("productId", params.productId);
    if (params.storeId) qs.set("storeId", params.storeId);
    if (params.market) qs.set("market", params.market);
    if (params.platform) qs.set("platform", params.platform);
    if (params.purpose) qs.set("purpose", params.purpose);
    if (params.scene) qs.set("scene", params.scene);
    if (params.color) qs.set("color", params.color);
    if (params.tagId) qs.set("tagId", params.tagId);
    if (params.type) qs.set("type", params.type);
    if (params.folderId) qs.set("folderId", params.folderId);
    if (params.includeSubfolders === false) qs.set("includeSubfolders", "0");
    if (params.unfiled) qs.set("unfiled", "1");
    if (params.favorite) qs.set("favorite", "1");
    if (params.storageId) qs.set("storageId", params.storageId);
    if (params.minWidth) qs.set("minWidth", String(params.minWidth));
    if (params.sort) qs.set("sort", params.sort);
    if (params.page) qs.set("page", String(params.page));
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    const query = qs.toString();
    return requestJson(`/api/v1/assets${query ? `?${query}` : ""}`);
  },
  getAsset(id: string): Promise<AssetDetail> {
    return requestJson(`/api/v1/assets/${id}`);
  },
  updateAsset(
    id: string,
    payload: {
      name?: string;
      folderId?: string | null;
      purpose?: string;
      isFavorite?: boolean;
      source?: string;
      sourceUrl?: string | null;
      notes?: string;
      tagIds?: string[];
      productIds?: string[];
    }
  ): Promise<AssetDetail> {
    return requestJson(`/api/v1/assets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  batchAssets(payload: {
    assetIds: string[];
    action:
      | "move_folder"
      | "add_tags"
      | "remove_tags"
      | "link_products"
      | "unlink_products"
      | "soft_delete";
    folderId?: string | null;
    tagIds?: string[];
    productIds?: string[];
  }): Promise<{ affectedCount: number }> {
    return requestJson("/api/v1/assets/batch", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  async uploadAssets(
    files: File[],
    options: {
      compressImages?: boolean;
      preparedFiles?: PreparedUploadFile[];
      compressionSummary?: ImageUploadSizes | null;
      onCompressionProgress?: (progress: CompressionBatchProgress) => void;
      onUploadProgress?: (progress: UploadTransferProgress) => void;
      productId?: string;
      folderId?: string | null;
      storageId?: string;
      purpose?: string;
      tagIds?: string[];
      source?: string;
      notes?: string;
      promptText?: string;
    } = {}
  ) {
    const form = new FormData();
    if (options.productId) form.append("productId", options.productId);
    if (options.folderId) form.append("folderId", options.folderId);
    if (options.storageId) form.append("storageId", options.storageId);
    if (options.purpose) form.append("purpose", options.purpose);
    if (options.tagIds && options.tagIds.length > 0) {
      form.append("tagIds", JSON.stringify(options.tagIds));
    }
    if (options.source) form.append("source", options.source);
    if (options.notes) form.append("notes", options.notes);
    if (options.promptText) form.append("promptText", options.promptText);
    const { compression, totalBytes } = await appendUploadFiles(form, "files", files, {
      compressImages: options.compressImages,
      preparedFiles: options.preparedFiles,
      compressionSummary: options.compressionSummary,
      onCompressionProgress: options.onCompressionProgress
    });
    const result = await uploadFormJson<{
      items: AssetDetail[];
      uploadedCount: number;
      deduplicatedCount: number;
    }>("/api/v1/assets/upload", form, options.onUploadProgress, totalBytes);
    return { ...result, compression };
  },
  async appendAssetVersion(
    assetId: string,
    file: File,
    options: {
      compressImages?: boolean;
      preparedFile?: PreparedUploadFile;
      preparedFiles?: PreparedUploadFile[];
      compressionSummary?: ImageUploadSizes | null;
      onCompressionProgress?: (progress: CompressionBatchProgress) => void;
      onUploadProgress?: (progress: UploadTransferProgress) => void;
      storageId?: string;
      changeNote?: string;
      promptText?: string;
      referenceAssetVersionId?: string;
      setAsCurrent?: boolean;
    } = {}
  ) {
    const form = new FormData();
    if (options.storageId) form.append("storageId", options.storageId);
    if (options.changeNote) form.append("changeNote", options.changeNote);
    if (options.promptText) form.append("promptText", options.promptText);
    if (options.referenceAssetVersionId) {
      form.append("referenceAssetVersionId", options.referenceAssetVersionId);
    }
    if (options.setAsCurrent !== undefined) {
      form.append("setAsCurrent", options.setAsCurrent ? "true" : "false");
    }
    const preparedFiles =
      options.preparedFiles ?? (options.preparedFile ? [options.preparedFile] : undefined);
    const { compression, totalBytes } = await appendUploadFiles(form, "file", [file], {
      compressImages: options.compressImages,
      preparedFiles,
      compressionSummary: options.compressionSummary,
      onCompressionProgress: options.onCompressionProgress
    });
    const result = await uploadFormJson<{
      asset: AssetDetail;
      version: AssetVersionRecord;
      deduplicated: boolean;
    }>(`/api/v1/assets/${encodeURIComponent(assetId)}/versions`, form, options.onUploadProgress, totalBytes);
    return { ...result, compression };
  },
  switchAssetCurrentVersion(assetId: string, versionId: string): Promise<AssetDetail> {
    return requestJson(`/api/v1/assets/${encodeURIComponent(assetId)}/current-version`, {
      method: "POST",
      body: JSON.stringify({ versionId })
    });
  },
  listProductMasterImages(
    productId: string,
    includeHistory = false
  ): Promise<{ items: ProductMasterImageRecord[] }> {
    return requestJson(
      `/api/v1/products/${encodeURIComponent(productId)}/master-images${includeHistory ? "?includeHistory=1" : ""}`
    );
  },
  lockProductMasterImage(
    productId: string,
    payload: {
      assetVersionId: string;
      angle: string;
      isPrimary?: boolean;
      lockNote?: string;
    }
  ): Promise<ProductMasterImageRecord> {
    return requestJson(`/api/v1/products/${encodeURIComponent(productId)}/master-images`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  setPrimaryMasterImage(
    productId: string,
    masterId: string
  ): Promise<ProductMasterImageRecord> {
    return requestJson(
      `/api/v1/products/${encodeURIComponent(productId)}/master-images/${encodeURIComponent(masterId)}/primary`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  },
  unlockProductMasterImage(
    productId: string,
    masterId: string,
    payload: {
      unlockNote: string;
      replacementAssetVersionId?: string;
      replacementAngle?: string;
      replacementLockNote?: string;
    }
  ): Promise<{ unlocked: ProductMasterImageRecord; replacement: ProductMasterImageRecord | null }> {
    return requestJson(
      `/api/v1/products/${encodeURIComponent(productId)}/master-images/${encodeURIComponent(masterId)}/unlock`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    );
  },
  regenerateThumbnail(
    assetId: string,
    versionId: string
  ): Promise<{ versionId: string; thumbStatus: string; regenerated: boolean }> {
    return requestJson(`/api/v1/assets/${assetId}/versions/${versionId}/regenerate-thumbnail`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  thumbnailUrl(assetId: string, versionId: string, bust?: number): string {
    return `/api/v1/assets/${assetId}/versions/${versionId}/thumbnail${bust ? `?t=${bust}` : ""}`;
  },
  contentUrl(assetId: string, versionId: string, preview = false): string {
    return `/api/v1/assets/${assetId}/versions/${versionId}/content${preview ? "?preview=1" : ""}`;
  },
  getTrash(): Promise<TrashResponse> {
    return requestJson("/api/v1/trash");
  },
  restoreTrash(
    type: "asset" | "product" | "listing",
    ids: string[]
  ): Promise<{ restoredCount: number }> {
    return requestJson("/api/v1/trash/restore", {
      method: "POST",
      body: JSON.stringify({ type, ids })
    });
  },
  runTrashGc(forceIgnoreRetention = false): Promise<{ job: JobRecord }> {
    return requestJson("/api/v1/trash/gc", {
      method: "POST",
      body: JSON.stringify({ forceIgnoreRetention })
    });
  },
  testStorageProvider(providerId: string): Promise<StorageTestResponse> {
    return requestJson(`/api/v1/storage/providers/${encodeURIComponent(providerId)}/test`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  switchDefaultStorage(
    storageId: string
  ): Promise<{ defaultStorageId: string; provider: StorageProviderSummary }> {
    return requestJson("/api/v1/storage/default", {
      method: "POST",
      body: JSON.stringify({ storageId })
    });
  },
  deleteStorageProvider(providerId: string): Promise<{ deleted: true; id: string }> {
    return requestJson(`/api/v1/storage/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE"
    });
  },
  previewStorageMigration(payload: {
    sourceStorageId: string;
    targetStorageId: string;
    scope?: MigrationScopeInput;
  }): Promise<MigrationPreviewResponse> {
    return requestJson("/api/v1/storage/migrations/preview", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  startStorageMigration(payload: {
    sourceStorageId: string;
    targetStorageId: string;
    scope?: MigrationScopeInput;
  }): Promise<{ job: JobRecord; preview: MigrationPreviewResponse }> {
    return requestJson("/api/v1/storage/migrations", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  getStorageCleanupQueue(
    status?: StorageCleanupItem["status"]
  ): Promise<StorageCleanupQueueResponse> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return requestJson(`/api/v1/storage/cleanup-queue${qs}`);
  },
  confirmStorageCleanup(payload: {
    ids?: string[];
    allAwaiting?: boolean;
  }): Promise<{ job: JobRecord; queuedCount: number }> {
    return requestJson("/api/v1/storage/cleanup-queue/confirm", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  getJob(jobId: string): Promise<JobRecord> {
    return requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
  },
  retryJob(jobId: string): Promise<JobRecord> {
    return requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  cancelJob(jobId: string): Promise<JobRecord> {
    return requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  clearThumbnailCache(): Promise<CacheClearResult> {
    return requestJson("/api/v1/cache/clear", {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  getBackups(): Promise<{ items: BackupRecord[] }> {
    return requestJson("/api/v1/backups");
  },
  createBackup(kind: BackupKind): Promise<{ backup: BackupRecord; job: JobRecord }> {
    return requestJson("/api/v1/backups", {
      method: "POST",
      body: JSON.stringify({ kind })
    });
  },
  backupDownloadUrl(backupId: string): string {
    return `/api/v1/backups/${encodeURIComponent(backupId)}/download`;
  },
  getDictionaries(params: {
    category?: DictionaryCategory;
    activeOnly?: boolean;
  } = {}): Promise<DictionariesResponse> {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.activeOnly) qs.set("activeOnly", "1");
    const query = qs.toString();
    return requestJson(`/api/v1/dictionaries${query ? `?${query}` : ""}`);
  },
  upsertDictionary(payload: {
    category: DictionaryCategory;
    code: string;
    label: string;
    isActive?: boolean;
    position?: number;
  }): Promise<DictionaryRecord> {
    return requestJson("/api/v1/dictionaries", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateDictionary(
    category: DictionaryCategory,
    code: string,
    payload: {
      label?: string;
      isActive?: boolean;
      position?: number;
    }
  ): Promise<DictionaryRecord> {
    return requestJson(
      `/api/v1/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(code)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload)
      }
    );
  },
  listStores(params: {
    q?: string;
    platform?: string;
    market?: string;
    status?: StoreStatus;
  } = {}): Promise<{ items: StoreRecord[] }> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.platform) qs.set("platform", params.platform);
    if (params.market) qs.set("market", params.market);
    if (params.status) qs.set("status", params.status);
    const query = qs.toString();
    return requestJson(`/api/v1/stores${query ? `?${query}` : ""}`);
  },
  createStore(payload: {
    name: string;
    platform: string;
    market: string;
    defaultLanguage: string;
    status?: StoreStatus;
    notes?: string;
  }): Promise<StoreRecord> {
    return requestJson("/api/v1/stores", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateStore(
    id: string,
    payload: {
      name?: string;
      platform?: string;
      market?: string;
      defaultLanguage?: string;
      status?: StoreStatus;
      notes?: string;
    }
  ): Promise<StoreRecord> {
    return requestJson(`/api/v1/stores/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  deleteStore(id: string): Promise<{ deleted: boolean; id: string }> {
    return requestJson(`/api/v1/stores/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  },
  listListings(params: {
    q?: string;
    productId?: string;
    storeId?: string;
    platform?: string;
    market?: string;
    status?: ListingStatus;
    page?: number;
    pageSize?: number;
  } = {}): Promise<PaginatedResponse<ListingSummary>> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.productId) qs.set("productId", params.productId);
    if (params.storeId) qs.set("storeId", params.storeId);
    if (params.platform) qs.set("platform", params.platform);
    if (params.market) qs.set("market", params.market);
    if (params.status) qs.set("status", params.status);
    if (params.page) qs.set("page", String(params.page));
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    const query = qs.toString();
    return requestJson(`/api/v1/listings${query ? `?${query}` : ""}`);
  },
  createListing(payload: {
    productId: string;
    storeId: string;
    displayName: string;
    language?: string;
    externalId?: string | null;
    externalUrl?: string | null;
    status?: ListingStatus;
    notes?: string;
    skuIds?: string[];
  }): Promise<ListingDetail> {
    return requestJson("/api/v1/listings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  getListing(id: string): Promise<ListingDetail> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}`);
  },
  updateListing(
    id: string,
    payload: {
      displayName?: string;
      language?: string;
      externalId?: string | null;
      externalUrl?: string | null;
      status?: ListingStatus;
      notes?: string;
    }
  ): Promise<ListingDetail> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  deleteListing(id: string): Promise<{ id: string; deletedAt: string }> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  },
  duplicateListing(
    id: string,
    payload: {
      storeId?: string;
      displayName?: string;
      language?: string;
    } = {}
  ): Promise<ListingDetail> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  syncListingSkus(
    id: string,
    items: Array<{ skuId: string; channelCode?: string; displayName?: string }>
  ): Promise<ListingDetail> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/skus`, {
      method: "PUT",
      body: JSON.stringify({ items })
    });
  },
  getListingAssetSets(id: string): Promise<ListingAssetSetsResponse> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/asset-sets`);
  },
  replaceListingAssetSet(
    id: string,
    kind: AssetSetKind,
    items: Array<{ assetVersionId: string; listingSkuId?: string | null }>,
    expectedItemIds?: string[]
  ): Promise<ListingAssetSetsResponse> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/asset-sets/${kind}`, {
      method: "PUT",
      body: JSON.stringify({ items, expectedItemIds })
    });
  },
  getListingPdp(id: string): Promise<ListingPdpResponse> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/pdp`);
  },
  saveListingPdpDraft(
    id: string,
    payload: { language?: string; content: PdpContent }
  ): Promise<ListingPdpResponse> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/pdp/draft`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  },
  createListingPdpVersion(
    id: string,
    payload: { note?: string } = {}
  ): Promise<{ version: PdpVersionRecord; pdp: ListingPdpResponse }> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/pdp/versions`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  restoreListingPdpVersion(id: string, versionId: string): Promise<ListingPdpResponse> {
    return requestJson(
      `/api/v1/listings/${encodeURIComponent(id)}/pdp/restore/${encodeURIComponent(versionId)}`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  },
  copyListingPdpTo(
    id: string,
    payload: {
      targetListingId: string;
      versionId?: string;
      keepTargetLanguage?: boolean;
    }
  ): Promise<ListingPdpResponse> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(id)}/pdp/copy-to`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  // M4: Export templates, preflight validation, immutable releases, exports & restore
  listExportTemplates(params?: {
    platform?: string;
    market?: string;
  }): Promise<{ items: ExportTemplateRecord[] }> {
    const sp = new URLSearchParams();
    if (params?.platform) sp.set("platform", params.platform);
    if (params?.market) sp.set("market", params.market);
    const qs = sp.toString();
    return requestJson(`/api/v1/export-templates${qs ? `?${qs}` : ""}`);
  },
  createExportTemplate(payload: {
    name: string;
    platform: string;
    market: string;
    isDefault?: boolean;
    rules: ExportTemplateRules;
  }): Promise<ExportTemplateRecord> {
    return requestJson("/api/v1/export-templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateExportTemplate(
    id: string,
    payload: {
      name?: string;
      platform?: string;
      market?: string;
      isDefault?: boolean;
      rules?: ExportTemplateRules;
    }
  ): Promise<ExportTemplateRecord> {
    return requestJson(`/api/v1/export-templates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  validateListing(listingId: string, templateId?: string): Promise<ListingValidationResult> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(listingId)}/validate`, {
      method: "POST",
      body: JSON.stringify(templateId ? { templateId } : {})
    });
  },
  createRelease(
    listingId: string,
    payload: { templateId?: string; isDraftPackage?: boolean; note?: string }
  ): Promise<ReleaseDetail> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(listingId)}/releases`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  listListingReleases(listingId: string): Promise<{ items: ReleaseSummary[] }> {
    return requestJson(`/api/v1/listings/${encodeURIComponent(listingId)}/releases`);
  },
  getReleaseDetail(releaseId: string): Promise<ReleaseDetail> {
    return requestJson(`/api/v1/releases/${encodeURIComponent(releaseId)}`);
  },
  restoreReleaseDraft(
    releaseId: string,
    payload: { displayName?: string; storeId?: string } = {}
  ): Promise<ListingDetail> {
    return requestJson(`/api/v1/releases/${encodeURIComponent(releaseId)}/restore-draft`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  enqueueReleaseExport(
    releaseId: string
  ): Promise<{ exportRecord: ExportRecord; job: JobRecord }> {
    return requestJson(`/api/v1/releases/${encodeURIComponent(releaseId)}/exports`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  exportDownloadUrl(exportId: string): string {
    return `/api/v1/exports/${encodeURIComponent(exportId)}/download`;
  },
  async downloadStandardOpenExport(payload: {
    productId?: string;
    assetIds?: string[];
    includeAllVersions?: boolean;
  }): Promise<void> {
    const res = await fetch("/api/v1/assets/export-standard", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-AssetNest-Request": "1"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiClientError(
        res.status,
        errBody?.error?.code ?? "INTERNAL_ERROR",
        errBody?.error?.message ?? `导出失败 (${res.status})`
      );
    }
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const fileName = match?.[1] || `assetnest-open-export-${Date.now()}.zip`;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  },
  restoreBackupById(
    backupId: string,
    targetStorageMapping?: Record<string, string>
  ): Promise<RestoreBackupResult> {
    return requestJson("/api/v1/backups/restore", {
      method: "POST",
      body: JSON.stringify({ backupId, targetStorageMapping })
    });
  },
  async restoreBackupUpload(
    file: File,
    targetStorageMapping?: Record<string, string>
  ): Promise<RestoreBackupResult> {
    const form = new FormData();
    form.append("file", file);
    if (targetStorageMapping && Object.keys(targetStorageMapping).length > 0) {
      form.append("targetStorageMapping", JSON.stringify(targetStorageMapping));
    }
    const res = await fetch("/api/v1/backups/restore", {
      method: "POST",
      credentials: "include",
      headers: {
        "X-AssetNest-Request": "1"
      },
      body: form
    });
    const data = (await res.json().catch(() => null)) as
      | RestoreBackupResult
      | ApiErrorBody
      | null;
    if (!res.ok) {
      const errBody = data as ApiErrorBody | null;
      throw new ApiClientError(
        res.status,
        errBody?.error?.code ?? "INTERNAL_ERROR",
        errBody?.error?.message ?? `恢复失败 (${res.status})`
      );
    }
    return data as RestoreBackupResult;
  }
};
