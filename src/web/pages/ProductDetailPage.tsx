import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Columns,
  Copy,
  Edit3,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  Lock,
  Maximize2,
  Plus,
  Save,
  Star,
  Trash2,
  Unlock,
  Upload,
  X
} from "lucide-react";
import type {
  AppearanceConstraints,
  AssetDetail,
  AssetListItem,
  ListingSummary,
  ProductDetail,
  ProductMasterImageRecord,
  ProductStatus,
  ReviewStatus,
  SkuRecord,
  SkuStatus,
  StoreRecord
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { AssetLightbox } from "../components/AssetLightbox";
import {
  formatAspectRatio,
  formatBytes,
  formatDateTime,
  LISTING_STATUS_META,
  MASTER_ANGLE_OPTIONS,
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
  const [masterImages, setMasterImages] = useState<ProductMasterImageRecord[]>([]);
  const [listings, setListings] = useState<ListingSummary[]>([]);
  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "skus" | "assets" | "listings">("overview");

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

  // Master image lock / unlock modals
  const [lockModalAsset, setLockModalAsset] = useState<AssetListItem | null>(null);
  const [lockAngle, setLockAngle] = useState("front");
  const [lockIsPrimary, setLockIsPrimary] = useState(true);
  const [lockNote, setLockNote] = useState("");
  const [lockSubmitting, setLockSubmitting] = useState(false);

  const [unlockTarget, setUnlockTarget] = useState<ProductMasterImageRecord | null>(null);
  const [unlockNote, setUnlockNote] = useState("");
  const [replacementVersionId, setReplacementVersionId] = useState("");
  const [replacementAngle, setReplacementAngle] = useState("");
  const [replacementLockNote, setReplacementLockNote] = useState("");
  const [unlockSubmitting, setUnlockSubmitting] = useState(false);

  // Side-by-side master vs candidate review
  const [compareOpen, setCompareOpen] = useState(false);
  const [selectedMasterId, setSelectedMasterId] = useState<string>("");
  const [compareAssetId, setCompareAssetId] = useState<string>("");
  const [compareAssetDetail, setCompareAssetDetail] = useState<AssetDetail | null>(null);
  const [compareVersionId, setCompareVersionId] = useState<string>("");
  const [compareLoading, setCompareLoading] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [manualChecks, setManualChecks] = useState<Record<string, boolean>>({});

  // Create listing modal
  const [createListingOpen, setCreateListingOpen] = useState(false);
  const [newListingStoreId, setNewListingStoreId] = useState("");
  const [newListingName, setNewListingName] = useState("");
  const [newListingLanguage, setNewListingLanguage] = useState("");
  const [newListingSkuIds, setNewListingSkuIds] = useState<string[]>([]);
  const [listingSubmitting, setListingSubmitting] = useState(false);
  const [listingFormError, setListingFormError] = useState<string | null>(null);

  const imageAssets = useMemo(
    () => assets.filter((item) => item.assetType === "image"),
    [assets]
  );

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
      const [detail, assetRes, masterRes, listingRes, storeRes] = await Promise.all([
        api.getProduct(id),
        api.listAssets({ productId: id, page: 1, pageSize: 100 }),
        api.listProductMasterImages(id),
        api.listListings({ productId: id, page: 1, pageSize: 100 }),
        api.listStores()
      ]);
      setProduct(detail);
      syncFormFromProduct(detail);
      setAssets(assetRes.items);
      setMasterImages(masterRes.items);
      setListings(listingRes.items);
      setStores(storeRes.items);

      const primary = masterRes.items.find((m) => m.isPrimary) ?? masterRes.items[0];
      if (primary) {
        setSelectedMasterId((prev) =>
          prev && masterRes.items.some((m) => m.id === prev) ? prev : primary.id
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载商品详情失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!compareOpen || !compareAssetId) {
      setCompareAssetDetail(null);
      setCompareVersionId("");
      return;
    }
    let cancelled = false;
    setCompareLoading(true);
    api
      .getAsset(compareAssetId)
      .then((detail) => {
        if (cancelled) return;
        setCompareAssetDetail(detail);
        setCompareVersionId((prev) =>
          prev && detail.versions.some((v) => v.id === prev) ? prev : detail.currentVersionId
        );
        const currentVer = detail.versions.find((v) => v.id === detail.currentVersionId);
        setReviewNote(currentVer?.reviewNote ?? "");
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载待审素材版本失败");
        }
      })
      .finally(() => {
        if (!cancelled) setCompareLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [compareOpen, compareAssetId]);

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

  const openLockModal = (asset: AssetListItem) => {
    setLockModalAsset(asset);
    const usedAngles = new Set(masterImages.map((m) => m.angle));
    const firstUnused = MASTER_ANGLE_OPTIONS.find((opt) => !usedAngles.has(opt.value))?.value ?? "front";
    setLockAngle(firstUnused);
    setLockIsPrimary(masterImages.length === 0);
    setLockNote("");
  };

  const handleLockMaster = async (event: FormEvent) => {
    event.preventDefault();
    if (!id || !lockModalAsset) return;
    setLockSubmitting(true);
    setError(null);
    try {
      await api.lockProductMasterImage(id, {
        assetVersionId: lockModalAsset.currentVersionId,
        angle: lockAngle.trim() || "front",
        isPrimary: lockIsPrimary,
        lockNote: lockNote.trim()
      });
      setLockModalAsset(null);
      setNotice(`已锁定「${lockModalAsset.name}」V${lockModalAsset.versionNo} 为商品母图`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "锁定母图失败");
    } finally {
      setLockSubmitting(false);
    }
  };

  const handleSetPrimaryMaster = async (master: ProductMasterImageRecord) => {
    if (!id) return;
    setError(null);
    try {
      await api.setPrimaryMasterImage(id, master.id);
      setNotice(`已将视角 ${master.angle}（V${master.versionNo}）设为主母图`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "设置主母图失败");
    }
  };

  const openUnlockModal = (master: ProductMasterImageRecord) => {
    setUnlockTarget(master);
    setUnlockNote("");
    setReplacementVersionId("");
    setReplacementAngle(master.angle);
    setReplacementLockNote("");
  };

  const handleUnlockMaster = async (event: FormEvent) => {
    event.preventDefault();
    if (!id || !unlockTarget) return;
    if (!unlockNote.trim()) {
      setError("解锁或替换母图必须填写原因说明");
      return;
    }
    setUnlockSubmitting(true);
    setError(null);
    try {
      await api.unlockProductMasterImage(id, unlockTarget.id, {
        unlockNote: unlockNote.trim(),
        replacementAssetVersionId: replacementVersionId || undefined,
        replacementAngle: replacementVersionId ? replacementAngle.trim() || unlockTarget.angle : undefined,
        replacementLockNote: replacementVersionId ? replacementLockNote.trim() : undefined
      });
      setUnlockTarget(null);
      setNotice(replacementVersionId ? "已解锁旧母图并原子替换为新母图" : "已解锁该视角母图");
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "解锁母图失败");
    } finally {
      setUnlockSubmitting(false);
    }
  };

  const openCompareWithAsset = (asset: AssetListItem) => {
    setCompareOpen(true);
    setCompareAssetId(asset.id);
    setManualChecks({});
    const primary = masterImages.find((m) => m.isPrimary) ?? masterImages[0];
    if (primary && !selectedMasterId) {
      setSelectedMasterId(primary.id);
    }
  };

  const handleCompareReview = async (nextStatus: ReviewStatus) => {
    if (!compareVersionId || !compareAssetId) return;
    setReviewSubmitting(true);
    setError(null);
    try {
      const updated = await api.reviewAssetVersion(compareVersionId, {
        reviewStatus: nextStatus,
        reviewNote: reviewNote.trim()
      });
      setCompareAssetDetail((prev) =>
        prev
          ? {
              ...prev,
              reviewStatus:
                prev.currentVersionId === updated.id ? updated.reviewStatus : prev.reviewStatus,
              versions: prev.versions.map((v) => (v.id === updated.id ? updated : v))
            }
          : prev
      );
      setNotice(
        `版本 V${updated.versionNo} 审核状态已更新为「${REVIEW_STATUS_META[updated.reviewStatus].label}」`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "提交版本审核失败");
    } finally {
      setReviewSubmitting(false);
    }
  };

  const openCreateListingModal = () => {
    const activeStores = stores.filter((s) => s.status === "active");
    const firstStore = activeStores[0] ?? stores[0];
    setNewListingStoreId(firstStore?.id ?? "");
    setNewListingLanguage(firstStore?.defaultLanguage ?? "en");
    setNewListingName(
      product && firstStore
        ? `${product.nameZh} - ${firstStore.name}`
        : product?.nameZh ?? ""
    );
    setNewListingSkuIds(product ? product.skus.filter((s) => s.status === "active").map((s) => s.id) : []);
    setListingFormError(null);
    setCreateListingOpen(true);
  };

  const handleCreateListing = async (event: FormEvent) => {
    event.preventDefault();
    if (!id) return;
    if (!newListingStoreId) {
      setListingFormError("请先选择所属店铺（如暂无店铺，请先在「店铺与字典」中创建）");
      return;
    }
    if (!newListingName.trim()) {
      setListingFormError("请填写上架链接显示名称");
      return;
    }
    setListingSubmitting(true);
    setListingFormError(null);
    try {
      const created = await api.createListing({
        productId: id,
        storeId: newListingStoreId,
        displayName: newListingName.trim(),
        language: newListingLanguage.trim() || undefined,
        skuIds: newListingSkuIds
      });
      setCreateListingOpen(false);
      setNotice(`已创建上架链接「${created.displayName}」`);
      await loadAll();
    } catch (err) {
      setListingFormError(err instanceof ApiClientError ? err.message : "创建上架链接失败");
    } finally {
      setListingSubmitting(false);
    }
  };

  const handleDuplicateListing = async (listing: ListingSummary) => {
    setError(null);
    try {
      const copy = await api.duplicateListing(listing.id, {
        displayName: `${listing.displayName} (副本)`
      });
      setNotice(`已复制为独立草稿「${copy.displayName}」`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "复制上架链接失败");
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
          { key: "assets" as const, label: `素材与母图 (${assets.length} / 母图 ${masterImages.length})` },
          { key: "listings" as const, label: `上架链接 (${listings.length})` }
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
              <div className="sm:col-span-2">
                <label className="mb-1 block font-medium text-gray-700">参考图与人工核对说明</label>
                <textarea
                  rows={2}
                  value={constraints.referenceNotes ?? ""}
                  onChange={(e) =>
                    setConstraints((prev) => ({ ...prev, referenceNotes: e.target.value }))
                  }
                  placeholder="如：审核 AI 场景图时重点比对正面母图与侧面母图的握把弧度、杯口倒角与印字位置"
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
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500">
              此处上传的素材将自动关联至当前商品（{product.spu}），支持设为封面图、锁定多视角母图以及与母图并排对比审核。
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setCompareOpen((prev) => !prev);
                  const firstImg = imageAssets[0];
                  if (!compareOpen && !compareAssetId && firstImg) {
                    setCompareAssetId(firstImg.id);
                  }
                }}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  compareOpen
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                <Columns className="h-3.5 w-3.5" />
                <span>{compareOpen ? "收起并排对比审核" : "母图并排对比审核"}</span>
              </button>
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

          {/* Locked Master Images Panel */}
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                  <Lock className="h-4 w-4 text-amber-600" />
                  <span>已锁定商品母图（多视角）</span>
                </h2>
                <p className="mt-0.5 text-[11px] text-gray-500">
                  母图固定指向具体的不可变版本（asset_version_id）；后续上传新版本不会自动覆盖已锁定母图。
                </p>
              </div>
              <span className="font-mono-tabular rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                {masterImages.length} 个锁定视角
              </span>
            </div>

            {masterImages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-xs text-gray-500">
                尚未锁定任何商品母图。可在下方图片素材卡片点击「锁母图」锁定正面、侧面或细节参考图。
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {masterImages.map((master) => {
                  const angleLabel =
                    MASTER_ANGLE_OPTIONS.find((opt) => opt.value === master.angle)?.label ??
                    master.angle;
                  const hasNewer = master.latestVersionNo > master.versionNo;
                  return (
                    <div
                      key={master.id}
                      className={`flex flex-col overflow-hidden rounded-xl border bg-white ${
                        master.isPrimary
                          ? "border-amber-400 ring-1 ring-amber-400/30"
                          : "border-gray-200"
                      }`}
                    >
                      <div className="relative aspect-[4/3] bg-gray-100">
                        <img
                          src={api.thumbnailUrl(master.assetId, master.assetVersionId)}
                          alt={master.assetName}
                          className="h-full w-full object-contain"
                        />
                        <span className="absolute top-2 left-2 rounded bg-gray-900/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          {angleLabel}
                        </span>
                        {master.isPrimary && (
                          <span className="absolute top-2 right-2 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            主母图
                          </span>
                        )}
                        <span className="font-mono-tabular absolute bottom-2 left-2 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-gray-800 shadow-xs">
                          锁定 V{master.versionNo}
                        </span>
                      </div>
                      <div className="flex flex-1 flex-col p-3 text-xs">
                        <div className="truncate font-medium text-gray-900" title={master.assetName}>
                          {master.assetName}
                        </div>
                        <div className="font-mono-tabular mt-0.5 text-[11px] text-gray-500">
                          {master.width && master.height
                            ? `${master.width}×${master.height} (${formatAspectRatio(master.width, master.height)})`
                            : "—"}
                          {" · "}
                          {formatBytes(master.sizeBytes)}
                        </div>
                        {master.lockNote && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-gray-600">
                            备注：{master.lockNote}
                          </p>
                        )}
                        {hasNewer && (
                          <p className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] text-amber-800">
                            素材已有新版 V{master.latestVersionNo}，母图仍保持锁定在 V{master.versionNo}
                          </p>
                        )}
                        <div className="mt-auto flex items-center justify-between gap-2 border-t border-gray-100 pt-2 text-[11px]">
                          {!master.isPrimary ? (
                            <button
                              type="button"
                              onClick={() => void handleSetPrimaryMaster(master)}
                              className="font-medium text-blue-600 hover:text-blue-700"
                            >
                              设为主母图
                            </button>
                          ) : (
                            <span className="text-amber-700">默认参考视角</span>
                          )}
                          <button
                            type="button"
                            onClick={() => openUnlockModal(master)}
                            className="inline-flex items-center gap-1 font-medium text-gray-600 hover:text-rose-600"
                          >
                            <Unlock className="h-3 w-3" />
                            解锁/替换
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Side-by-Side Master vs Candidate Version Review */}
          {compareOpen && (
            <section className="rounded-xl border border-blue-200 bg-white p-4 shadow-xs">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
                <div>
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <Columns className="h-4 w-4 text-blue-600" />
                    <span>母图 vs 待审版本并排对比审核</span>
                  </h2>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    用于人工对照外观一致性约束审核衍生图或新版本，每个版本独立保存审核状态与意见。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCompareOpen(false)}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {(() => {
                const activeMaster =
                  masterImages.find((m) => m.id === selectedMasterId) ?? masterImages[0] ?? null;
                const selectedVersion =
                  compareAssetDetail?.versions.find((v) => v.id === compareVersionId) ??
                  compareAssetDetail?.versions[0] ??
                  null;
                const constraintItems = [
                  { key: "structure", label: "关键结构", value: constraints.structure },
                  { key: "proportion", label: "外观比例", value: constraints.proportion },
                  { key: "color", label: "颜色与工艺", value: constraints.color },
                  { key: "dimensions", label: "基准尺寸", value: constraints.dimensions },
                  { key: "forbiddenChanges", label: "禁止变更项", value: constraints.forbiddenChanges },
                  { key: "referenceNotes", label: "参考说明", value: constraints.referenceNotes }
                ].filter((item) => item.value && item.value.trim().length > 0);

                return (
                  <div className="space-y-4 text-xs">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      {/* Left: Locked Master */}
                      <div className="flex flex-col rounded-xl border border-amber-200 bg-amber-50/30 p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="font-semibold text-amber-900">基准母图（已锁定）</span>
                          <select
                            value={activeMaster?.id ?? ""}
                            onChange={(e) => setSelectedMasterId(e.target.value)}
                            className="max-w-[220px] rounded-lg border border-amber-200 bg-white px-2 py-1 text-[11px] focus:border-blue-500 focus:outline-none"
                          >
                            {masterImages.length === 0 ? (
                              <option value="">暂无已锁定母图</option>
                            ) : (
                              masterImages.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.isPrimary ? "★ " : ""}
                                  {m.angle} · {m.assetName} (V{m.versionNo})
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white">
                          {activeMaster ? (
                            <img
                              src={api.contentUrl(activeMaster.assetId, activeMaster.assetVersionId, true)}
                              alt={activeMaster.assetName}
                              className="max-h-full max-w-full object-contain"
                            />
                          ) : (
                            <p className="text-gray-400">请先锁定至少一张商品母图作为基准</p>
                          )}
                        </div>
                        {activeMaster && (
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-600">
                            <span className="font-mono-tabular">
                              锁定版本 V{activeMaster.versionNo} ·{" "}
                              {activeMaster.width && activeMaster.height
                                ? `${activeMaster.width}×${activeMaster.height} (${formatAspectRatio(activeMaster.width, activeMaster.height)})`
                                : "—"}
                            </span>
                            <span>{activeMaster.lockNote || "无锁定备注"}</span>
                          </div>
                        )}
                      </div>

                      {/* Right: Candidate Asset & Version */}
                      <div className="flex flex-col rounded-xl border border-gray-200 bg-gray-50/50 p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-gray-900">待审素材与版本</span>
                          <div className="flex items-center gap-1.5">
                            <select
                              value={compareAssetId}
                              onChange={(e) => setCompareAssetId(e.target.value)}
                              className="max-w-[180px] rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] focus:border-blue-500 focus:outline-none"
                            >
                              <option value="">选择商品图片素材</option>
                              {imageAssets.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name} (V{a.versionNo})
                                </option>
                              ))}
                            </select>
                            {compareAssetDetail && (
                              <select
                                value={compareVersionId}
                                onChange={(e) => {
                                  const nextVid = e.target.value;
                                  setCompareVersionId(nextVid);
                                  const ver = compareAssetDetail.versions.find((v) => v.id === nextVid);
                                  setReviewNote(ver?.reviewNote ?? "");
                                }}
                                className="font-mono-tabular rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] focus:border-blue-500 focus:outline-none"
                              >
                                {compareAssetDetail.versions.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    V{v.versionNo} ({REVIEW_STATUS_META[v.reviewStatus].label})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>
                        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white">
                          {compareLoading ? (
                            <p className="text-gray-400">正在加载版本预览...</p>
                          ) : compareAssetDetail && selectedVersion ? (
                            <img
                              src={api.contentUrl(compareAssetDetail.id, selectedVersion.id, true)}
                              alt={compareAssetDetail.name}
                              className="max-h-full max-w-full object-contain"
                            />
                          ) : (
                            <p className="text-gray-400">请选择要审核的商品图片素材</p>
                          )}
                        </div>
                        {selectedVersion && (
                          <div className="mt-2 space-y-1 text-[11px] text-gray-600">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-mono-tabular">
                                V{selectedVersion.versionNo} ·{" "}
                                {selectedVersion.width && selectedVersion.height
                                  ? `${selectedVersion.width}×${selectedVersion.height} (${formatAspectRatio(selectedVersion.width, selectedVersion.height)})`
                                  : "—"}{" "}
                                · {formatBytes(selectedVersion.sizeBytes)}
                              </span>
                              <span
                                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                                  REVIEW_STATUS_META[selectedVersion.reviewStatus].className
                                }`}
                              >
                                {REVIEW_STATUS_META[selectedVersion.reviewStatus].label}
                              </span>
                            </div>
                            {selectedVersion.changeNote && (
                              <p className="text-gray-600">变更说明：{selectedVersion.changeNote}</p>
                            )}
                            {selectedVersion.promptText && (
                              <p className="line-clamp-2 text-gray-500">
                                提示词：{selectedVersion.promptText}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Manual Appearance Checklist + Review Actions */}
                    <div className="grid grid-cols-1 gap-4 rounded-xl border border-gray-200 bg-gray-50 p-3.5 lg:grid-cols-2">
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-gray-900">外观一致性人工核对清单</span>
                          <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-500">
                            人工核对（非自动识别）
                          </span>
                        </div>
                        {constraintItems.length === 0 ? (
                          <p className="text-[11px] text-gray-500">
                            暂未填写外观一致性约束，可在「基础信息与规格」中补充关键结构、比例与禁止变更项。
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {constraintItems.map((item) => (
                              <label
                                key={item.key}
                                className="flex cursor-pointer items-start gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px]"
                              >
                                <input
                                  type="checkbox"
                                  checked={Boolean(manualChecks[item.key])}
                                  onChange={(e) =>
                                    setManualChecks((prev) => ({
                                      ...prev,
                                      [item.key]: e.target.checked
                                    }))
                                  }
                                  className="mt-0.5 rounded border-gray-300"
                                />
                                <span>
                                  <strong className="text-gray-800">{item.label}：</strong>
                                  <span className="text-gray-600">{item.value}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col justify-between space-y-2.5">
                        <div>
                          <label className="mb-1 block font-semibold text-gray-900">
                            当前版本审核意见
                          </label>
                          <textarea
                            rows={3}
                            value={reviewNote}
                            onChange={(e) => setReviewNote(e.target.value)}
                            placeholder="记录构图、外观一致性或修改建议（仅作用于当前选中的版本）"
                            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={!selectedVersion || reviewSubmitting}
                            onClick={() => void handleCompareReview("approved")}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            审核通过
                          </button>
                          <button
                            type="button"
                            disabled={!selectedVersion || reviewSubmitting}
                            onClick={() => void handleCompareReview("rejected")}
                            className="rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                          >
                            标记拒绝
                          </button>
                          <button
                            type="button"
                            disabled={!selectedVersion || reviewSubmitting}
                            onClick={() => void handleCompareReview("pending")}
                            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                          >
                            重置待审
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

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
                const lockedEntry = masterImages.find(
                  (m) => m.assetVersionId === asset.currentVersionId
                );
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
                      <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                        {isCover && (
                          <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            封面
                          </span>
                        )}
                        {lockedEntry && (
                          <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            母图·{lockedEntry.angle}
                          </span>
                        )}
                      </div>
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
                        V{asset.versionNo} ·{" "}
                        {asset.width && asset.height
                          ? `${asset.width}×${asset.height} · `
                          : ""}
                        {formatBytes(asset.sizeBytes)}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-gray-100 pt-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {asset.assetType === "image" && !isCover ? (
                            <button
                              type="button"
                              onClick={() => void handleSetCover(asset)}
                              className="inline-flex items-center gap-0.5 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                            >
                              <Star className="h-3 w-3" />
                              封面
                            </button>
                          ) : (
                            <span className="text-[11px] text-gray-400">
                              {isCover ? "当前封面" : asset.assetType}
                            </span>
                          )}
                          {asset.assetType === "image" && (
                            <button
                              type="button"
                              onClick={() => openLockModal(asset)}
                              className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-700 hover:text-amber-800"
                              title="锁定当前版本为商品母图"
                            >
                              <Lock className="h-3 w-3" />
                              锁母图
                            </button>
                          )}
                        </div>
                        {asset.assetType === "image" ? (
                          <button
                            type="button"
                            onClick={() => openCompareWithAsset(asset)}
                            className="text-[11px] font-medium text-gray-600 hover:text-blue-600"
                          >
                            对比审核
                          </button>
                        ) : (
                          <a
                            href={api.contentUrl(asset.id, asset.currentVersionId)}
                            className="text-[11px] text-gray-500 hover:text-gray-800"
                          >
                            下载
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "listings" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500">
              同一商品可映射到多个平台与店铺的独立上架链接，各自维护 SKU 子集、图组编排与多语言 PDP 文案。
            </p>
            <button
              type="button"
              onClick={openCreateListingModal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>新建上架链接</span>
            </button>
          </div>

          {listings.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-14 text-center">
              <Layers className="h-8 w-8 text-gray-300" />
              <p className="mt-2 text-xs text-gray-500">该商品暂未创建任何店铺上架链接</p>
              <button
                type="button"
                onClick={openCreateListingModal}
                className="mt-3 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                创建首个上架链接
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {listings.map((item) => {
                const badge = LISTING_STATUS_META[item.status];
                return (
                  <div
                    key={item.id}
                    className="flex flex-col justify-between rounded-xl border border-gray-200 bg-white p-4 text-xs"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-gray-900">
                            {item.displayName}
                          </h3>
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            {item.storeName} · {item.platform} · {item.market} · 语言 {item.language}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div className="font-mono-tabular mt-3 flex flex-wrap gap-2 text-[11px] text-gray-600">
                        <span className="rounded bg-gray-100 px-2 py-0.5">SKU {item.skuCount}</span>
                        <span className="rounded bg-gray-100 px-2 py-0.5">轮播 {item.carouselCount}</span>
                        <span className="rounded bg-gray-100 px-2 py-0.5">详情 {item.detailCount}</span>
                        <span className="rounded bg-gray-100 px-2 py-0.5">SKU图 {item.skuImageCount}</span>
                        <span className="rounded bg-gray-100 px-2 py-0.5">PDP版本 {item.pdpVersionCount}</span>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2.5">
                      <button
                        type="button"
                        onClick={() => void handleDuplicateListing(item)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-600 hover:text-gray-900"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        <span>复制独立草稿</span>
                      </button>
                      <Link
                        to={`/listings/${item.id}`}
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-blue-700"
                      >
                        <span>打开上架工作台</span>
                      </Link>
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

      {/* Lock Master Image Modal */}
      {lockModalAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <h3 className="text-sm font-semibold text-gray-900">锁定为商品母图</h3>
              <button
                type="button"
                onClick={() => setLockModalAsset(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleLockMaster} className="space-y-3.5 p-5 text-xs">
              <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 p-2.5">
                <img
                  src={api.thumbnailUrl(lockModalAsset.id, lockModalAsset.currentVersionId)}
                  alt={lockModalAsset.name}
                  className="h-12 w-12 rounded object-cover"
                />
                <div className="min-w-0">
                  <div className="truncate font-medium text-gray-900">{lockModalAsset.name}</div>
                  <div className="font-mono-tabular text-[11px] text-gray-500">
                    锁定版本 V{lockModalAsset.versionNo}
                  </div>
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">拍摄视角</label>
                <select
                  value={lockAngle}
                  onChange={(e) => setLockAngle(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                >
                  {MASTER_ANGLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-gray-700">
                <input
                  type="checkbox"
                  checked={lockIsPrimary}
                  onChange={(e) => setLockIsPrimary(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>设为商品主母图（对比审核默认基准）</span>
              </label>
              <div>
                <label className="mb-1 block font-medium text-gray-700">锁定说明</label>
                <textarea
                  rows={2}
                  value={lockNote}
                  onChange={(e) => setLockNote(e.target.value)}
                  placeholder="如：摄影棚实拍标准色基准图"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setLockModalAsset(null)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={lockSubmitting}
                  className="rounded-lg bg-amber-600 px-4 py-2 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {lockSubmitting ? "锁定中..." : "确认锁定母图"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Unlock / Replace Master Image Modal */}
      {unlockTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <h3 className="text-sm font-semibold text-gray-900">
                解锁或替换母图（视角：{unlockTarget.angle} · V{unlockTarget.versionNo}）
              </h3>
              <button
                type="button"
                onClick={() => setUnlockTarget(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleUnlockMaster} className="space-y-3.5 p-5 text-xs">
              <div>
                <label className="mb-1 block font-medium text-gray-700">
                  解锁 / 替换原因 <span className="text-rose-500">*</span>
                </label>
                <textarea
                  required
                  rows={2}
                  value={unlockNote}
                  onChange={(e) => setUnlockNote(e.target.value)}
                  placeholder="必填：说明为何变更该视角母图（将写入审计日志与历史记录）"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">
                  原子替换为新母图（可选）
                </label>
                <select
                  value={replacementVersionId}
                  onChange={(e) => setReplacementVersionId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">仅解锁，不立即替换</option>
                  {imageAssets
                    .filter((a) => a.currentVersionId !== unlockTarget.assetVersionId)
                    .map((a) => (
                      <option key={a.id} value={a.currentVersionId}>
                        {a.name} (当前版本 V{a.versionNo})
                      </option>
                    ))}
                </select>
              </div>
              {replacementVersionId && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block font-medium text-gray-700">新母图视角</label>
                    <select
                      value={replacementAngle}
                      onChange={(e) => setReplacementAngle(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                    >
                      {MASTER_ANGLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-gray-700">新母图锁定说明</label>
                    <input
                      type="text"
                      value={replacementLockNote}
                      onChange={(e) => setReplacementLockNote(e.target.value)}
                      placeholder="可选说明"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setUnlockTarget(null)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={unlockSubmitting}
                  className="rounded-lg bg-rose-600 px-4 py-2 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {unlockSubmitting
                    ? "处理中..."
                    : replacementVersionId
                      ? "确认替换母图"
                      : "确认解锁母图"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Listing Modal */}
      {createListingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <h3 className="text-sm font-semibold text-gray-900">
                新建上架链接（{product.spu}）
              </h3>
              <button
                type="button"
                onClick={() => setCreateListingOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateListing} className="space-y-3.5 p-5 text-xs">
              {listingFormError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{listingFormError}</span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">
                    目标店铺 <span className="text-rose-500">*</span>
                  </label>
                  <select
                    value={newListingStoreId}
                    onChange={(e) => {
                      const sid = e.target.value;
                      setNewListingStoreId(sid);
                      const found = stores.find((s) => s.id === sid);
                      if (found) {
                        setNewListingLanguage(found.defaultLanguage);
                        setNewListingName(`${product.nameZh} - ${found.name}`);
                      }
                    }}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">请选择店铺</option>
                    {stores
                      .filter((s) => s.status === "active")
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.platform} / {s.market})
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">文案语言</label>
                  <input
                    type="text"
                    value={newListingLanguage}
                    onChange={(e) => setNewListingLanguage(e.target.value)}
                    placeholder="如 en / th / zh-CN"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">
                  链接显示名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newListingName}
                  onChange={(e) => setNewListingName(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              {product.skus.length > 0 && (
                <div>
                  <label className="mb-1 block font-medium text-gray-700">
                    关联 SKU 子集（已选 {newListingSkuIds.length} / {product.skus.length}）
                  </label>
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
                    {product.skus.map((sku) => {
                      const checked = newListingSkuIds.includes(sku.id);
                      return (
                        <label key={sku.id} className="flex cursor-pointer items-center gap-2 text-[11px]">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setNewListingSkuIds((prev) =>
                                checked ? prev.filter((sid) => sid !== sku.id) : [...prev, sku.id]
                              )
                            }
                            className="rounded border-gray-300"
                          />
                          <span className="font-mono-tabular text-gray-600">{sku.code}</span>
                          <span className="truncate text-gray-800">{sku.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setCreateListingOpen(false)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={listingSubmitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {listingSubmitting ? "创建中..." : "创建上架链接"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
