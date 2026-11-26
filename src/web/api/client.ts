import type {
  ActivityRecord,
  ApiErrorBody,
  AppSettings,
  AuthMeResponse,
  DashboardResponse,
  JobRecord,
  PaginatedResponse,
  SetupStatusResponse,
  StorageProviderSummary,
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
  if (init.body !== undefined && !headers.has("Content-Type")) {
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
  }
};
