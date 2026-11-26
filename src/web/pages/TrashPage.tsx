import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2
} from "lucide-react";
import type { TrashResponse } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { formatBytes, formatDateTime } from "../utils/format";

export function TrashPage() {
  const [data, setData] = useState<TrashResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [runningGc, setRunningGc] = useState(false);
  const [forceImmediateGc, setForceImmediateGc] = useState(false);
  const [tab, setTab] = useState<"assets" | "products">("assets");
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());

  const loadTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTrash();
      setData(res);
      setSelectedAssetIds(new Set());
      setSelectedProductIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载回收站失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  const handleRestore = async (type: "asset" | "product", ids: string[]) => {
    if (ids.length === 0) return;
    setRestoring(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.restoreTrash(type, ids);
      setNotice(
        `已恢复 ${res.restoredCount} 项${type === "asset" ? "素材" : "商品"}，并保留原有商品/标签关联关系与搜索索引`
      );
      await loadTrash();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  };

  const handleRunGc = async () => {
    setRunningGc(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.runTrashGc(forceImmediateGc);
      setNotice(
        `已入队受引用保护的垃圾回收任务 ${res.job.id.slice(0, 8)}（${
          forceImmediateGc ? "已选择忽略保留天数立即扫描" : "按通用设置保留天数扫描过期记录"
        }）。被历史版本或发布快照引用的文件将自动跳过保护。`
      );
      setForceImmediateGc(false);
      setTimeout(() => void loadTrash(), 800);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "触发垃圾回收失败");
    } finally {
      setRunningGc(false);
    }
  };

  const assets = data?.assets ?? [];
  const products = data?.products ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">回收站</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            软删除的素材与商品均受引用保护，恢复后自动还原全部商品关联、标签与全文搜索索引
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadTrash()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>刷新</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs">
        <div className="flex items-start gap-2 text-gray-600">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium text-gray-900">引用保护垃圾回收（GC）</div>
            <div className="mt-0.5">
              自动清理超过保留期的回收站项目与零引用孤立物理文件；若远程存储离线导致删除失败，失败项会保留在清理队列中供后续重试。
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-gray-700">
            <input
              type="checkbox"
              checked={forceImmediateGc}
              onChange={(e) => setForceImmediateGc(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span>忽略保留天数立即清理</span>
          </label>
          <button
            type="button"
            onClick={() => void handleRunGc()}
            disabled={runningGc}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{runningGc ? "正在提交 GC..." : "执行安全 GC"}</span>
          </button>
          <Link to="/jobs" className="font-medium text-blue-600 hover:underline">
            任务日志 →
          </Link>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="flex items-center justify-between border-b border-gray-200">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("assets")}
            className={`border-b-2 px-4 py-2.5 text-xs font-medium ${
              tab === "assets"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            已删除素材 ({assets.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("products")}
            className={`border-b-2 px-4 py-2.5 text-xs font-medium ${
              tab === "products"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            已删除商品 ({products.length})
          </button>
        </div>

        {tab === "assets" && selectedAssetIds.size > 0 && (
          <button
            type="button"
            disabled={restoring}
            onClick={() => void handleRestore("asset", Array.from(selectedAssetIds))}
            className="mb-1 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>批量恢复 ({selectedAssetIds.size})</span>
          </button>
        )}
        {tab === "products" && selectedProductIds.size > 0 && (
          <button
            type="button"
            disabled={restoring}
            onClick={() => void handleRestore("product", Array.from(selectedProductIds))}
            className="mb-1 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>批量恢复 ({selectedProductIds.size})</span>
          </button>
        )}
      </div>

      {loading && !data ? (
        <div className="rounded-xl border border-gray-200 bg-white py-14 text-center text-xs text-gray-400">
          正在加载回收站...
        </div>
      ) : tab === "assets" ? (
        assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-14 text-center">
            <Trash2 className="h-8 w-8 text-gray-300" />
            <p className="mt-2 text-xs text-gray-500">回收站中暂无已删除素材</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-medium text-gray-500">
                  <th className="w-10 px-3.5 py-2.5">
                    <input
                      type="checkbox"
                      checked={selectedAssetIds.size === assets.length && assets.length > 0}
                      onChange={(e) =>
                        setSelectedAssetIds(
                          e.target.checked ? new Set(assets.map((a) => a.id)) : new Set()
                        )
                      }
                    />
                  </th>
                  <th className="px-3.5 py-2.5">素材名称</th>
                  <th className="px-3.5 py-2.5">体积</th>
                  <th className="px-3.5 py-2.5">保留关联</th>
                  <th className="px-3.5 py-2.5">删除时间</th>
                  <th className="px-3.5 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {assets.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-3.5 py-2.5">
                      <input
                        type="checkbox"
                        checked={selectedAssetIds.has(item.id)}
                        onChange={() =>
                          setSelectedAssetIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-3.5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-100 text-gray-400">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-gray-900">{item.name}</div>
                          <div className="font-mono-tabular truncate text-[10px] text-gray-400">
                            {item.originalFilename}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="font-mono-tabular px-3.5 py-2.5 text-gray-600">
                      {formatBytes(item.sizeBytes)}
                    </td>
                    <td className="font-mono-tabular px-3.5 py-2.5 text-gray-500">
                      商品 {item.productCount} · 标签 {item.tagCount}
                    </td>
                    <td className="font-mono-tabular px-3.5 py-2.5 text-gray-400">
                      {formatDateTime(item.deletedAt)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right">
                      <button
                        type="button"
                        disabled={restoring}
                        onClick={() => void handleRestore("asset", [item.id])}
                        className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>恢复</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-14 text-center">
          <Package className="h-8 w-8 text-gray-300" />
          <p className="mt-2 text-xs text-gray-500">回收站中暂无已删除商品</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-medium text-gray-500">
                <th className="w-10 px-3.5 py-2.5">
                  <input
                    type="checkbox"
                    checked={selectedProductIds.size === products.length && products.length > 0}
                    onChange={(e) =>
                      setSelectedProductIds(
                        e.target.checked ? new Set(products.map((p) => p.id)) : new Set()
                      )
                    }
                  />
                </th>
                <th className="px-3.5 py-2.5">SPU / 商品名称</th>
                <th className="px-3.5 py-2.5">保留数据</th>
                <th className="px-3.5 py-2.5">删除时间</th>
                <th className="px-3.5 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((prod) => (
                <tr key={prod.id} className="hover:bg-gray-50">
                  <td className="px-3.5 py-2.5">
                    <input
                      type="checkbox"
                      checked={selectedProductIds.has(prod.id)}
                      onChange={() =>
                        setSelectedProductIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(prod.id)) next.delete(prod.id);
                          else next.add(prod.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="px-3.5 py-2.5">
                    <div className="font-medium text-gray-900">{prod.nameZh}</div>
                    <div className="font-mono-tabular text-[11px] text-gray-400">
                      {prod.spu}
                      {prod.nameEn ? ` · ${prod.nameEn}` : ""}
                    </div>
                  </td>
                  <td className="font-mono-tabular px-3.5 py-2.5 text-gray-500">
                    SKU {prod.skuCount} · 素材 {prod.assetCount}
                  </td>
                  <td className="font-mono-tabular px-3.5 py-2.5 text-gray-400">
                    {formatDateTime(prod.deletedAt)}
                  </td>
                  <td className="px-3.5 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={restoring}
                      onClick={() => void handleRestore("product", [prod.id])}
                      className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>恢复</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
