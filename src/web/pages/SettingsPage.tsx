import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { AppSettings } from "../../shared/types";
import { api, ApiClientError } from "../api/client";

interface SettingsPageProps {
  onTimezoneChanged?: () => Promise<void>;
}

export function SettingsPage({ onTimezoneChanged }: SettingsPageProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [trashRetentionDays, setTrashRetentionDays] = useState(30);
  const [exportTtlHours, setExportTtlHours] = useState(72);
  const [appTimezone, setAppTimezone] = useState("Asia/Shanghai");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getSettings();
      setSettings(res);
      setTrashRetentionDays(res.trashRetentionDays);
      setExportTtlHours(res.exportTtlHours);
      setAppTimezone(res.appTimezone);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载设置失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const updated = await api.updateSettings({
        trashRetentionDays,
        exportTtlHours,
        appTimezone
      });
      setSettings(updated);
      setSavedMsg("设置已持久化保存到 SQLite");
      if (onTimezoneChanged) {
        await onTimezoneChanged();
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">通用设置</h1>
        <p className="mt-0.5 text-xs text-gray-500">管理回收站保留期、导出包过期时长与显示时区</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {savedMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{savedMsg}</span>
        </div>
      )}

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="space-y-4 rounded-xl border border-gray-200 bg-white p-5"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="trash-days">
              回收站安全保留天数（1–365 天）
            </label>
            <input
              id="trash-days"
              type="number"
              min={1}
              max={365}
              required
              value={trashRetentionDays}
              onChange={(e) => setTrashRetentionDays(Number(e.target.value))}
              className="font-mono-tabular w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="export-ttl">
              上架导出包有效期（1–720 小时）
            </label>
            <input
              id="export-ttl"
              type="number"
              min={1}
              max={720}
              required
              value={exportTtlHours}
              onChange={(e) => setExportTtlHours(Number(e.target.value))}
              className="font-mono-tabular w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="app-tz">
            显示时区（IANA 时区，数据库内部统一存储 UTC）
          </label>
          <input
            id="app-tz"
            type="text"
            required
            value={appTimezone}
            onChange={(e) => setAppTimezone(e.target.value)}
            className="font-mono-tabular w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
          />
        </div>

        {settings && (
          <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
            当前默认存储 ID：
            <span className="font-mono-tabular font-medium text-gray-900">
              {settings.defaultStorageId}
            </span>
            {settings.initializedAt && (
              <span className="ml-4">
                初始化时间：{new Date(settings.initializedAt).toLocaleString("zh-CN")}
              </span>
            )}
          </div>
        )}

        <div className="pt-1">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "正在保存..." : "保存设置"}
          </button>
        </div>
      </form>
    </div>
  );
}
