import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Copy,
  Images,
  Info,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";
import type {
  DictionariesResponse,
  ListingStatus,
  ListingSummary,
  ProductSummary,
  StoreRecord
} from "../../shared/types";
import { api } from "../api/client";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { formatDateTime, LISTING_STATUS_META } from "../utils/format";

export function ListingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [listings, setListings] = useState<ListingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 24;

  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [dictionaries, setDictionaries] = useState<DictionariesResponse | null>(null);

  // Filters
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [productIdFilter, setProductIdFilter] = useState(searchParams.get("productId") ?? "");
  const [storeIdFilter, setStoreIdFilter] = useState(searchParams.get("storeId") ?? "");
  const [platformFilter, setPlatformFilter] = useState(searchParams.get("platform") ?? "");
  const [marketFilter, setMarketFilter] = useState(searchParams.get("market") ?? "");
  const [statusFilter, setStatusFilter] = useState<"" | ListingStatus>(
    (searchParams.get("status") as "" | ListingStatus) ?? ""
  );

  // Create Listing Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newProductId, setNewProductId] = useState("");
  const [newStoreId, setNewStoreId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newLanguage, setNewLanguage] = useState("");
  const [newExternalId, setNewExternalId] = useState("");
  const [newExternalUrl, setNewExternalUrl] = useState("");
  const [newStatus, setNewStatus] = useState<ListingStatus>("draft");
  const [newNotes, setNewNotes] = useState("");
  const [creating, setCreating] = useState(false);

  // Duplicate Modal
  const [dupTarget, setDupTarget] = useState<ListingSummary | null>(null);
  const [dupStoreId, setDupStoreId] = useState("");
  const [dupDisplayName, setDupDisplayName] = useState("");
  const [dupLanguage, setDupLanguage] = useState("");
  const [duplicating, setDuplicating] = useState(false);

  const loadMeta = useCallback(async () => {
    try {
      const [storesRes, productsRes, dictsRes] = await Promise.all([
        api.listStores(),
        api.listProducts({ page: 1, pageSize: 100 }),
        api.getDictionaries()
      ]);
      setStores(storesRes.items);
      setProducts(productsRes.items);
      setDictionaries(dictsRes);
    } catch {
      // handled when loading listings
    }
  }, []);

  const loadListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listListings({
        q: q.trim() || undefined,
        productId: productIdFilter || undefined,
        storeId: storeIdFilter || undefined,
        platform: platformFilter || undefined,
        market: marketFilter || undefined,
        status: statusFilter || undefined,
        page,
        pageSize
      });
      setListings(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载上架链接失败");
    } finally {
      setLoading(false);
    }
  }, [q, productIdFilter, storeIdFilter, platformFilter, marketFilter, statusFilter, page]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    void loadListings();
  }, [loadListings]);

  const labelOf = (category: "platform" | "market" | "language", code: string): string => {
    const list =
      category === "platform"
        ? dictionaries?.platforms
        : category === "market"
          ? dictionaries?.markets
          : dictionaries?.languages;
    return list?.find((d) => d.code === code)?.label ?? code;
  };

  const openCreateModal = () => {
    const firstProduct = products[0];
    const firstActiveStore = stores.find((s) => s.status === "active") ?? stores[0];
    setNewProductId(productIdFilter || firstProduct?.id || "");
    setNewStoreId(storeIdFilter || firstActiveStore?.id || "");
    setNewDisplayName(
      firstProduct && firstActiveStore
        ? `${firstProduct.nameZh} · ${firstActiveStore.name}`
        : ""
    );
    setNewLanguage(firstActiveStore?.defaultLanguage ?? "en");
    setNewExternalId("");
    setNewExternalUrl("");
    setNewStatus("draft");
    setNewNotes("");
    setCreateOpen(true);
  };

  const handleStoreChangeInCreate = (storeId: string) => {
    setNewStoreId(storeId);
    const st = stores.find((s) => s.id === storeId);
    if (st) {
      setNewLanguage(st.defaultLanguage);
      const prod = products.find((p) => p.id === newProductId);
      if (prod && !newDisplayName.trim()) {
        setNewDisplayName(`${prod.nameZh} · ${st.name}`);
      }
    }
  };

  const handleCreateListing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProductId || !newStoreId || !newDisplayName.trim()) {
      setError("请选择商品、店铺并填写上架展示名称");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await api.createListing({
        productId: newProductId,
        storeId: newStoreId,
        displayName: newDisplayName.trim(),
        language: newLanguage || undefined,
        externalId: newExternalId.trim() || null,
        externalUrl: newExternalUrl.trim() || null,
        status: newStatus,
        notes: newNotes.trim()
      });
      setCreateOpen(false);
      navigate(`/listings/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建上架链接失败");
    } finally {
      setCreating(false);
    }
  };

  const openDuplicateModal = (item: ListingSummary) => {
    setDupTarget(item);
    setDupStoreId(item.storeId);
    setDupDisplayName(`${item.displayName} (副本)`);
    setDupLanguage(item.language);
  };

  const handleDuplicateListing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dupTarget) return;
    setDuplicating(true);
    setError(null);
    setNotice(null);
    try {
      const duplicated = await api.duplicateListing(dupTarget.id, {
        storeId: dupStoreId || undefined,
        displayName: dupDisplayName.trim() || undefined,
        language: dupLanguage || undefined
      });
      setDupTarget(null);
      setNotice(`已复制为独立草稿「${duplicated.displayName}」`);
      await loadListings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制上架链接失败");
    } finally {
      setDuplicating(false);
    }
  };

  const handleDeleteListing = (item: ListingSummary) => {
    setConfirmDialog({
      title: "移入回收站",
      description: `确认将上架链接「${item.displayName}」移入回收站吗？移入后可在回收站恢复。`,
      confirmLabel: "移入回收站",
      tone: "danger",
      onConfirm: async () => {
        setConfirmBusy(true);
        setError(null);
        setNotice(null);
        try {
          await api.deleteListing(item.id);
          setConfirmDialog(null);
          setNotice(`已将「${item.displayName}」移入回收站`);
          await loadListings();
        } catch (err) {
          setError(err instanceof Error ? err.message : "删除上架链接失败");
        } finally {
          setConfirmBusy(false);
        }
      }
    });
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">多渠道上架工作台</h1>
          <p className="mt-1 text-xs text-gray-500">
            管理同一商品在不同平台与店铺的独立上架链接、固定版本素材组（轮播图 / 详情图 / SKU 图 / 视频）及多语言 PDP 文案
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/stores"
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            管理店铺
          </Link>
          <button
            type="button"
            onClick={() => void loadListings()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            disabled={products.length === 0 || stores.length === 0}
            title={
              products.length === 0 || stores.length === 0
                ? "请先创建至少一个商品和一个店铺"
                : "新建上架链接"
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            新建上架链接
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-800">
        <Info className="h-4 w-4 shrink-0" />
        <span>
          外部平台发布状态（草稿 / 已准备 / 已上架 / 已归档）由运营人员手动维护，系统不自动直连或同步外部电商平台 API。
        </span>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-gray-200 bg-white p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
            placeholder="搜索链接名、SPU、商品名、店铺名或 PDP 标题..."
            className="w-full rounded-lg border border-gray-200 py-1.5 pr-3 pl-8 text-xs focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select
          value={productIdFilter}
          onChange={(e) => {
            setPage(1);
            setProductIdFilter(e.target.value);
          }}
          className="max-w-[180px] rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
        >
          <option value="">全部商品</option>
          {products.map((prod) => (
            <option key={prod.id} value={prod.id}>
              {prod.spu} · {prod.nameZh}
            </option>
          ))}
        </select>
        <select
          value={storeIdFilter}
          onChange={(e) => {
            setPage(1);
            setStoreIdFilter(e.target.value);
          }}
          className="max-w-[180px] rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
        >
          <option value="">全部店铺</option>
          {stores.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
        <select
          value={platformFilter}
          onChange={(e) => {
            setPage(1);
            setPlatformFilter(e.target.value);
          }}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
        >
          <option value="">全部平台</option>
          {dictionaries?.platforms.map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          value={marketFilter}
          onChange={(e) => {
            setPage(1);
            setMarketFilter(e.target.value);
          }}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
        >
          <option value="">全部市场</option>
          {dictionaries?.markets.map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setPage(1);
            setStatusFilter(e.target.value as "" | ListingStatus);
          }}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="ready">已准备</option>
          <option value="published">已上架（人工标记）</option>
          <option value="archived">已归档</option>
        </select>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-xs text-gray-500">
          正在加载上架链接...
        </div>
      ) : listings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <Layers className="mx-auto h-8 w-8 text-gray-400" />
          <p className="mt-2 text-sm font-medium text-gray-800">暂无匹配的上架链接</p>
          <p className="mt-1 text-xs text-gray-500">
            {stores.length === 0
              ? "请先前往「店铺与字典」创建店铺，再创建商品上架链接"
              : "点击「新建上架链接」为商品在不同平台与店铺编排素材组与多语言文案"}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {listings.map((item) => {
              const statusMeta = LISTING_STATUS_META[item.status];
              return (
                <div
                  key={item.id}
                  className="flex flex-col justify-between rounded-xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-sm"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                            {labelOf("platform", item.platform)}
                          </span>
                          <span className="rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">
                            {labelOf("market", item.market)}
                          </span>
                          <span className="rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono-tabular text-[11px] text-gray-600">
                            {item.language.toUpperCase()}
                          </span>
                        </div>
                        <Link
                          to={`/listings/${item.id}`}
                          className="mt-2 block truncate text-sm font-semibold text-gray-900 hover:text-blue-600"
                        >
                          {item.displayName}
                        </Link>
                      </div>
                      <span
                        className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${statusMeta.className}`}
                      >
                        {statusMeta.label}
                      </span>
                    </div>

                    <div className="mt-2.5 space-y-1 text-xs text-gray-600">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-500">所属商品</span>
                        <Link
                          to={`/products/${item.productId}`}
                          className="truncate font-medium text-gray-800 hover:text-blue-600"
                        >
                          <span className="font-mono-tabular text-gray-500">{item.productSpu}</span> ·{" "}
                          {item.productNameZh}
                        </Link>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-500">归属店铺</span>
                        <span className="truncate font-medium text-gray-800">{item.storeName}</span>
                      </div>
                      {item.pdpTitle && (
                        <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-700">
                          <div className="text-[10px] text-gray-400">PDP 标题草稿</div>
                          <div className="mt-0.5 line-clamp-2">{item.pdpTitle}</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-auto pt-3">
                    <div className="grid grid-cols-4 gap-1.5 rounded-lg border border-gray-100 bg-gray-50/80 p-2 text-center font-mono-tabular text-[11px]">
                      <div>
                        <div className="text-gray-400">轮播</div>
                        <div className="font-semibold text-gray-900">{item.carouselCount}</div>
                      </div>
                      <div>
                        <div className="text-gray-400">详情</div>
                        <div className="font-semibold text-gray-900">{item.detailCount}</div>
                      </div>
                      <div>
                        <div className="text-gray-400">SKU图</div>
                        <div className="font-semibold text-gray-900">
                          {item.skuImageCount}/{item.skuCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-400">PDP版本</div>
                        <div className="font-semibold text-gray-900">{item.pdpVersionCount}</div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
                    <span className="font-mono-tabular text-[11px] text-gray-400">
                      更新 {formatDateTime(item.updatedAt)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openDuplicateModal(item)}
                        title="复制为独立草稿"
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-100"
                      >
                        <Copy className="h-3 w-3" />
                        复制
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteListing(item)}
                        title="移入回收站"
                        aria-label="移入回收站"
                        className="rounded-md border border-rose-200 p-1 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <Link
                        to={`/listings/${item.id}`}
                        className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
                      >
                        <Images className="h-3 w-3" />
                        进入工作台
                      </Link>
                    </div>
                  </div>
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs text-gray-600">
              <span>
                共 {total} 条上架链接 · 第 {page} / {totalPages} 页
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-md border border-gray-200 px-2.5 py-1 hover:bg-gray-50 disabled:opacity-40"
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-md border border-gray-200 px-2.5 py-1 hover:bg-gray-50 disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">新建上架链接</h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateListing(e)} className="space-y-3.5 text-xs">
              <div>
                <label className="mb-1 block font-medium text-gray-700">关联商品 (SPU) *</label>
                <select
                  required
                  value={newProductId}
                  onChange={(e) => {
                    setNewProductId(e.target.value);
                    const prod = products.find((p) => p.id === e.target.value);
                    const st = stores.find((s) => s.id === newStoreId);
                    if (prod && st) {
                      setNewDisplayName(`${prod.nameZh} · ${st.name}`);
                    }
                  }}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  <option value="">请选择商品</option>
                  {products.map((prod) => (
                    <option key={prod.id} value={prod.id}>
                      {prod.spu} · {prod.nameZh}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">目标店铺 *</label>
                  <select
                    required
                    value={newStoreId}
                    onChange={(e) => handleStoreChangeInCreate(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                  >
                    <option value="">请选择店铺</option>
                    {stores.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.name} ({st.platform}/{st.market})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">文案语言</label>
                  <select
                    value={newLanguage}
                    onChange={(e) => setNewLanguage(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                  >
                    {dictionaries?.languages.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">上架展示名称 *</label>
                <input
                  type="text"
                  required
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="例如：猫眼太阳镜 · PH Shopee 主链"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">人工状态</label>
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value as ListingStatus)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                  >
                    <option value="draft">草稿</option>
                    <option value="ready">已准备</option>
                    <option value="published">已上架（人工标记）</option>
                    <option value="archived">已归档</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">外部平台商品 ID（选填）</label>
                  <input
                    type="text"
                    value={newExternalId}
                    onChange={(e) => setNewExternalId(e.target.value)}
                    placeholder="例如：Shopee Item ID"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">外部平台链接（选填）</label>
                <input
                  type="text"
                  value={newExternalUrl}
                  onChange={(e) => setNewExternalUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">备注</label>
                <textarea
                  rows={2}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {creating ? "创建中..." : "创建并进入工作台"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dupTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">复制上架链接为独立草稿</h2>
              <button
                type="button"
                onClick={() => setDupTarget(null)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 rounded-lg bg-gray-50 p-2.5 text-[11px] text-gray-600">
              复制将保留当前所有固定素材版本（轮播图 / 详情图 / SKU 图 / 视频）、SKU 映射和 PDP 草稿，生成完全独立的新草稿，后续修改互不影响。
            </p>
            <form onSubmit={(e) => void handleDuplicateListing(e)} className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block font-medium text-gray-700">目标店铺</label>
                <select
                  value={dupStoreId}
                  onChange={(e) => {
                    setDupStoreId(e.target.value);
                    const st = stores.find((s) => s.id === e.target.value);
                    if (st) setDupLanguage(st.defaultLanguage);
                  }}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  {stores.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name} ({st.platform}/{st.market})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">新链接名称</label>
                <input
                  type="text"
                  required
                  value={dupDisplayName}
                  onChange={(e) => setDupDisplayName(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">目标文案语言</label>
                <select
                  value={dupLanguage}
                  onChange={(e) => setDupLanguage(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  {dictionaries?.languages.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDupTarget(null)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={duplicating}
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {duplicating ? "复制中..." : "确认复制"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        dialog={confirmDialog}
        busy={confirmBusy}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}
