import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Images, Package, RefreshCw } from "lucide-react";
import type { DashboardResponse } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { JobStatusBadge, StorageStatusBadge } from "../components/StatusBadge";

const ACTION_LABELS: Record<string, string> = {
  "setup.init": "完成系统首次初始化",
  "auth.login": "管理员登录",
  "auth.login_failed": "登录验证失败",
  "auth.logout": "管理员退出登录",
  "auth.admin_reset_cli": "宿主机 CLI 重置管理员密码",
  "settings.update": "更新系统通用设置",
  "product.create": "创建商品",
  "product.update": "更新商品信息",
  "product.soft_delete": "商品移入回收站",
  "sku.create": "创建 SKU",
  "sku.update": "更新 SKU",
  "sku.delete": "删除 SKU",
  "asset.upload": "上传素材",
  "asset.update": "更新素材元数据",
  "asset.batch": "批量处理素材",
  "asset.regenerate_thumbnail": "重建素材缩略图",
  "trash.restore": "从回收站恢复数据"
};

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
        { label: "待审核版本", value: data.counts.pendingReviews, hint: "按素材版本统计", to: "/assets" },
        { label: "上架草稿", value: data.counts.draftListings, hint: "草稿状态 Listing", to: null },
        { label: "执行中任务", value: data.counts.runningJobs, hint: "排队与运行中", to: "/jobs" },
        { label: "失败任务", value: data.counts.failedJobs, hint: "需关注重试", to: "/jobs" }
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {stats.map((card) => {
          const content = (
            <>
              <div className="text-xs font-medium text-gray-500">{card.label}</div>
              <div className="font-mono-tabular mt-1.5 text-2xl font-semibold text-gray-900">
                {card.value}
              </div>
              <div className="mt-1 text-[11px] text-gray-400">{card.hint}</div>
            </>
          );
          return card.to ? (
            <Link
              key={card.label}
              to={card.to}
              className="rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-blue-300"
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
                    <div className="font-mono-tabular text-xs font-medium text-gray-900">
                      {job.type} · {job.id.slice(0, 8)}
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
        <h2 className="mb-3 text-sm font-semibold text-gray-900">最近系统活动（审计流）</h2>
        {!data || data.recentActivities.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-400">暂无审计事件</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {data.recentActivities.map((evt) => (
              <div
                key={evt.id}
                className="flex flex-col justify-between gap-1 py-2.5 sm:flex-row sm:items-center"
              >
                <div className="text-xs text-gray-800">
                  <span className="font-medium">{ACTION_LABELS[evt.action] || evt.action}</span>
                  <span className="font-mono-tabular ml-2 text-gray-400">
                    {evt.objectType}
                    {evt.objectId ? `#${evt.objectId.slice(0, 8)}` : ""}
                  </span>
                </div>
                <div className="font-mono-tabular text-[11px] text-gray-500">
                  {new Date(evt.createdAt).toLocaleString("zh-CN")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
