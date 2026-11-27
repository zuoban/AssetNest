import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  Grid,
  List,
  Package,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { ProductStatus, ProductSummary } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { ProductCostFields } from "../components/ProductCostFields";
import { parseProductCostDraft, toProductCostDraft } from "../utils/productCosts";
import { formatDateTime, PRODUCT_STATUS_META } from "../utils/format";

interface DraftSpecRow {
  specKey: string;
  specValue: string;
  unit: string;
}

export function ProductsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<ProductSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [statusFilter, setStatusFilter] = useState<ProductStatus | "">("");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [spu, setSpu] = useState("");
  const [nameZh, setNameZh] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [category, setCategory] = useState("");
  const [brandModel, setBrandModel] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierUrl, setSupplierUrl] = useState("");
  const [status, setStatus] = useState<ProductStatus>("active");
  const [notes, setNotes] = useState("");
  const [costDraft, setCostDraft] = useState(() => toProductCostDraft());
  const [specs, setSpecs] = useState<DraftSpecRow[]>([{ specKey: "", specValue: "", unit: "" }]);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProducts({
        q: query.trim() || undefined,
        status: statusFilter || undefined,
        page: 1,
        pageSize: 100
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载商品列表失败");
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadProducts();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [loadProducts]);

  const resetForm = useCallback(() => {
    setSpu("");
    setNameZh("");
    setNameEn("");
    setCategory("");
    setBrandModel("");
    setSupplierName("");
    setSupplierUrl("");
    setStatus("active");
    setNotes("");
    setCostDraft(toProductCostDraft());
    setSpecs([{ specKey: "", specValue: "", unit: "" }]);
    setFormError(null);
  }, []);

  useEffect(() => {
    if (searchParams.has("q")) {
      setQuery(searchParams.get("q") ?? "");
    }
    if (searchParams.get("action") === "new") {
      resetForm();
      setModalOpen(true);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("action");
      setSearchParams(nextParams, { replace: true });
    }
  }, [searchParams, setSearchParams, resetForm]);

  useEffect(() => {
    if (!modalOpen || creating) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen, creating]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!spu.trim() || !nameZh.trim()) {
      setFormError("请填写 SPU 编码与商品中文名");
      return;
    }
    const { values: costs, errors: costErrors } = parseProductCostDraft(costDraft);
    const [costError] = Object.values(costErrors);
    if (costError) {
      setFormError(costError);
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const cleanSpecs = specs
        .map((row, idx) => ({
          specKey: row.specKey.trim(),
          specValue: row.specValue.trim(),
          unit: row.unit.trim(),
          position: idx
        }))
        .filter((row) => row.specKey && row.specValue);

      const created = await api.createProduct({
        ...costs,
        spu: spu.trim(),
        nameZh: nameZh.trim(),
        nameEn: nameEn.trim(),
        category: category.trim(),
        brandModel: brandModel.trim(),
        supplierName: supplierName.trim(),
        supplierUrl: supplierUrl.trim(),
        status,
        notes: notes.trim(),
        specs: cleanSpecs
      });
      setModalOpen(false);
      resetForm();
      navigate(`/products/${created.id}`);
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "创建商品失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">商品中心</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            管理商品主数据（SPU）、公共规格参数、SKU 变体与关联素材（共{" "}
            <span className="font-mono-tabular font-medium text-gray-700">{total}</span> 款）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadProducts()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </button>
          <button
            type="button"
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>新建商品</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 SPU、中英文商品名、分类、供应商..."
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pr-3 pl-8 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:bg-white focus:outline-none"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ProductStatus | "")}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部状态</option>
          <option value="active">在用</option>
          <option value="draft">草稿</option>
          <option value="archived">已归档</option>
        </select>

        <div className="flex items-center rounded-lg border border-gray-200 p-0.5">
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={`rounded-md p-1.5 transition-colors ${
              viewMode === "grid"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
            title="网格视图"
          >
            <Grid className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("table")}
            className={`rounded-md p-1.5 transition-colors ${
              viewMode === "table"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
            title="列表视图"
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-16 text-center text-xs text-gray-400">
          正在加载商品数据...
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center">
          <Package className="h-9 w-9 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-700">
            {query || statusFilter ? "没有匹配的商品" : "尚未创建任何商品"}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            先录入一款商品 SPU，再关联实拍图、详情素材与多渠道 SKU
          </p>
          <button
            type="button"
            onClick={() => {
              resetForm();
              setModalOpen(true);
            }}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>新建首个商品</span>
          </button>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((product) => {
            const statusMeta = PRODUCT_STATUS_META[product.status];
            return (
              <Link
                key={product.id}
                to={`/products/${product.id}`}
                className="group flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white transition-all hover:border-blue-300 hover:shadow-sm"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-gray-100">
                  {product.coverAssetId && product.coverVersionId ? (
                    <img
                      src={api.thumbnailUrl(product.coverAssetId, product.coverVersionId)}
                      alt={product.nameZh}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center text-gray-300">
                      <Package className="h-8 w-8" />
                      <span className="mt-1 text-[11px] text-gray-400">暂无封面图</span>
                    </div>
                  )}
                  <span
                    className={`absolute top-2 right-2 rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.className}`}
                  >
                    {statusMeta.label}
                  </span>
                </div>

                <div className="flex flex-1 flex-col p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-tabular truncate rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">
                      {product.spu}
                    </span>
                    {product.category && (
                      <span className="truncate text-[11px] text-gray-400">{product.category}</span>
                    )}
                  </div>
                  <h2 className="mt-2 line-clamp-1 text-sm font-semibold text-gray-900 group-hover:text-blue-600">
                    {product.nameZh}
                  </h2>
                  {product.nameEn && (
                    <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{product.nameEn}</p>
                  )}
                  <div className="mt-auto flex items-center justify-between border-t border-gray-100 pt-2.5 text-[11px] text-gray-500">
                    <span className="font-mono-tabular">
                      SKU {product.skuCount} · 素材 {product.assetCount}
                    </span>
                    <span className="font-mono-tabular text-gray-400">
                      {formatDateTime(product.updatedAt).slice(0, 10)}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-medium text-gray-500">
                <th className="px-3.5 py-2.5">商品</th>
                <th className="px-3.5 py-2.5">SPU</th>
                <th className="px-3.5 py-2.5">分类</th>
                <th className="px-3.5 py-2.5">供应商</th>
                <th className="px-3.5 py-2.5 text-right">SKU</th>
                <th className="px-3.5 py-2.5 text-right">素材</th>
                <th className="px-3.5 py-2.5">状态</th>
                <th className="px-3.5 py-2.5">更新时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((product) => {
                const statusMeta = PRODUCT_STATUS_META[product.status];
                return (
                  <tr
                    key={product.id}
                    onClick={() => navigate(`/products/${product.id}`)}
                    className="cursor-pointer transition-colors hover:bg-gray-50"
                  >
                    <td className="px-3.5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-gray-200 bg-gray-100">
                          {product.coverAssetId && product.coverVersionId ? (
                            <img
                              src={api.thumbnailUrl(product.coverAssetId, product.coverVersionId)}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-gray-300">
                              <Package className="h-4 w-4" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-gray-900">{product.nameZh}</div>
                          {product.nameEn && (
                            <div className="truncate text-[11px] text-gray-400">
                              {product.nameEn}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="font-mono-tabular px-3.5 py-2.5 font-medium text-gray-700">
                      {product.spu}
                    </td>
                    <td className="px-3.5 py-2.5 text-gray-600">{product.category || "—"}</td>
                    <td className="px-3.5 py-2.5 text-gray-600">{product.supplierName || "—"}</td>
                    <td className="font-mono-tabular px-3.5 py-2.5 text-right text-gray-700">
                      {product.skuCount}
                    </td>
                    <td className="font-mono-tabular px-3.5 py-2.5 text-right text-gray-700">
                      {product.assetCount}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span
                        className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.className}`}
                      >
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="font-mono-tabular px-3.5 py-2.5 text-gray-400">
                      {formatDateTime(product.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="新建商品"
            className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-gray-900">新建商品</h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
              {formError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">
                    SPU 编码 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={spu}
                    onChange={(e) => setSpu(e.target.value)}
                    placeholder="例如：SPU-MUG-001"
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">状态</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as ProductStatus)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="active">在用</option>
                    <option value="draft">草稿</option>
                    <option value="archived">已归档</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">
                    商品中文名 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={nameZh}
                    onChange={(e) => setNameZh(e.target.value)}
                    placeholder="例如：304不锈钢保温随行杯"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">商品英文名</label>
                  <input
                    type="text"
                    value={nameEn}
                    onChange={(e) => setNameEn(e.target.value)}
                    placeholder="e.g. Insulated Stainless Tumbler"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">类目 / 分类</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="例如：水具 / 家居日用"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">品牌 / 型号</label>
                  <input
                    type="text"
                    value={brandModel}
                    onChange={(e) => setBrandModel(e.target.value)}
                    placeholder="例如：Model T-500"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">供应商名称</label>
                  <input
                    type="text"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                    placeholder="选填"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">供应商链接</label>
                  <input
                    type="url"
                    value={supplierUrl}
                    onChange={(e) => setSupplierUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="font-medium text-gray-700">公共规格参数</label>
                  <button
                    type="button"
                    onClick={() =>
                      setSpecs((prev) => [...prev, { specKey: "", specValue: "", unit: "" }])
                    }
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                  >
                    <Plus className="h-3 w-3" />
                    添加规格
                  </button>
                </div>
                <div className="space-y-2">
                  {specs.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_1fr_80px_32px] gap-2">
                      <input
                        type="text"
                        value={row.specKey}
                        onChange={(e) =>
                          setSpecs((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, specKey: e.target.value } : item
                            )
                          )
                        }
                        placeholder="参数名（如 材质）"
                        className="rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={row.specValue}
                        onChange={(e) =>
                          setSpecs((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, specValue: e.target.value } : item
                            )
                          )
                        }
                        placeholder="参数值（如 304不锈钢）"
                        className="rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={row.unit}
                        onChange={(e) =>
                          setSpecs((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, unit: e.target.value } : item
                            )
                          )
                        }
                        placeholder="单位"
                        className="rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSpecs((prev) =>
                            prev.length > 1 ? prev.filter((_, i) => i !== idx) : [{ specKey: "", specValue: "", unit: "" }]
                          )
                        }
                        className="flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:border-rose-200 hover:text-rose-600"
                        title="删除行"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-gray-700">商品备注</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="选填内部说明、卖点或采购备注"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <details
                className="rounded-lg border border-gray-200 px-3 py-2.5"
                onInvalid={(event) => { event.currentTarget.open = true; }}
              >
                <summary className="cursor-pointer font-medium text-gray-700">采购成本与箱规（选填）</summary>
                <div className="mt-3">
                  <ProductCostFields draft={costDraft} onChange={setCostDraft} />
                </div>
              </details>

              <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-gray-200 bg-white px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {creating ? "创建中..." : "创建并进入详情"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
