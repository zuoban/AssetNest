import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Image as ImageIcon,
  Maximize2,
  Plus,
  Save,
  Star,
  Trash2,
  Upload,
  X
} from "lucide-react";
import type {
  AppearanceConstraints,
  AssetListItem,
  ProductDetail,
  ProductStatus,
  SkuRecord,
  SkuStatus
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { AssetLightbox } from "../components/AssetLightbox";
import {
  formatBytes,
  formatDateTime,
  PRODUCT_STATUS_META,
  REVIEW_STATUS_META
} from "../utils/format";

interface SpecRow {
  specKey: string;
  specValue: string;
  unit: string;
}

interface AttrRow {
  key: string;
  value: string;
}

export function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "skus" | "assets">("overview");

  // Editable product state
  const [spu, setSpu] = useState("");
  const [nameZh, setNameZh] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [category, setCategory] = useState("");
  const [brandModel, setBrandModel] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierUrl, setSupplierUrl] = useState("");
  const [status, setStatus] = useState<ProductStatus>("active");
  const [notes, setNotes] = useState("");
  const [specs, setSpecs] = useState<SpecRow[]>([]);
  const [constraints, setConstraints] = useState<AppearanceConstraints>({});
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // SKU modal state
  const [skuModalOpen, setSkuModalOpen] = useState(false);
  const [editingSku, setEditingSku] = useState<SkuRecord | null>(null);
  const [skuCode, setSkuCode] = useState("");
  const [skuName, setSkuName] = useState("");
  const [skuStatus, setSkuStatus] = useState<SkuStatus>("active");
  const [skuAttrs, setSkuAttrs] = useState<AttrRow[]>([{ key: "颜色", value: "" }]);
  const [skuSaving, setSkuSaving] = useState(false);
  const [skuError, setSkuError] = useState<string | null>(null);

  // Asset upload & lightbox
  const [uploading, setUploading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const syncFormFromProduct = (detail: ProductDetail) => {
    setSpu(detail.spu);
    setNameZh(detail.nameZh);
    setNameEn(detail.nameEn);
    setCategory(detail.category);
    setBrandModel(detail.brandModel);
    setSupplierName(detail.supplierName);
    setSupplierUrl(detail.supplierUrl);
    setStatus(detail.status);
    setNotes(detail.notes);
    setSpecs(
      detail.specs.length > 0
        ? detail.specs.map((s) => ({ specKey: s.specKey, specValue: s.specValue, unit: s.unit }))
        : [{ specKey: "", specValue: "", unit: "" }]
    );
    setConstraints(detail.appearanceConstraints || {});
  };

  const loadAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, assetRes] = await Promise.all([
        api.getProduct(id),
        api.listAssets({ productId: id, page: 1, pageSize: 100 })
      ]);
      setProduct(detail);
      syncFormFromProduct(detail);
      setAssets(assetRes.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载商品详情失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSaveOverview = async (event: FormEvent) => {
    event.preventDefault();
    if (!id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const cleanSpecs = specs
        .map((row, idx) => ({
          specKey: row.specKey.trim(),
          specValue: row.specValue.trim(),
          unit: row.unit.trim(),
          position: idx
        }))
        .filter((row) => row.specKey && row.specValue);

      const updated = await api.updateProduct(id, {
        spu: spu.trim(),
        nameZh: nameZh.trim(),
        nameEn: nameEn.trim(),
        category: category.trim(),
        brandModel: brandModel.trim(),
        supplierName: supplierName.trim(),
        supplierUrl: supplierUrl.trim(),
        status,
        notes: notes.trim(),
        appearanceConstraints: constraints,
        specs: cleanSpecs
      });
      setProduct(updated);
      syncFormFromProduct(updated);
      setNotice("商品信息与规格已保存");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSoftDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteProduct(id);
      navigate("/products");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "删除商品失败");
      setDeleting(false);
    }
  };

  const openCreateSku = () => {
    setEditingSku(null);
    setSkuCode(product ? `${product.spu}-` : "");
    setSkuName("");
    setSkuStatus("active");
    setSkuAttrs([{ key: "颜色", value: "" }]);
    setSkuError(null);
    setSkuModalOpen(true);
  };

  const openEditSku = (sku: SkuRecord) => {
    setEditingSku(sku);
    setSkuCode(sku.code);
    setSkuName(sku.name);
    setSkuStatus(sku.status);
    const entries = Object.entries(sku.attributes || {});
    setSkuAttrs(
      entries.length > 0
        ? entries.map(([key, value]) => ({ key, value }))
        : [{ key: "颜色", value: "" }]
    );
    setSkuError(null);
    setSkuModalOpen(true);
  };

  const handleSaveSku = async (event: FormEvent) => {
    event.preventDefault();
    if (!id) return;
    const attributes: Record<string, string> = {};
    for (const row of skuAttrs) {
      const k = row.key.trim();
      const v = row.value.trim();
      if (k && v) {
        attributes[k] = v;
      }
    }
    if (!skuCode.trim() || !skuName.trim()) {
      setSkuError("请填写 SKU 编码和名称");
      return;
    }
    if (Object.keys(attributes).length === 0) {
      setSkuError("请至少填写一项有效的规格属性（如 颜色 / 容量）");
      return;
    }
    setSkuSaving(true);
    setSkuError(null);
    try {
      if (editingSku) {
        await api.updateSku(id, editingSku.id, {
          code: skuCode.trim(),
          name: skuName.trim(),
          status: skuStatus,
          attributes
        });
      } else {
        await api.createSku(id, {
          code: skuCode.trim(),
          name: skuName.trim(),
          status: skuStatus,
          attributes
        });
      }
      setSkuModalOpen(false);
      setNotice(editingSku ? "SKU 已更新" : "SKU 已创建");
      await loadAll();
    } catch (err) {
      setSkuError(err instanceof ApiClientError ? err.message : "保存 SKU 失败");
    } finally {
      setSkuSaving(false);
    }
  };

  const handleDeleteSku = async (sku: SkuRecord) => {
    if (!id) return;
    if (!window.confirm(`确定删除 SKU「${sku.code}（${sku.name}）」吗？`)) return;
    setError(null);
    try {
      await api.deleteSku(id, sku.id);
      setNotice(`已删除 SKU ${sku.code}`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "删除 SKU 失败");
    }
  };

  const handleUploadLinkedAssets = async (files: FileList | null) => {
    if (!id || !files || files.length === 0) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.uploadAssets(Array.from(files), { productId: id });
      setNotice(
        `已上传 ${res.uploadedCount} 个素材${
          res.deduplicatedCount > 0 ? `（其中 ${res.deduplicatedCount} 个复用已有底层文件）` : ""
        }`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "上传素材失败");
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const handleSetCover = async (asset: AssetListItem) => {
    if (!id) return;
    setError(null);
    try {
      const updated = await api.updateProduct(id, { coverVersionId: asset.currentVersionId });
      setProduct(updated);
      setNotice(`已将「${asset.name}」设为商品封面图`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "设置封面失败");
    }
  };

  if (loading && !product) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white py-16 text-center text-xs text-gray-400">
        正在加载商品详情...
      </div>
    );
  }

  if (!product) {
    return (
      <div className="space-y-3 rounded-xl border border-rose-200 bg-white p-6 text-center">
        <p className="text-sm font-medium text-rose-700">{error || "未找到该商品"}</p>
        <Link
          to="/products"
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回商品中心
        </Link>
      </div>
    );
  }

  const statusMeta = PRODUCT_STATUS_META[product.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            to="/products"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>商品中心</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-900">{product.nameZh}</h1>
            <span className="font-mono-tabular rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              {product.spu}
            </span>
            <span
              className={`rounded border px-2 py-0.5 text-[11px] font-medium ${statusMeta.className}`}
            >
              {statusMeta.label}
            </span>
          </div>
          {product.nameEn && <p className="text-xs text-gray-500">{product.nameEn}</p>}
        </div>

        <div className="flex items-center gap-2">
          <Link
            to={`/assets?productId=${product.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>在素材库中查看</span>
          </Link>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>移入回收站</span>
          </button>
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

      <div className="flex items-center gap-1 border-b border-gray-200">
        {[
          { key: "overview" as const, label: "基础信息与规格" },
          { key: "skus" as const, label: `SKU 变体 (${product.skus.length})` },
          { key: "assets" as const, label: `关联素材 (${assets.length})` }
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
              tab === item.key
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <form onSubmit={handleSaveOverview} className="space-y-4 text-xs">
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-3.5 text-sm font-semibold text-gray-900">商品主数据</h2>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="mb-1 block font-medium text-gray-700">SPU 编码</label>
                <input
                  type="text"
                  required
                  value={spu}
                  onChange={(e) => setSpu(e.target.value)}
                  className="font-mono-tabular w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">商品中文名</label>
                <input
                  type="text"
                  required
                  value={nameZh}
                  onChange={(e) => setNameZh(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">商品英文名</label>
                <input
                  type="text"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">分类</label>
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">品牌 / 型号</label>
                <input
                  type="text"
                  value={brandModel}
                  onChange={(e) => setBrandModel(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
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
                <label className="mb-1 block font-medium text-gray-700">供应商名称</label>
                <input
                  type="text"
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block font-medium text-gray-700">供应商链接</label>
                <input
                  type="url"
                  value={supplierUrl}
                  onChange={(e) => setSupplierUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="mb-1 block font-medium text-gray-700">内部备注</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">公共规格参数</h2>
              <button
                type="button"
                onClick={() =>
                  setSpecs((prev) => [...prev, { specKey: "", specValue: "", unit: "" }])
                }
                className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
                添加一行
              </button>
            </div>
            <div className="space-y-2">
              {specs.map((row, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_1fr_100px_32px] gap-2">
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
                    placeholder="规格名（如 容量、材质、净重）"
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
                    placeholder="规格值"
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
                        prev.length > 1
                          ? prev.filter((_, i) => i !== idx)
                          : [{ specKey: "", specValue: "", unit: "" }]
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
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-1 text-sm font-semibold text-gray-900">外观一致性约束</h2>
            <p className="mb-3.5 text-[11px] text-gray-500">
              供设计与 AI 制图审核参考，明确不可变更的外观结构、比例与颜色要求
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-gray-700">关键结构</label>
                <input
                  type="text"
                  value={constraints.structure ?? ""}
                  onChange={(e) =>
                    setConstraints((prev) => ({ ...prev, structure: e.target.value }))
                  }
                  placeholder="如：提手位置、按键数量、锁扣样式"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">外观比例</label>
                <input
                  type="text"
                  value={constraints.proportion ?? ""}
                  onChange={(e) =>
                    setConstraints((prev) => ({ ...prev, proportion: e.target.value }))
                  }
                  placeholder="如：杯身高度与口径比例约 2.4:1"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">颜色与表面工艺</label>
                <input
                  type="text"
                  value={constraints.color ?? ""}
                  onChange={(e) => setConstraints((prev) => ({ ...prev, color: e.target.value }))}
                  placeholder="如：磨砂象牙白，不得渲染为亮面"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">基准尺寸</label>
                <input
                  type="text"
                  value={constraints.dimensions ?? ""}
                  onChange={(e) =>
                    setConstraints((prev) => ({ ...prev, dimensions: e.target.value }))
                  }
                  placeholder="如：高 185mm × 直径 76mm"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block font-medium text-gray-700">禁止变更项</label>
                <textarea
                  rows={2}
                  value={constraints.forbiddenChanges ?? ""}
                  onChange={(e) =>
                    setConstraints((prev) => ({ ...prev, forbiddenChanges: e.target.value }))
                  }
                  placeholder="如：不得去除正面 Logo 丝印，不得修改杯盖直饮口形态"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          </section>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              <span>{saving ? "保存中..." : "保存更改"}</span>
            </button>
          </div>
        </form>
      )}

      {tab === "skus" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">
              SKU 编码全局唯一；同一商品下不可存在完全相同的规格属性组合。
            </p>
            <button
              type="button"
              onClick={openCreateSku}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>新增 SKU</span>
            </button>
          </div>

          {product.skus.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-xs text-gray-400">
              暂无 SKU 变体，点击右上角「新增 SKU」添加颜色、尺寸或套装规格
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-medium text-gray-500">
                    <th className="px-4 py-2.5">SKU 编码</th>
                    <th className="px-4 py-2.5">变体名称</th>
                    <th className="px-4 py-2.5">规格属性</th>
                    <th className="px-4 py-2.5">状态</th>
                    <th className="px-4 py-2.5">更新时间</th>
                    <th className="px-4 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {product.skus.map((sku) => (
                    <tr key={sku.id} className="hover:bg-gray-50">
                      <td className="font-mono-tabular px-4 py-2.5 font-medium text-gray-900">
                        {sku.code}
                      </td>
                      <td className="px-4 py-2.5 text-gray-800">{sku.name}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(sku.attributes).map(([k, v]) => (
                            <span
                              key={k}
                              className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700"
                            >
                              {k}: {v}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                            sku.status === "active"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-gray-200 bg-gray-100 text-gray-600"
                          }`}
                        >
                          {sku.status === "active" ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="font-mono-tabular px-4 py-2.5 text-gray-400">
                        {formatDateTime(sku.updatedAt)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditSku(sku)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-blue-600"
                            title="编辑 SKU"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteSku(sku)}
                            className="rounded p-1 text-gray-500 hover:bg-rose-50 hover:text-rose-600"
                            title="删除 SKU"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "assets" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500">
              此处上传的素材将自动关联至当前商品（{product.spu}），并支持一键设为封面图。
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void handleUploadLinkedAssets(e.target.files)}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{uploading ? "上传中..." : "上传素材到此商品"}</span>
              </button>
            </div>
          </div>

          {assets.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-14 text-center">
              <ImageIcon className="h-8 w-8 text-gray-300" />
              <p className="mt-2 text-xs text-gray-500">该商品暂未关联任何素材</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {assets.map((asset, idx) => {
                const isCover = product.coverVersionId === asset.currentVersionId;
                const reviewMeta = REVIEW_STATUS_META[asset.reviewStatus];
                return (
                  <div
                    key={asset.id}
                    className={`group flex flex-col overflow-hidden rounded-xl border bg-white ${
                      isCover ? "border-blue-500 ring-1 ring-blue-500/30" : "border-gray-200"
                    }`}
                  >
                    <div
                      className="relative aspect-square cursor-pointer overflow-hidden bg-gray-100"
                      onClick={() => setLightboxIndex(idx)}
                    >
                      {asset.thumbStatus === "ready" || asset.assetType === "image" ? (
                        <img
                          src={api.thumbnailUrl(asset.id, asset.currentVersionId)}
                          alt={asset.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs font-medium uppercase text-gray-400">
                          {asset.ext || asset.assetType}
                        </div>
                      )}
                      {isCover && (
                        <span className="absolute top-2 left-2 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          封面
                        </span>
                      )}
                      <span
                        className={`absolute top-2 right-2 rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewMeta.className}`}
                      >
                        {reviewMeta.label}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLightboxIndex(idx);
                        }}
                        className="absolute right-2 bottom-2 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                        title="放大预览"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex flex-1 flex-col p-2.5 text-xs">
                      <div className="truncate font-medium text-gray-900" title={asset.name}>
                        {asset.name}
                      </div>
                      <div className="font-mono-tabular mt-0.5 text-[11px] text-gray-400">
                        {asset.width && asset.height
                          ? `${asset.width}×${asset.height} · `
                          : ""}
                        {formatBytes(asset.sizeBytes)}
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
                        {asset.assetType === "image" && !isCover ? (
                          <button
                            type="button"
                            onClick={() => void handleSetCover(asset)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                          >
                            <Star className="h-3 w-3" />
                            设为封面
                          </button>
                        ) : (
                          <span className="text-[11px] text-gray-400">
                            {isCover ? "当前封面" : asset.assetType}
                          </span>
                        )}
                        <a
                          href={api.contentUrl(asset.id, asset.currentVersionId)}
                          className="text-[11px] text-gray-500 hover:text-gray-800"
                        >
                          下载
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-900">确认将商品移入回收站？</h3>
            <p className="mt-2 text-xs leading-relaxed text-gray-600">
              商品 <span className="font-mono-tabular font-semibold">{product.spu}</span> 当前包含{" "}
              <span className="font-mono-tabular font-semibold">{product.skus.length}</span> 个 SKU
              与 <span className="font-mono-tabular font-semibold">{assets.length}</span> 个关联素材。
              软删除后底层文件不会被删除，随时可在回收站一键恢复并保留全部关联关系。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleSoftDelete()}
                className="rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {deleting ? "处理中..." : "确认移入回收站"}
              </button>
            </div>
          </div>
        </div>
      )}

      {skuModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <h3 className="text-sm font-semibold text-gray-900">
                {editingSku ? "编辑 SKU" : "新增 SKU"}
              </h3>
              <button
                type="button"
                onClick={() => setSkuModalOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSku} className="space-y-3.5 p-5 text-xs">
              {skuError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{skuError}</span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">
                    SKU 编码 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={skuCode}
                    onChange={(e) => setSkuCode(e.target.value)}
                    placeholder="如 SPU-MUG-001-WHT-500"
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">状态</label>
                  <select
                    value={skuStatus}
                    onChange={(e) => setSkuStatus(e.target.value as SkuStatus)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="active">启用</option>
                    <option value="inactive">停用</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block font-medium text-gray-700">
                    变体名称 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={skuName}
                    onChange={(e) => setSkuName(e.target.value)}
                    placeholder="如 象牙白 500ml"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="font-medium text-gray-700">规格属性组合</label>
                  <button
                    type="button"
                    onClick={() => setSkuAttrs((prev) => [...prev, { key: "", value: "" }])}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                  >
                    <Plus className="h-3 w-3" />
                    添加属性
                  </button>
                </div>
                <div className="space-y-2">
                  {skuAttrs.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                      <input
                        type="text"
                        value={row.key}
                        onChange={(e) =>
                          setSkuAttrs((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, key: e.target.value } : item
                            )
                          )
                        }
                        placeholder="属性名（如 颜色）"
                        className="rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={row.value}
                        onChange={(e) =>
                          setSkuAttrs((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, value: e.target.value } : item
                            )
                          )
                        }
                        placeholder="属性值（如 象牙白）"
                        className="rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSkuAttrs((prev) =>
                            prev.length > 1 ? prev.filter((_, i) => i !== idx) : [{ key: "", value: "" }]
                          )
                        }
                        className="flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:border-rose-200 hover:text-rose-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setSkuModalOpen(false)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={skuSaving}
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {skuSaving ? "保存中..." : "保存 SKU"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <AssetLightbox
          items={assets}
          currentIndex={lightboxIndex}
          onChangeIndex={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
