import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { ActivityRecord, JobRecord } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { JobStatusBadge } from "../components/StatusBadge";

export function JobsPage() {
  const [tab, setTab] = useState<"jobs" | "activities">("jobs");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobsRes, actRes] = await Promise.all([api.getJobs(1, 50), api.getActivities(1, 50)]);
      setJobs(jobsRes.items);
      setActivities(actRes.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载记录失败");
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
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">任务与审计日志</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            查看持久化后台任务执行记录与脱敏后的系统审计事件
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
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
                  <th className="px-4 py-3">进度 / 阶段</th>
                  <th className="px-4 py-3">重试次数</th>
                  <th className="px-4 py-3">创建时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="font-mono-tabular px-4 py-3 text-gray-900">
                      {job.type} · {job.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      <JobStatusBadge status={job.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {job.progressStage || "-"}
                      {job.progressTotal !== null
                        ? ` (${job.progressCurrent}/${job.progressTotal})`
                        : job.progressCurrent > 0
                          ? ` (${job.progressCurrent})`
                          : ""}
                    </td>
                    <td className="font-mono-tabular px-4 py-3 text-gray-600">
                      {job.attempts} / {job.maxAttempts}
                    </td>
                    <td className="font-mono-tabular px-4 py-3 text-gray-500">
                      {new Date(job.createdAt).toLocaleString("zh-CN")}
                    </td>
                  </tr>
                ))}
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
