import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, RefreshCw, RotateCw, XCircle } from "lucide-react";
import type { ActivityRecord, JobRecord, JobType } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { JobStatusBadge } from "../components/StatusBadge";
import { formatDateTime } from "../utils/format";

const JOB_TYPE_LABELS: Record<JobType, string> = {
  storage_migrate: "跨存储迁移",
  storage_cleanup: "来源对象清理",
  gc: "引用保护 GC",
  backup: "一致性备份",
  restore: "备份恢复",
  export_zip: "上架包导出",
  thumbnail: "缩略图生成",
  search_reindex: "搜索索引重建"
};

export function JobsPage() {
  const [tab, setTab] = useState<"jobs" | "activities">("jobs");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const [jobsRes, actRes] = await Promise.all([api.getJobs(1, 50), api.getActivities(1, 50)]);
      setJobs(jobsRes.items);
      setActivities(actRes.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载记录失败");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const hasActiveJobs = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => {
      void load(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [hasActiveJobs, load]);

  const handleRetry = async (jobId: string) => {
    setActingId(jobId);
    setError(null);
    setNotice(null);
    try {
      await api.retryJob(jobId);
      setNotice(`任务 ${jobId.slice(0, 8)} 已重新入队等待执行`);
      await load(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "重试任务失败");
    } finally {
      setActingId(null);
    }
  };

  const handleCancel = async (jobId: string) => {
    setActingId(jobId);
    setError(null);
    setNotice(null);
    try {
      await api.cancelJob(jobId);
      setNotice(`已向任务 ${jobId.slice(0, 8)} 发送取消指令`);
      await load(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "取消任务失败");
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">任务与审计日志</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            查看持久化后台任务执行记录与脱敏后的系统审计事件
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>刷新</span>
        </button>
      </div>

      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 text-xs font-medium">
        <button
          type="button"
          onClick={() => setTab("jobs")}
          className={`rounded-md px-3 py-1.5 transition-colors ${
            tab === "jobs" ? "bg-blue-600 text-white" : "text-gray-600 hover:text-gray-900"
          }`}
        >
          后台任务（{jobs.length}）
        </button>
        <button
          type="button"
          onClick={() => setTab("activities")}
          className={`rounded-md px-3 py-1.5 transition-colors ${
            tab === "activities" ? "bg-blue-600 text-white" : "text-gray-600 hover:text-gray-900"
          }`}
        >
          审计活动（{activities.length}）
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {tab === "jobs" ? (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          {jobs.length === 0 ? (
            <div className="py-12 text-center text-xs text-gray-400">暂无后台任务记录</div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                  <th className="px-4 py-3">任务类型 / ID</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3">进度 / 结果</th>
                  <th className="px-4 py-3">重试次数</th>
                  <th className="px-4 py-3">创建时间</th>
                  <th className="px-4 py-3 text-right">控制</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {jobs.map((job) => {
                  const pct =
                    job.progressTotal && job.progressTotal > 0
                      ? Math.min(100, Math.round((job.progressCurrent / job.progressTotal) * 100))
                      : null;
                  const canRetry = job.status === "failed" || job.status === "cancelled";
                  const canCancel =
                    (job.status === "queued" || job.status === "running") && !job.cancelRequested;
                  return (
                    <tr key={job.id} className="align-top hover:bg-gray-50/70">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">
                          {JOB_TYPE_LABELS[job.type] ?? job.type}
                        </div>
                        <div className="font-mono-tabular text-[11px] text-gray-500">
                          {job.type} · {job.id.slice(0, 8)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <JobStatusBadge status={job.status} />
                        {job.cancelRequested && job.status === "running" && (
                          <div className="mt-1 text-[11px] text-amber-600">正在安全取消...</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <div>
                          <span>{job.progressStage || "-"}</span>
                          {job.progressTotal !== null
                            ? ` (${job.progressCurrent}/${job.progressTotal})`
                            : job.progressCurrent > 0
                              ? ` (${job.progressCurrent})`
                              : ""}
                        </div>
                        {pct !== null && (
                          <div className="mt-1.5 h-1.5 w-36 overflow-hidden rounded-full bg-gray-100">
                            <div
                              className={`h-full rounded-full transition-all ${
                                job.status === "failed"
                                  ? "bg-rose-500"
                                  : job.status === "succeeded"
                                    ? "bg-emerald-500"
                                    : "bg-blue-600"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        )}
                        {job.lastError && (
                          <div className="mt-1 max-w-md text-[11px] text-rose-600">
                            {job.lastError}
                          </div>
                        )}
                        {job.result && job.status === "succeeded" && (
                          <div className="font-mono-tabular mt-1 max-w-md truncate text-[11px] text-gray-500">
                            {JSON.stringify(job.result)}
                          </div>
                        )}
                      </td>
                      <td className="font-mono-tabular px-4 py-3 text-gray-600">
                        {job.attempts} / {job.maxAttempts}
                      </td>
                      <td className="font-mono-tabular px-4 py-3 text-gray-500">
                        {formatDateTime(job.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {canRetry && (
                            <button
                              type="button"
                              disabled={actingId === job.id}
                              onClick={() => void handleRetry(job.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                            >
                              <RotateCw className="h-3 w-3" />
                              <span>重试</span>
                            </button>
                          )}
                          {canCancel && (
                            <button
                              type="button"
                              disabled={actingId === job.id}
                              onClick={() => void handleCancel(job.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                            >
                              <XCircle className="h-3 w-3" />
                              <span>取消</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          {activities.length === 0 ? (
            <div className="py-12 text-center text-xs text-gray-400">暂无审计日志</div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                  <th className="px-4 py-3">事件动作</th>
                  <th className="px-4 py-3">对象</th>
                  <th className="px-4 py-3">详情（已脱敏）</th>
                  <th className="px-4 py-3">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {activities.map((evt) => (
                  <tr key={evt.id}>
                    <td className="font-mono-tabular px-4 py-3 font-medium text-gray-900">
                      {evt.action}
                    </td>
                    <td className="font-mono-tabular px-4 py-3 text-gray-600">
                      {evt.objectType}
                      {evt.objectId ? `:${evt.objectId.slice(0, 8)}` : ""}
                    </td>
                    <td className="font-mono-tabular max-w-md truncate px-4 py-3 text-gray-500">
                      {JSON.stringify(evt.details)}
                    </td>
                    <td className="font-mono-tabular px-4 py-3 text-gray-500">
                      {new Date(evt.createdAt).toLocaleString("zh-CN")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
