import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowUpRight, Images, Layers, Package, RefreshCw } from "lucide-react";
import type { DashboardResponse } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { JobStatusBadge, StorageStatusBadge } from "../components/StatusBadge";
import { formatDateTime } from "../utils/format";
import { formatActivityAction, formatJobType, formatObjectType } from "../utils/labels";

export function DashboardPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDashboard();
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载工作台数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = data
    ? [
        { label: "商品档案", value: data.counts.products, hint: "未软删除商品数", to: "/products" },
        { label: "数字素材", value: data.counts.assets, hint: "未软删除素材数", to: "/assets" },
        { label: "上架草稿", value: data.counts.draftListings, hint: "草稿状态 Listing", to: "/listings?status=draft" },
        { label: "执行中任务", value: data.counts.runningJobs, hint: "排队与运行中", to: "/jobs" },
        {
          label: "失败任务",
          value: data.counts.failedJobs,
          hint: "需关注重试",
          to: "/jobs",
          highlight: data.counts.failedJobs > 0 ? "rose" : undefined
        }
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">工作台</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            全部指标与活动流均实时统计自本地 SQLite 数据库
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/products"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Package className="h-3.5 w-3.5" />
            <span>商品中心</span>
          </Link>
          <Link
            to="/listings"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Layers className="h-3.5 w-3.5" />
            <span>上架工作台</span>
          </Link>
          <Link
            to="/assets"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Images className="h-3.5 w-3.5" />
            <span>进入素材库</span>
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>刷新数据</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {stats.map((card) => {
          const content = (
            <>
              <div className="flex items-center justify-between text-xs font-medium text-gray-500">
                <span>{card.label}</span>
                {card.to && (
                  <ArrowUpRight className="h-3.5 w-3.5 text-gray-300 transition-colors group-hover:text-blue-600" />
                )}
              </div>
              <div
                className={`font-mono-tabular mt-1.5 text-2xl font-semibold ${
                  card.highlight === "rose" ? "text-rose-600" : "text-gray-900"
                }`}
              >
                {card.value}
              </div>
              <div className="mt-1 text-[11px] text-gray-400">{card.hint}</div>
            </>
          );
          return card.to ? (
            <Link
              key={card.label}
              to={card.to}
              className="group rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-blue-300 hover:bg-blue-50/15"
            >
              {content}
            </Link>
          ) : (
            <div
              key={card.label}
              className="rounded-xl border border-gray-200 bg-white p-4"
            >
              {content}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">存储空间状态</h2>
          {!data || data.storageSummary.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-400">暂无已配置存储空间</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {data.storageSummary.map((item) => (
                <div key={item.id} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <span>{item.name}</span>
                      {item.isDefault && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                          默认存储
                        </span>
                      )}
                    </div>
                    <div className="font-mono-tabular mt-0.5 text-xs text-gray-500">
                      ID: {item.id} · 协议: {item.type.toUpperCase()}
                    </div>
                  </div>
                  <StorageStatusBadge status={item.status} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">最近后台任务</h2>
          {!data || data.recentJobs.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-400">当前无后台任务记录</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {data.recentJobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-gray-900">
                      <span>{formatJobType(job.type)}</span>
                      <span className="font-mono-tabular text-[11px] font-normal text-gray-400">
                        #{job.id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500">
                      {job.progressStage || "等待调度"}
                    </div>
                  </div>
                  <JobStatusBadge status={job.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">最近系统活动（审计流）</h2>
          <Link
            to="/jobs?tab=activities"
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            查看完整记录 →
          </Link>
        </div>
        {!data || data.recentActivities.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-400">暂无审计事件</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {data.recentActivities.map((evt) => (
              <div
                key={evt.id}
                className="flex flex-col justify-between gap-1 py-2.5 sm:flex-row sm:items-center"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-800">
                  <span className="font-medium" title={evt.action}>
                    {formatActivityAction(evt.action)}
                  </span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                    {formatObjectType(evt.objectType)}
                  </span>
                  {evt.objectId && (
                    <span className="font-mono-tabular text-[11px] text-gray-400">
                      #{evt.objectId.slice(0, 8)}
                    </span>
                  )}
                </div>
                <div className="font-mono-tabular text-[11px] text-gray-500">
                  {formatDateTime(evt.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
