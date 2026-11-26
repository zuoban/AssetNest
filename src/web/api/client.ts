import type {
  ActivityRecord,
  ApiErrorBody,
  AppSettings,
  AppearanceConstraints,
  AssetDetail,
  AssetListItem,
  AssetType,
  AuthMeResponse,
  DashboardResponse,
  FolderRecord,
  JobRecord,
  PaginatedResponse,
  ProductDetail,
  ProductSpec,
  ProductStatus,
  ProductSummary,
  ReviewStatus,
  SetupStatusResponse,
  SkuRecord,
  SkuStatus,
  StorageProviderSummary,
  TagDimension,
  TagRecord,
  TrashResponse,
  UserProfile
} from "../../shared/types";

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

export const api = {
  getSetupStatus(): Promise<SetupStatusResponse> {
    return requestJson("/api/v1/setup/status");
  },
  initAdmin(payload: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<{ user: UserProfile }> {
    return requestJson("/api/v1/setup/init", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  login(payload: { username: string; password: string }): Promise<{ user: UserProfile }> {
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
  updateFolder(id: string, payload: { name?: string; parentId?: string | null }): Promise<FolderRecord> {
    return requestJson(`/api/v1/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
  },
  deleteFolder(id: string): Promise<{ deleted: boolean; id: string }> {
    return requestJson(`/api/v1/folders/${id}`, {
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
    market?: string;
    platform?: string;
    purpose?: string;
    scene?: string;
    color?: string;
    tagId?: string;
    type?: AssetType;
    reviewStatus?: ReviewStatus;
    folderId?: string;
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
    if (params.market) qs.set("market", params.market);
    if (params.platform) qs.set("platform", params.platform);
    if (params.purpose) qs.set("purpose", params.purpose);
    if (params.scene) qs.set("scene", params.scene);
    if (params.color) qs.set("color", params.color);
    if (params.tagId) qs.set("tagId", params.tagId);
    if (params.type) qs.set("type", params.type);
    if (params.reviewStatus) qs.set("reviewStatus", params.reviewStatus);
    if (params.folderId) qs.set("folderId", params.folderId);
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
      | "set_review_status"
      | "soft_delete";
    folderId?: string | null;
    tagIds?: string[];
    productIds?: string[];
    reviewStatus?: ReviewStatus;
    reviewNote?: string;
  }): Promise<{ affectedCount: number }> {
    return requestJson("/api/v1/assets/batch", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  uploadAssets(
    files: File[],
    options: {
      productId?: string;
      folderId?: string | null;
      storageId?: string;
      purpose?: string;
      tagIds?: string[];
      source?: string;
      notes?: string;
      promptText?: string;
    } = {}
  ): Promise<{ items: AssetDetail[]; uploadedCount: number; deduplicatedCount: number }> {
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
    for (const file of files) {
      form.append("files", file, file.name);
    }
    return requestJson("/api/v1/assets/upload", {
      method: "POST",
      body: form
    });
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
  restoreTrash(type: "asset" | "product", ids: string[]): Promise<{ restoredCount: number }> {
    return requestJson("/api/v1/trash/restore", {
      method: "POST",
      body: JSON.stringify({ type, ids })
    });
  }
};
