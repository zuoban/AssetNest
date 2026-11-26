import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  HardDrive,
  Play,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
  Wifi
} from "lucide-react";
import type {
  MigrationPreviewResponse,
  ProductSummary,
  StorageCleanupItem,
  StorageCleanupQueueResponse,
  StorageProviderSummary
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { StorageStatusBadge } from "../components/StatusBadge";
import { formatBytes, formatDateTime } from "../utils/format";

const CLEANUP_STATUS_META: Record<
  StorageCleanupItem["status"],
  { label: string; className: string }
> = {
  awaiting_confirmation: {
    label: "待二次确认",
    className: "bg-amber-50 text-amber-700 border-amber-200"
  },
  queued: {
    label: "排队清理中",
    className: "bg-blue-50 text-blue-700 border-blue-200"
  },
  deleted: {
    label: "已安全释放",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200"
  },
  failed: {
    label: "删除失败（可重试）",
    className: "bg-rose-50 text-rose-700 border-rose-200"
  }
};

export function StoragePage() {
  const [providers, setProviders] = useState<StorageProviderSummary[]>([]);
  const [cleanupQueue, setCleanupQueue] = useState<StorageCleanupQueueResponse | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [sourceStorageId, setSourceStorageId] = useState<string>("");
  const [targetStorageId, setTargetStorageId] = useState<string>("");
  const [scopeMode, setScopeMode] = useState<"all" | "product">("all");
  const [scopeProductId, setScopeProductId] = useState<string>("");
  const [preview, setPreview] = useState<MigrationPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [startingMigration, setStartingMigration] = useState(false);

  const [cleanupFilter, setCleanupFilter] = useState<string>("");
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<Set<string>>(new Set());
  const [cleanupConfirmedCheck, setCleanupConfirmedCheck] = useState(false);
  const [runningCleanup, setRunningCleanup] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [provRes, cleanupRes, prodRes] = await Promise.all([
        api.getStorageProviders(),
        api.getStorageCleanupQueue(
          (cleanupFilter || undefined) as StorageCleanupItem["status"] | undefined
        ),
        api.listProducts({ page: 1, pageSize: 100 })
      ]);
      setProviders(provRes.items);
      setCleanupQueue(cleanupRes);
      setProducts(prodRes.items);
      setSelectedCleanupIds(new Set());
      setSourceStorageId((prev) => prev || provRes.items[0]?.id || "");
      setTargetStorageId((prev) => {
        if (prev) return prev;
        const second = provRes.items.find((p) => p.enabled && p.id !== provRes.items[0]?.id);
        return second?.id || "";
      });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载存储列表失败");
    } finally {
      setLoading(false);
    }
  }, [cleanupFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTest = async (providerId: string) => {
    setTestingId(providerId);
    setError(null);
    setNotice(null);
    try {
      const res = await api.testStorageProvider(providerId);
      if (res.result.ok) {
        setNotice(
          `存储 "${providerId}" 探针验证通过（耗时 ${res.result.latencyMs} ms）：${res.result.message}`
        );
      } else {
        setError(
          `存储 "${providerId}" 连通性检查未通过 [${res.result.code}]：${res.result.message}`
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "存储连通性测试失败");
    } finally {
      setTestingId(null);
    }
  };

  const handleSwitchDefault = async (storageId: string) => {
    setSwitchingId(storageId);
    setError(null);
    setNotice(null);
    try {
      await api.switchDefaultStorage(storageId);
      setNotice(
        `默认存储已切换为 "${storageId}"。后续新上传素材将写入该存储，已有文件位置不受影响。`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "切换默认存储失败");
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    setDeletingId(providerId);
    setError(null);
    setNotice(null);
    try {
      await api.deleteStorageProvider(providerId);
      setNotice(`已移除无引用的存储记录 "${providerId}"`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "删除存储记录失败");
    } finally {
      setDeletingId(null);
    }
  };

  const handlePreviewMigration = async () => {
    if (!sourceStorageId || !targetStorageId) {
      setError("请选择来源存储与目标存储");
      return;
    }
    setPreviewing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.previewStorageMigration({
        sourceStorageId,
        targetStorageId,
        scope:
          scopeMode === "product"
            ? { mode: "product", productId: scopeProductId || undefined }
            : { mode: "all" }
      });
      setPreview(res);
    } catch (err) {
      setPreview(null);
      setError(err instanceof ApiClientError ? err.message : "预览跨存储迁移失败");
    } finally {
      setPreviewing(false);
    }
  };

  const handleStartMigration = async () => {
    if (!sourceStorageId || !targetStorageId) return;
    setStartingMigration(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.startStorageMigration({
        sourceStorageId,
        targetStorageId,
        scope:
          scopeMode === "product"
            ? { mode: "product", productId: scopeProductId || undefined }
            : { mode: "all" }
      });
      setNotice(
        `已创建跨存储迁移任务 ${res.job.id.slice(0, 8)}（共 ${res.preview.fileCount} 个物理文件）。来源对象在迁移完成后将保留在清理队列中等待二次确认。`
      );
      setPreview(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "启动迁移任务失败");
    } finally {
      setStartingMigration(false);
    }
  };

  const handleConfirmCleanup = async (allAwaiting: boolean) => {
    if (!cleanupConfirmedCheck) {
      setError("请先勾选确认框，明确知晓将物理删除旧存储上的来源对象");
      return;
    }
    setRunningCleanup(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.confirmStorageCleanup(
        allAwaiting ? { allAwaiting: true } : { ids: Array.from(selectedCleanupIds) }
      );
      setNotice(
        `已入队来源对象清理任务 ${res.job.id.slice(0, 8)}（共 ${res.queuedCount} 项），可在任务中心查看进度。`
      );
      setCleanupConfirmedCheck(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "提交清理任务失败");
    } finally {
      setRunningCleanup(false);
    }
  };

  const hasOfflineOrMissing = providers.some(
    (p) => p.status === "missing_config" || p.status === "offline"
  );
  const enabledProviders = providers.filter((p) => p.enabled);
  const cleanupItems = cleanupQueue?.items ?? [];
  const cleanupSummary = cleanupQueue?.summary;

  return (
    <div className="space-y-6">
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

      {hasOfflineOrMissing && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium">检测到离线或缺少配置的存储空间</div>
            <div className="mt-0.5 text-amber-700">
              本地元数据、商品关联与历史记录仍可正常浏览检索；受影响存储上的原文件读写会返回明确离线提示，恢复配置或网络后点击「测试连接」即可恢复。
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </div>
          <Link to="/jobs" className="shrink-0 font-medium text-emerald-700 underline">
            查看任务中心 →
          </Link>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
              <th className="px-4 py-3">存储名称 / ID</th>
              <th className="px-4 py-3">协议与能力</th>
              <th className="px-4 py-3">已存物理文件</th>
              <th className="px-4 py-3">健康状态</th>
              <th className="px-4 py-3">最近检测</th>
              <th className="px-4 py-3 text-right">操作</th>
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
                        默认写入
                      </span>
                    )}
                    {!provider.enabled && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                        已禁用
                      </span>
                    )}
                  </div>
                  <div className="font-mono-tabular mt-0.5 text-xs text-gray-500">{provider.id}</div>
                </td>
                <td className="px-4 py-3 text-xs">
                  <div className="font-mono-tabular font-medium text-gray-800">
                    {provider.type.toUpperCase()}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        provider.capabilities.rangeRead
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-gray-200 bg-gray-50 text-gray-500"
                      }`}
                    >
                      {provider.capabilities.rangeRead ? "Range 分段" : "流式直传"}
                    </span>
                    {provider.capabilities.multipartUpload && (
                      <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
                        分片上传
                      </span>
                    )}
                  </div>
                </td>
                <td className="font-mono-tabular px-4 py-3 text-xs text-gray-700">
                  <div>{provider.fileCount} 个对象</div>
                  <div className="text-gray-500">{formatBytes(provider.totalBytes)}</div>
                </td>
                <td className="px-4 py-3">
                  <StorageStatusBadge status={provider.status} />
                  {provider.lastError && (
                    <div className="mt-1 max-w-xs text-xs text-rose-600">{provider.lastError}</div>
                  )}
                </td>
                <td className="font-mono-tabular px-4 py-3 text-xs text-gray-500">
                  {provider.lastTestedAt ? formatDateTime(provider.lastTestedAt) : "尚未执行检测"}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleTest(provider.id)}
                      disabled={testingId === provider.id}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <Wifi className="h-3.5 w-3.5" />
                      <span>{testingId === provider.id ? "探测中..." : "测试连接"}</span>
                    </button>
                    {!provider.isDefault && provider.enabled && (
                      <button
                        type="button"
                        onClick={() => void handleSwitchDefault(provider.id)}
                        disabled={switchingId === provider.id}
                        className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                      >
                        <Star className="h-3.5 w-3.5" />
                        <span>{switchingId === provider.id ? "切换中..." : "设为默认"}</span>
                      </button>
                    )}
                    {!provider.isDefault && provider.status === "missing_config" && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteProvider(provider.id)}
                        disabled={deletingId === provider.id || provider.fileCount > 0}
                        title={
                          provider.fileCount > 0
                            ? "仍有物理文件引用，禁止删除"
                            : "移除无引用的缺失配置记录"
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>移除</span>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <ArrowRightLeft className="h-4 w-4 text-blue-600" />
              <span>跨存储安全迁移</span>
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              逐文件流式校验 SHA-256 与字节数，短事务切换或去重合并；迁移期间中断或重启可断点续传，来源物理对象默认保留待人工二次确认。
            </p>
          </div>
        </div>

        {enabledProviders.length < 2 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
            当前已启用的存储空间不足 2 个。请在 <code className="font-mono-tabular">config.yaml</code>{" "}
            中配置并启用第二个存储（如 S3 / WebDAV / 另一 Local 目录）后使用跨存储迁移。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">来源存储</label>
                <select
                  value={sourceStorageId}
                  onChange={(e) => {
                    setSourceStorageId(e.target.value);
                    setPreview(null);
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id}) · {p.fileCount} 个文件
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">目标存储</label>
                <select
                  value={targetStorageId}
                  onChange={(e) => {
                    setTargetStorageId(e.target.value);
                    setPreview(null);
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">请选择目标存储</option>
                  {enabledProviders
                    .filter((p) => p.id !== sourceStorageId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">迁移范围</label>
                <select
                  value={scopeMode}
                  onChange={(e) => {
                    setScopeMode(e.target.value as "all" | "product");
                    setPreview(null);
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                >
                  <option value="all">来源存储全部文件</option>
                  <option value="product">按指定商品筛选</option>
                </select>
              </div>

              {scopeMode === "product" ? (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">目标商品</label>
                  <select
                    value={scopeProductId}
                    onChange={(e) => {
                      setScopeProductId(e.target.value);
                      setPreview(null);
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">请选择商品</option>
                    {products.map((prod) => (
                      <option key={prod.id} value={prod.id}>
                        {prod.spu} · {prod.nameZh}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => void handlePreviewMigration()}
                    disabled={previewing || !sourceStorageId || !targetStorageId}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 text-blue-600" />
                    <span>{previewing ? "正在评估影响..." : "Dry-run 预览影响"}</span>
                  </button>
                </div>
              )}
            </div>

            {scopeMode === "product" && (
              <div>
                <button
                  type="button"
                  onClick={() => void handlePreviewMigration()}
                  disabled={previewing || !sourceStorageId || !targetStorageId || !scopeProductId}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                >
                  <ShieldCheck className="h-3.5 w-3.5 text-blue-600" />
                  <span>{previewing ? "正在评估影响..." : "Dry-run 预览影响"}</span>
                </button>
              </div>
            )}

            {preview && (
              <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 text-xs">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                    <div className="text-gray-500">待迁移物理文件</div>
                    <div className="font-mono-tabular mt-0.5 text-base font-semibold text-gray-900">
                      {preview.fileCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                    <div className="text-gray-500">总数据量</div>
                    <div className="font-mono-tabular mt-0.5 text-base font-semibold text-gray-900">
                      {formatBytes(preview.totalBytes)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                    <div className="text-gray-500">目标已存在（将合并）</div>
                    <div className="font-mono-tabular mt-0.5 text-base font-semibold text-blue-700">
                      {preview.alreadyOnTargetCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                    <div className="text-gray-500">受影响素材 / 商品</div>
                    <div className="font-mono-tabular mt-0.5 text-base font-semibold text-gray-900">
                      {preview.affectedAssetCount} / {preview.affectedProductCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                    <div className="text-gray-500">跨素材共享文件</div>
                    <div className="font-mono-tabular mt-0.5 text-base font-semibold text-amber-700">
                      {preview.sharedFileCount}
                    </div>
                  </div>
                </div>

                {preview.sharedFileCount > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                    注意：有{" "}
                    <span className="font-mono-tabular font-semibold">
                      {preview.sharedFileCount}
                    </span>{" "}
                    个物理文件被多个素材或商品共享引用，迁移后会同步更新这些共享引用指向目标存储。
                  </div>
                )}

                {preview.affectedProducts.length > 0 && (
                  <div>
                    <div className="mb-1 font-medium text-gray-700">受影响商品：</div>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.affectedProducts.map((p) => (
                        <span
                          key={p.id}
                          className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700"
                        >
                          <span className="font-mono-tabular font-medium">{p.spu}</span> ·{" "}
                          {p.nameZh}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <span className="text-gray-600">
                    {preview.fileCount === 0
                      ? "当前范围内无待迁移文件"
                      : "发起前系统将自动执行目标存储四步探针校验"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleStartMigration()}
                    disabled={startingMigration || preview.fileCount === 0}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>{startingMigration ? "正在提交任务..." : "确认启动迁移任务"}</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">来源对象与孤立文件清理队列</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              迁移完成的旧存储物理对象默认保留在此，核对无误后需人工二次确认才执行物理删除；远程删除失败项会保留重试状态。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={cleanupFilter}
              onChange={(e) => setCleanupFilter(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
            >
              <option value="">全部状态</option>
              <option value="awaiting_confirmation">待二次确认</option>
              <option value="queued">排队中</option>
              <option value="failed">删除失败</option>
              <option value="deleted">已释放</option>
            </select>
          </div>
        </div>

        {cleanupSummary && (
          <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-gray-500">待确认</div>
              <div className="font-mono-tabular mt-0.5 text-sm font-semibold text-amber-700">
                {cleanupSummary.awaitingCount}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-gray-500">排队清理</div>
              <div className="font-mono-tabular mt-0.5 text-sm font-semibold text-blue-700">
                {cleanupSummary.queuedCount}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-gray-500">失败待重试</div>
              <div className="font-mono-tabular mt-0.5 text-sm font-semibold text-rose-700">
                {cleanupSummary.failedCount}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-gray-500">已安全释放</div>
              <div className="font-mono-tabular mt-0.5 text-sm font-semibold text-emerald-700">
                {cleanupSummary.deletedCount}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-gray-500">预计可释放空间</div>
              <div className="font-mono-tabular mt-0.5 text-sm font-semibold text-gray-900">
                {formatBytes(cleanupSummary.reclaimableBytes)}
              </div>
            </div>
          </div>
        )}

        {(cleanupSummary?.awaitingCount ?? 0) + (cleanupSummary?.failedCount ?? 0) > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs">
            <label className="inline-flex cursor-pointer items-center gap-2 text-amber-900">
              <input
                type="checkbox"
                checked={cleanupConfirmedCheck}
                onChange={(e) => setCleanupConfirmedCheck(e.target.checked)}
                className="rounded border-amber-400 text-blue-600 focus:ring-blue-500"
              />
              <span>
                我已确认目标存储文件访问正常，允许物理删除所选来源对象（删除前仍会自动执行零引用保护校验）
              </span>
            </label>
            <div className="flex items-center gap-2">
              {selectedCleanupIds.size > 0 && (
                <button
                  type="button"
                  disabled={runningCleanup || !cleanupConfirmedCheck}
                  onClick={() => void handleConfirmCleanup(false)}
                  className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-40"
                >
                  清理选中项（{selectedCleanupIds.size}）
                </button>
              )}
              <button
                type="button"
                disabled={runningCleanup || !cleanupConfirmedCheck}
                onClick={() => void handleConfirmCleanup(true)}
                className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40"
              >
                确认清理全部待处理项
              </button>
            </div>
          </div>
        )}

        {cleanupItems.length === 0 ? (
          <div className="py-8 text-center text-xs text-gray-400">当前没有清理队列记录</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                  <th className="w-8 px-3 py-2.5"></th>
                  <th className="px-3 py-2.5">存储 / 对象键</th>
                  <th className="px-3 py-2.5">来源原因</th>
                  <th className="px-3 py-2.5">大小</th>
                  <th className="px-3 py-2.5">状态</th>
                  <th className="px-3 py-2.5">更新时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cleanupItems.map((item) => {
                  const selectable =
                    item.status === "awaiting_confirmation" || item.status === "failed";
                  const badge = CLEANUP_STATUS_META[item.status];
                  return (
                    <tr key={item.id} className="hover:bg-gray-50/70">
                      <td className="px-3 py-2.5">
                        {selectable && (
                          <input
                            type="checkbox"
                            checked={selectedCleanupIds.has(item.id)}
                            onChange={(e) => {
                              setSelectedCleanupIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              });
                            }}
                            className="rounded border-gray-300"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-mono-tabular font-medium text-gray-800">
                          {item.storageId}
                        </div>
                        <div className="font-mono-tabular text-[11px] text-gray-500">
                          {item.objectKey}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {item.reason === "migration_source" ? "迁移来源保留" : "GC 孤立对象"}
                      </td>
                      <td className="font-mono-tabular px-3 py-2.5 text-gray-700">
                        {formatBytes(item.sizeBytes)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                        {item.lastError && (
                          <div className="mt-1 max-w-xs text-[11px] text-rose-600">
                            {item.lastError}
                          </div>
                        )}
                      </td>
                      <td className="font-mono-tabular px-3 py-2.5 text-gray-500">
                        {formatDateTime(item.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
