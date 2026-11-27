import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Database,
  Download,
  Eraser,
  RefreshCw,
  RotateCcw,
  Upload
} from "lucide-react";
import type {
  AppSettings,
  BackupKind,
  BackupRecord,
  RestoreBackupResult
} from "../../shared/types";
import { api, ApiClientError, isAbortError } from "../api/client";
import { LatestRequestController, startSafePolling } from "../utils/asyncControl";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { formatBytes, formatDateTime } from "../utils/format";

interface SettingsPageProps {
  onTimezoneChanged?: () => Promise<void>;
}

export function SettingsPage({ onTimezoneChanged }: SettingsPageProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [trashRetentionDays, setTrashRetentionDays] = useState(30);
  const [exportTtlHours, setExportTtlHours] = useState(72);
  const [appTimezone, setAppTimezone] = useState("Asia/Shanghai");
  const [saving, setSaving] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState<BackupKind | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreBackupResult | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);

  const [loadReq] = useState(() => new LatestRequestController());
  const [backupsReq] = useState(() => new LatestRequestController());

  const load = useCallback(async () => {
    const req = loadReq.next();
    backupsReq.abort();
    setError(null);
    try {
      const [res, backupsRes] = await Promise.all([
        api.getSettings({ signal: req.signal }),
        api.getBackups({ signal: req.signal })
      ]);
      if (!loadReq.isCurrent(req.id)) return;
      setSettings(res);
      setBackups(backupsRes.items);
      setTrashRetentionDays(res.trashRetentionDays);
      setExportTtlHours(res.exportTtlHours);
      setAppTimezone(res.appTimezone);
    } catch (err) {
      if (!loadReq.isCurrent(req.id) || isAbortError(err)) return;
      setError(err instanceof ApiClientError ? err.message : "加载设置失败");
    } finally {
      loadReq.finish(req.id);
    }
  }, [backupsReq, loadReq]);

  useEffect(() => {
    void load();
    return () => {
      loadReq.abort();
      backupsReq.abort();
    };
  }, [backupsReq, load, loadReq]);

  const hasCreatingBackup = backups.some((b) => b.status === "creating");
  useEffect(() => {
    if (!hasCreatingBackup) return;
    return startSafePolling(async (signal) => {
      if (loadReq.isInFlight()) return;
      const req = backupsReq.next(signal);
      try {
        const r = await api.getBackups({ signal: req.signal });
        if (!backupsReq.isCurrent(req.id)) return;
        setBackups(r.items);
      } catch (err) {
        if (!backupsReq.isCurrent(req.id) || isAbortError(err)) return;
      } finally {
        backupsReq.finish(req.id);
      }
    }, 2000);
  }, [backupsReq, hasCreatingBackup, loadReq]);

  const handleCreateBackup = async (kind: BackupKind) => {
    setCreatingBackup(kind);
    setError(null);
    setSavedMsg(null);
    try {
      const res = await api.createBackup(kind);
      setSavedMsg(
        `已入队${kind === "full" ? "完整" : "元数据"}备份任务 ${res.job.id.slice(0, 8)}，生成完成后可直接下载 ZIP 备份包`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "创建备份任务失败");
    } finally {
      setCreatingBackup(null);
    }
  };

  const handleRestoreById = (backup: BackupRecord) => {
    setConfirmDialog({
      title: "从历史备份恢复数据",
      description:
        `确认从备份 ${backup.id.slice(0, 8)}（${backup.kind === "full" ? "完整备份" : "元数据备份"}）进入维护模式恢复吗？\n` +
        "恢复前将自动校验 SHA-256 与数据库完整性，并在覆盖当前库之前保留 .pre-restore 自动回滚点。",
      confirmLabel: "进入维护模式并恢复",
      tone: "danger",
      onConfirm: async () => {
        setRestoringBackup(true);
        setError(null);
        setSavedMsg(null);
        setRestoreResult(null);
        try {
          const res = await api.restoreBackupById(backup.id);
          setRestoreResult(res);
          setConfirmDialog(null);
          const totalIndexed =
            res.reindexed.products + res.reindexed.assets + res.reindexed.listings;
          setSavedMsg(
            `备份恢复成功：已校验并切换数据库（Schema v${res.schemaVersion}），恢复 ${res.restoredFileCount} 个物理文件，重建 ${totalIndexed} 条 FTS 索引。`
          );
          await load();
          if (onTimezoneChanged) {
            await onTimezoneChanged();
          }
        } catch (err) {
          setConfirmDialog(null);
          setError(err instanceof ApiClientError ? err.message : "从备份恢复失败");
        } finally {
          setRestoringBackup(false);
        }
      }
    });
  };

  const handleRestoreFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setConfirmDialog({
      title: "上传备份包并恢复",
      description:
        `确认上传并从备份包「${file.name}」进入维护模式恢复吗？\n` +
        "校验不通过时将直接拒绝并保持当前实例数据完好无损。",
      confirmLabel: "上传并恢复",
      tone: "danger",
      onConfirm: async () => {
        setRestoringBackup(true);
        setError(null);
        setSavedMsg(null);
        setRestoreResult(null);
        try {
          const res = await api.restoreBackupUpload(file);
          setRestoreResult(res);
          setConfirmDialog(null);
          const totalIndexed =
            res.reindexed.products + res.reindexed.assets + res.reindexed.listings;
          setSavedMsg(
            `上传备份恢复成功：已切换数据库（Schema v${res.schemaVersion}），恢复 ${res.restoredFileCount} 个物理文件，重建 ${totalIndexed} 条 FTS 索引。`
          );
          await load();
          if (onTimezoneChanged) {
            await onTimezoneChanged();
          }
        } catch (err) {
          setConfirmDialog(null);
          setError(err instanceof ApiClientError ? err.message : "上传备份包恢复失败");
        } finally {
          setRestoringBackup(false);
        }
      }
    });
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    setError(null);
    setSavedMsg(null);
    try {
      const res = await api.clearThumbnailCache();
      setSavedMsg(
        `已清理 ${res.clearedFiles} 个本地缩略图缓存文件，释放 ${formatBytes(res.freedBytes)}；原文件、SQLite 数据库与历史记录均不受影响。`
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "清理缩略图缓存失败");
    } finally {
      setClearingCache(false);
    }
  };

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
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">通用设置</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          管理回收站保留期、导出包过期时长、一致性备份与本地缩略图缓存
        </p>
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

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Database className="h-4 w-4 text-blue-600" />
              <span>一致性备份管理</span>
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              通过 SQLite <code className="font-mono-tabular">VACUUM INTO</code> 生成事务一致快照并输出含{" "}
              <code className="font-mono-tabular">manifest.json</code> 与 SHA-256 校验信息的 ZIP 包（绝不含外部存储密钥）。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={creatingBackup !== null}
              onClick={() => void handleCreateBackup("metadata")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
            >
              <Database className="h-3.5 w-3.5 text-blue-600" />
              <span>{creatingBackup === "metadata" ? "提交中..." : "创建元数据备份"}</span>
            </button>
            <button
              type="button"
              disabled={creatingBackup !== null}
              onClick={() => void handleCreateBackup("full")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              <span>{creatingBackup === "full" ? "提交中..." : "创建完整备份（含原文件）"}</span>
            </button>
            <input
              ref={restoreFileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => void handleRestoreFileChange(e)}
              className="hidden"
            />
            <button
              type="button"
              disabled={restoringBackup}
              onClick={() => restoreFileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>{restoringBackup ? "维护模式恢复中..." : "上传 ZIP 恢复"}</span>
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {restoreResult && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-900">
            <div className="font-semibold">维护模式恢复完成</div>
            <div className="mt-1 grid grid-cols-2 gap-2 font-mono-tabular text-[11px] sm:grid-cols-4">
              <div>备份类型：{restoreResult.kind === "full" ? "完整备份" : "元数据备份"}</div>
              <div>Schema：v{restoreResult.schemaVersion}</div>
              <div>
                已恢复文件：{restoreResult.restoredFileCount}（复用 {restoreResult.reusedFileCount}）
              </div>
              <div>
                重建索引：{restoreResult.reindexed.products} 商品 / {restoreResult.reindexed.assets} 素材 /{" "}
                {restoreResult.reindexed.listings} 上架
              </div>
            </div>
          </div>
        )}

        {backups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400">
            尚未创建任何一致性备份
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                  <th className="px-3 py-2.5">备份类型 / ID</th>
                  <th className="px-3 py-2.5">状态</th>
                  <th className="px-3 py-2.5">Schema / 文件数</th>
                  <th className="px-3 py-2.5">体积 / SHA-256</th>
                  <th className="px-3 py-2.5">创建时间</th>
                  <th className="px-3 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {backups.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50/70">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-gray-900">
                        {item.kind === "full" ? "完整备份（DB + 原文件）" : "元数据备份（仅 DB）"}
                      </div>
                      <div className="font-mono-tabular text-[11px] text-gray-500">
                        {item.id.slice(0, 8)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                          item.status === "ready"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : item.status === "creating"
                              ? "border-blue-200 bg-blue-50 text-blue-700"
                              : "border-rose-200 bg-rose-50 text-rose-700"
                        }`}
                      >
                        {item.status === "ready"
                          ? "可下载"
                          : item.status === "creating"
                            ? "生成中"
                            : "失败"}
                      </span>
                      {item.lastError && (
                        <div className="mt-1 max-w-xs text-[11px] text-rose-600">
                          {item.lastError}
                        </div>
                      )}
                    </td>
                    <td className="font-mono-tabular px-3 py-2.5 text-gray-700">
                      v{item.schemaVersion} · {item.fileCount} 文件
                    </td>
                    <td className="font-mono-tabular px-3 py-2.5 text-gray-600">
                      <div>{item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : "-"}</div>
                      {item.sha256 && (
                        <div className="text-[11px] text-gray-400" title={item.sha256}>
                          {item.sha256.slice(0, 16)}…
                        </div>
                      )}
                    </td>
                    <td className="font-mono-tabular px-3 py-2.5 text-gray-500">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {item.status === "ready" ? (
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <a
                            href={api.backupDownloadUrl(item.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                          >
                            <Download className="h-3 w-3" />
                            <span>下载 ZIP</span>
                          </a>
                          <button
                            type="button"
                            disabled={restoringBackup}
                            onClick={() => void handleRestoreById(item)}
                            className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>恢复</span>
                          </button>
                        </div>
                      ) : (
                        <Link to="/jobs" className="text-[11px] text-blue-600 hover:underline">
                          查看任务
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white p-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Eraser className="h-4 w-4 text-gray-600" />
            <span>本地缩略图缓存维护</span>
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            清空本地磁盘上的 WebP 预览缩略图缓存以释放空间；下次浏览素材时将按需自动重建，绝不影响原文件、数据库或发布快照。
          </p>
        </div>
        <button
          type="button"
          disabled={clearingCache}
          onClick={() => void handleClearCache()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
        >
          <Eraser className="h-3.5 w-3.5" />
          <span>{clearingCache ? "正在清理..." : "清理本地缩略图缓存"}</span>
        </button>
      </section>

      <ConfirmDialog
        dialog={confirmDialog}
        busy={restoringBackup}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}
