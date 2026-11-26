import { useCallback, useEffect, useState } from "react";
import { AlertCircle, HardDrive, RefreshCw } from "lucide-react";
import type { StorageProviderSummary } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { StorageStatusBadge } from "../components/StatusBadge";

export function StoragePage() {
  const [providers, setProviders] = useState<StorageProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getStorageProviders();
      setProviders(res.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载存储列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">存储管理</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            连接参数与密钥仅由 config.yaml 及环境变量管理，绝不写入 SQLite 或前端响应
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>刷新状态</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
              <th className="px-4 py-3">存储名称 / ID</th>
              <th className="px-4 py-3">协议</th>
              <th className="px-4 py-3">启用状态</th>
              <th className="px-4 py-3">健康状态</th>
              <th className="px-4 py-3">最近检测</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {providers.map((provider) => (
              <tr key={provider.id} className="hover:bg-gray-50/70">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 font-medium text-gray-900">
                    <HardDrive className="h-4 w-4 text-gray-400" />
                    <span>{provider.name}</span>
                    {provider.isDefault && (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                        默认
                      </span>
                    )}
                  </div>
                  <div className="font-mono-tabular mt-0.5 text-xs text-gray-500">{provider.id}</div>
                </td>
                <td className="font-mono-tabular px-4 py-3 text-xs text-gray-700">
                  {provider.type.toUpperCase()}
                </td>
                <td className="px-4 py-3 text-xs text-gray-700">
                  {provider.enabled ? "已启用" : "已禁用"}
                </td>
                <td className="px-4 py-3">
                  <StorageStatusBadge status={provider.status} />
                  {provider.lastError && (
                    <div className="mt-1 text-xs text-rose-600">{provider.lastError}</div>
                  )}
                </td>
                <td className="font-mono-tabular px-4 py-3 text-xs text-gray-500">
                  {provider.lastTestedAt
                    ? new Date(provider.lastTestedAt).toLocaleString("zh-CN")
                    : "尚未执行检测"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
