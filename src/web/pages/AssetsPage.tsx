import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  FileArchive,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Grid,
  HardDrive,
  History,
  Image as ImageIcon,
  Inbox,
  Layers,
  List,
  Lock,
  Maximize2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Star,
  Tag,
  Trash2,
  Upload,
  X
} from "lucide-react";
import type {
  AssetDetail,
  AssetListItem,
  AssetType,
  FolderRecord,
  ProductSummary,
  ReviewStatus,
  StorageProviderSummary,
  StoreRecord,
  TagDimension,
  TagRecord
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { AssetLightbox } from "../components/AssetLightbox";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { FileDropButton, useFileDrop } from "../components/FileDropButton";
import { StorageStatusBadge } from "../components/StatusBadge";
import {
  ASSET_PURPOSES,
  formatBytes,
  formatDateTime,
  REVIEW_STATUS_META,
  TAG_DIMENSION_LABELS
} from "../utils/format";

type QuickView = "all" | "favorite" | "pending" | "unfiled";

const DIMENSION_ORDER: TagDimension[] = [
  "market",
  "platform",
  "purpose",
  "scene",
  "color",
  "custom"
];

export function AssetsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const uploadInFlight = useRef(false);
  const versionUploadInFlight = useRef(false);
  const scrollParentRef = useRef<HTMLDivElement>(null);

  // Taxonomy & reference lists
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [storages, setStorages] = useState<StorageProviderSummary[]>([]);
  const [stores, setStores] = useState<StoreRecord[]>([]);

  const initialReviewParam = searchParams.get("reviewStatus");
  const initialReviewStatus: ReviewStatus | "" =
    initialReviewParam === "pending" ||
    initialReviewParam === "approved" ||
    initialReviewParam === "rejected"
      ? initialReviewParam
      : "";
  const initialQuickViewParam = searchParams.get("quickView");
  const initialQuickView: QuickView =
    initialQuickViewParam === "favorite" ||
    initialQuickViewParam === "pending" ||
    initialQuickViewParam === "unfiled"
      ? initialQuickViewParam
      : initialReviewStatus === "pending"
        ? "pending"
        : "all";

  // Filter state
  const [quickView, setQuickView] = useState<QuickView>(initialQuickView);
  const [folderId, setFolderId] = useState<string>("");
  const [tagId, setTagId] = useState<string>("");
  const [storageId, setStorageId] = useState<string>("");
  const [productId, setProductId] = useState<string>(searchParams.get("productId") || "");
  const [storeId, setStoreId] = useState<string>("");
  const [assetType, setAssetType] = useState<AssetType | "">("");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | "">(initialReviewStatus);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "name_asc" | "size_desc">("newest");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Asset list
  const [items, setItems] = useState<AssetListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Selection & Inspector
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [activeAsset, setActiveAsset] = useState<AssetDetail | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [thumbBustMap, setThumbBustMap] = useState<Record<string, number>>({});

  // Inspector edit fields
  const [editName, setEditName] = useState("");
  const [editPurpose, setEditPurpose] = useState("other");
  const [editFolderId, setEditFolderId] = useState<string>("");
  const [editSource, setEditSource] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editTagIds, setEditTagIds] = useState<string[]>([]);
  const [editProductIds, setEditProductIds] = useState<string[]>([]);
  const [savingInspector, setSavingInspector] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  // Version upload & independent per-version review
  const [versionFormOpen, setVersionFormOpen] = useState(false);
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [versionFileError, setVersionFileError] = useState<string | null>(null);
  const [versionChangeNote, setVersionChangeNote] = useState("");
  const [versionPromptText, setVersionPromptText] = useState("");
  const [versionSetCurrent, setVersionSetCurrent] = useState(true);
  const [versionUploading, setVersionUploading] = useState(false);
  const [versionActionBusyId, setVersionActionBusyId] = useState<string | null>(null);
  const [reviewingVersionId, setReviewingVersionId] = useState<string | null>(null);
  const [versionReviewNote, setVersionReviewNote] = useState("");

  // Upload state
  const [uploadModalError, setUploadModalError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [exportingStandard, setExportingStandard] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadTargetProductId, setUploadTargetProductId] = useState("");
  const [uploadTargetFolderId, setUploadTargetFolderId] = useState("");
  const [uploadTargetPurpose, setUploadTargetPurpose] = useState("raw");
  const [uploadTargetStorageId, setUploadTargetStorageId] = useState("");
  const [uploadPendingFiles, setUploadPendingFiles] = useState<File[]>([]);

  // Inline folder/tag creation
  const [newFolderName, setNewFolderName] = useState("");
  const [addingFolder, setAddingFolder] = useState(false);
  const [newTagDim, setNewTagDim] = useState<TagDimension>("custom");
  const [newTagName, setNewTagName] = useState("");
  const [addingTag, setAddingTag] = useState(false);

  // Batch action controls
  const [batchFolderId, setBatchFolderId] = useState("");
  const [batchProductId, setBatchProductId] = useState("");
  const [batchTagId, setBatchTagId] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);

  // Lightbox
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Virtualization grid columns responsive to container width
  const [gridColumns, setGridColumns] = useState(4);

  useEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    const updateCols = () => {
      const width = el.clientWidth;
      if (width >= 1024) setGridColumns(5);
      else if (width >= 760) setGridColumns(4);
      else if (width >= 520) setGridColumns(3);
      else setGridColumns(2);
    };
    updateCols();
    const observer = new ResizeObserver(updateCols);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadTaxonomy = useCallback(async () => {
    const [folderRes, tagRes, productRes, storageRes, storeRes] = await Promise.allSettled([
      api.listFolders(),
      api.listTags(),
      api.listProducts({ page: 1, pageSize: 100 }),
      api.getStorageProviders(),
      api.listStores()
    ]);

    const failures: string[] = [];
    if (folderRes.status === "fulfilled") setFolders(folderRes.value.items);
    else failures.push("文件夹");
    if (tagRes.status === "fulfilled") setTags(tagRes.value.items);
    else failures.push("标签");
    if (productRes.status === "fulfilled") setProducts(productRes.value.items);
    else failures.push("商品");
    if (storageRes.status === "fulfilled") setStorages(storageRes.value.items);
    else failures.push("存储位置");
    if (storeRes.status === "fulfilled") setStores(storeRes.value.items);
    else failures.push("店铺");

    if (failures.length > 0) {
      setError(`部分筛选项加载失败：${failures.join("、")}`);
    }
  }, []);

  useEffect(() => {
    void loadTaxonomy();
  }, [loadTaxonomy]);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listAssets({
        q: query.trim() || undefined,
        productId: productId || undefined,
        storeId: storeId || undefined,
        tagId: tagId || undefined,
        folderId: folderId || undefined,
        storageId: storageId || undefined,
        type: assetType || undefined,
        reviewStatus: quickView === "pending" ? "pending" : reviewStatus || undefined,
        favorite: quickView === "favorite" ? true : undefined,
        unfiled: quickView === "unfiled" ? true : undefined,
        sort,
        page: 1,
        pageSize: 200
      });
      setItems(res.items);
      setTotal(res.total);
      setSelectedIds((prev) => {
        const valid = new Set(res.items.map((item) => item.id));
        const next = new Set<string>();
        for (const id of prev) {
          if (valid.has(id)) next.add(id);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载素材列表失败");
    } finally {
      setLoading(false);
    }
  }, [query, productId, storeId, tagId, folderId, storageId, assetType, reviewStatus, quickView, sort]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAssets();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [loadAssets]);

  const syncInspectorFields = (detail: AssetDetail) => {
    setEditName(detail.name);
    setEditPurpose(detail.purpose || "other");
    setEditFolderId(detail.folderId || "");
    setEditSource(detail.source || "");
    setEditNotes(detail.notes || "");
    setEditTagIds(detail.tags.map((t) => t.id));
    setEditProductIds(detail.products.map((p) => p.id));
  };

  const loadActiveAsset = useCallback(async (assetId: string) => {
    setInspectorLoading(true);
    try {
      const detail = await api.getAsset(assetId);
      setActiveAsset(detail);
      syncInspectorFields(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载素材详情失败");
    } finally {
      setInspectorLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeAssetId) {
      setActiveAsset(null);
      return;
    }
    setVersionFormOpen(false);
    setVersionFile(null);
    setVersionFileError(null);
    setVersionChangeNote("");
    setVersionPromptText("");
    setVersionSetCurrent(true);
    setReviewingVersionId(null);
    void loadActiveAsset(activeAssetId);
  }, [activeAssetId, loadActiveAsset]);

  useEffect(() => {
    if (!activeAssetId || lightboxIndex !== null || confirmDialog || uploadModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.innerWidth < 1280) {
        setActiveAssetId(null);
        setActiveAsset(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeAssetId, lightboxIndex, confirmDialog, uploadModalOpen]);

  const hasActiveFilters = Boolean(
    quickView !== "all" ||
      folderId ||
      tagId ||
      storageId ||
      productId ||
      storeId ||
      assetType ||
      reviewStatus ||
      query.trim()
  );

  const resetAllFilters = () => {
    setQuickView("all");
    setFolderId("");
    setTagId("");
    setStorageId("");
    setProductId("");
    setStoreId("");
    setAssetType("");
    setReviewStatus("");
    setQuery("");
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("productId");
    nextParams.delete("reviewStatus");
    nextParams.delete("quickView");
    setSearchParams(nextParams, { replace: true });
  };

  const tagsByDimension = useMemo(() => {
    const grouped = new Map<TagDimension, TagRecord[]>();
    for (const dim of DIMENSION_ORDER) {
      grouped.set(dim, []);
    }
    for (const tag of tags) {
      const list = grouped.get(tag.dimension) ?? [];
      list.push(tag);
      grouped.set(tag.dimension, list);
    }
    return grouped;
  }, [tags]);

  const rowCount = viewMode === "grid" ? Math.ceil(items.length / gridColumns) : items.length;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => (viewMode === "grid" ? 232 : 56),
    overscan: 4
  });

  const selectQuickView = (view: QuickView) => {
    setQuickView(view);
    if (view === "pending") {
      setReviewStatus("pending");
    } else if (reviewStatus === "pending") {
      setReviewStatus("");
    }
    if (view !== "all") {
      setFolderId("");
      setTagId("");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((item) => item.id)));
    }
  };

  const handleToggleFavorite = async (item: AssetListItem) => {
    try {
      const updated = await api.updateAsset(item.id, { isFavorite: !item.isFavorite });
      setItems((prev) =>
        prev.map((row) => (row.id === item.id ? { ...row, isFavorite: updated.isFavorite } : row))
      );
      if (activeAsset?.id === item.id) {
        setActiveAsset(updated);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "更新收藏状态失败");
    }
  };

  const performUpload = async (
    files: File[],
    opts: { productId?: string; folderId?: string; purpose?: string; storageId?: string }
  ) => {
    if (files.length === 0 || uploadInFlight.current) return;
    uploadInFlight.current = true;
    setUploading(true);
    setUploadModalError(null);
    setError(null);
    setNotice(null);
    try {
      const res = await api.uploadAssets(files, {
        productId: opts.productId || undefined,
        folderId: opts.folderId || undefined,
        purpose: opts.purpose || undefined,
        storageId: opts.storageId || undefined
      });
      setNotice(
        `成功上传 ${res.uploadedCount} 个素材${
          res.deduplicatedCount > 0 ? `（${res.deduplicatedCount} 个命中内容去重）` : ""
        }`
      );
      setUploadModalOpen(false);
      setUploadPendingFiles([]);
      await Promise.all([loadAssets(), loadTaxonomy()]);
      if (res.items[0]) {
        setActiveAssetId(res.items[0].id);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : "上传失败";
      if (uploadModalOpen) setUploadModalError(message);
      else setError(message);
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
    }
  };

  const { draggingOver, dropProps: workspaceDropProps } = useFileDrop((files) => {
    void performUpload(files, {
      productId: productId || undefined,
      folderId: folderId || undefined,
      storageId: storageId || undefined
    });
  }, uploading || uploadModalOpen);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    setError(null);
    try {
      await api.createFolder({ name: newFolderName.trim() });
      setNewFolderName("");
      setAddingFolder(false);
      await loadTaxonomy();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "新建文件夹失败");
    }
  };

  const handleDeleteFolder = (folder: FolderRecord) => {
    setConfirmDialog({
      title: "删除文件夹",
      description: `确定删除文件夹「${folder.name}」吗？其中素材不会被删除，将自动变为未归类。`,
      confirmLabel: "删除文件夹",
      tone: "warning",
      onConfirm: async () => {
        setConfirmBusy(true);
        setError(null);
        try {
          await api.deleteFolder(folder.id);
          if (folderId === folder.id) setFolderId("");
          setConfirmDialog(null);
          await Promise.all([loadTaxonomy(), loadAssets()]);
        } catch (err) {
          setError(err instanceof ApiClientError ? err.message : "删除文件夹失败");
        } finally {
          setConfirmBusy(false);
        }
      }
    });
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    setError(null);
    try {
      await api.createTag({ dimension: newTagDim, name: newTagName.trim() });
      setNewTagName("");
      setAddingTag(false);
      await loadTaxonomy();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "新建标签失败");
    }
  };

  const handleSaveInspector = async () => {
    if (!activeAsset) return;
    setSavingInspector(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateAsset(activeAsset.id, {
        name: editName.trim() || activeAsset.name,
        purpose: editPurpose,
        folderId: editFolderId || null,
        source: editSource.trim(),
        notes: editNotes.trim(),
        tagIds: editTagIds,
        productIds: editProductIds
      });
      setActiveAsset(updated);
      syncInspectorFields(updated);
      setNotice("素材元数据已保存");
      await Promise.all([loadAssets(), loadTaxonomy()]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "保存素材信息失败");
    } finally {
      setSavingInspector(false);
    }
  };

  const handleRegenerateThumb = async () => {
    if (!activeAsset) return;
    setRegenBusy(true);
    setError(null);
    try {
      await api.regenerateThumbnail(activeAsset.id, activeAsset.currentVersionId);
      const now = Date.now();
      setThumbBustMap((prev) => ({ ...prev, [activeAsset.currentVersionId]: now }));
      setNotice("缩略图已重新生成");
      await Promise.all([loadAssets(), loadActiveAsset(activeAsset.id)]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "重新生成缩略图失败");
    } finally {
      setRegenBusy(false);
    }
  };

  const handleAppendVersion = async () => {
    if (!activeAsset || !versionFile || versionFileError || versionUploadInFlight.current) return;
    versionUploadInFlight.current = true;
    setVersionUploading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.appendAssetVersion(activeAsset.id, versionFile, {
        changeNote: versionChangeNote.trim() || undefined,
        promptText: versionPromptText.trim() || undefined,
        setAsCurrent: versionSetCurrent
      });
      setActiveAsset(res.asset);
      syncInspectorFields(res.asset);
      setVersionFile(null);
      setVersionChangeNote("");
      setVersionPromptText("");
      setVersionFormOpen(false);
      setNotice(
        `已追加新版本 V${res.version.versionNo}（旧版本完整保留${
          res.deduplicated ? "，复用已有底层文件" : ""
        }）`
      );
      await loadAssets();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "上传新版本失败");
    } finally {
      versionUploadInFlight.current = false;
      setVersionUploading(false);
    }
  };

  const handleSwitchVersion = async (versionId: string, versionNo: number) => {
    if (!activeAsset) return;
    setVersionActionBusyId(versionId);
    setError(null);
    try {
      const updated = await api.switchAssetCurrentVersion(activeAsset.id, versionId);
      setActiveAsset(updated);
      syncInspectorFields(updated);
      setNotice(`已将当前展示版本切换为 V${versionNo}`);
      await loadAssets();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "切换版本失败");
    } finally {
      setVersionActionBusyId(null);
    }
  };

  const handleReviewVersion = async (versionId: string, nextStatus: ReviewStatus) => {
    if (!activeAsset) return;
    setVersionActionBusyId(versionId);
    setError(null);
    try {
      const updatedVer = await api.reviewAssetVersion(versionId, {
        reviewStatus: nextStatus,
        reviewNote: versionReviewNote.trim()
      });
      setReviewingVersionId(null);
      setNotice(
        `版本 V${updatedVer.versionNo} 审核状态已更新为「${REVIEW_STATUS_META[updatedVer.reviewStatus].label}」`
      );
      await Promise.all([loadActiveAsset(activeAsset.id), loadAssets()]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "更新版本审核状态失败");
    } finally {
      setVersionActionBusyId(null);
    }
  };

  const handleSoftDeleteSingle = (asset: AssetDetail) => {
    setConfirmDialog({
      title: "移入回收站",
      description: `确定将素材「${asset.name}」移入回收站吗？后续可在回收站中恢复。`,
      confirmLabel: "移入回收站",
      tone: "danger",
      onConfirm: async () => {
        setConfirmBusy(true);
        setError(null);
        try {
          await api.batchAssets({ assetIds: [asset.id], action: "soft_delete" });
          setActiveAssetId(null);
          setActiveAsset(null);
          setConfirmDialog(null);
          setNotice("素材已移入回收站");
          await Promise.all([loadAssets(), loadTaxonomy()]);
        } catch (err) {
          setError(err instanceof ApiClientError ? err.message : "移入回收站失败");
        } finally {
          setConfirmBusy(false);
        }
      }
    });
  };

  const executeBatch = async (
    action:
      | "move_folder"
      | "add_tags"
      | "link_products"
      | "set_review_status"
      | "soft_delete",
    extra: {
      folderId?: string | null;
      tagIds?: string[];
      productIds?: string[];
      reviewStatus?: ReviewStatus;
    } = {}
  ) => {
    const assetIds = Array.from(selectedIds);
    if (assetIds.length === 0) return;
    setBatchBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.batchAssets({ assetIds, action, ...extra });
      setNotice(`批量操作已完成，影响 ${res.affectedCount} 个素材`);
      if (action === "soft_delete") {
        setSelectedIds(new Set());
        if (activeAssetId && selectedIds.has(activeAssetId)) {
          setActiveAssetId(null);
          setActiveAsset(null);
        }
      }
      await Promise.all([loadAssets(), loadTaxonomy()]);
      if (activeAssetId && action !== "soft_delete") {
        await loadActiveAsset(activeAssetId);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "批量操作失败");
    } finally {
      setBatchBusy(false);
    }
  };

  const runBatch = async (
    action:
      | "move_folder"
      | "add_tags"
      | "link_products"
      | "set_review_status"
      | "soft_delete",
    extra: {
      folderId?: string | null;
      tagIds?: string[];
      productIds?: string[];
      reviewStatus?: ReviewStatus;
    } = {}
  ) => {
    const assetIds = Array.from(selectedIds);
    if (assetIds.length === 0) return;
    if (action === "soft_delete") {
      setConfirmDialog({
        title: "批量移入回收站",
        description: `确定将已选中的 ${assetIds.length} 个素材移入回收站吗？移入后可在回收站恢复。`,
        confirmLabel: `移入回收站 (${assetIds.length})`,
        tone: "danger",
        onConfirm: async () => {
          setConfirmDialog(null);
          await executeBatch(action, extra);
        }
      });
      return;
    }
    await executeBatch(action, extra);
  };

  const renderAssetIcon = (item: AssetListItem) => {
    if (item.assetType === "video") return <Film className="h-7 w-7 text-gray-400" />;
    if (item.assetType === "archive") return <FileArchive className="h-7 w-7 text-gray-400" />;
    if (item.assetType === "document") return <FileText className="h-7 w-7 text-gray-400" />;
    return <ImageIcon className="h-7 w-7 text-gray-400" />;
  };

  const handleStandardOpenExport = async () => {
    setExportingStandard(true);
    setError(null);
    setNotice(null);
    try {
      const payload =
        selectedIds.size > 0
          ? { assetIds: Array.from(selectedIds), includeAllVersions: false }
          : productId
            ? { productId, includeAllVersions: false }
            : { includeAllVersions: false };
      await api.downloadStandardOpenExport(payload);
      setNotice(
        selectedIds.size > 0
          ? `已导出所选 ${selectedIds.size} 个素材的开放标准 ZIP 包（含 manifest.json）`
          : productId
            ? "已导出当前筛选商品的开放标准 ZIP 包（含 manifest.json）"
            : "已导出开放标准 ZIP 包（含 manifest.json）"
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "导出开放标准包失败");
    } finally {
      setExportingStandard(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">全部素材</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            多维筛选、虚拟滚动浏览与批量元数据管理（当前匹配{" "}
            <span className="font-mono-tabular font-medium text-gray-700">{total}</span> 项）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void loadAssets();
              void loadTaxonomy();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </button>
          <button
            type="button"
            onClick={() => void handleStandardOpenExport()}
            disabled={exportingStandard || total === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            <span>
              {exportingStandard
                ? "正在打包..."
                : selectedIds.size > 0
                  ? `导出开放标准包 (${selectedIds.size})`
                  : "导出开放标准包"}
            </span>
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => {
              setUploadTargetProductId(productId);
              setUploadTargetFolderId(folderId);
              setUploadTargetStorageId(storageId);
              setUploadPendingFiles([]);
              setUploadModalError(null);
              setUploadModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>上传素材</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs text-rose-700">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} className="text-rose-500">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-700">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </div>
          <button type="button" onClick={() => setNotice(null)} className="text-emerald-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex h-[calc(100vh-11.5rem)] min-h-[560px] overflow-hidden rounded-xl border border-gray-200 bg-white">
        {/* Left Taxonomy Rail */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-gray-200 bg-gray-50/60 md:flex">
          <div className="flex-1 space-y-5 overflow-y-auto p-3 text-xs">
            <div>
              <div className="mb-1.5 px-2 text-[11px] font-semibold text-gray-400">快捷视图</div>
              <div className="space-y-0.5">
                {[
                  { key: "all" as const, label: "全部素材", icon: Layers },
                  { key: "favorite" as const, label: "收藏夹", icon: Star },
                  { key: "pending" as const, label: "待审核", icon: AlertCircle },
                  { key: "unfiled" as const, label: "未归类", icon: Inbox }
                ].map((view) => {
                  const Icon = view.icon;
                  const active = quickView === view.key && !folderId && !tagId;
                  return (
                    <button
                      key={view.key}
                      type="button"
                      onClick={() => selectQuickView(view.key)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                        active
                          ? "bg-blue-50 font-medium text-blue-700"
                          : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{view.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between px-2">
                <span className="text-[11px] font-semibold text-gray-400">文件夹</span>
                <button
                  type="button"
                  onClick={() => setAddingFolder((prev) => !prev)}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                  title="新建文件夹"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
              </div>
              {addingFolder && (
                <div className="mb-2 flex gap-1 px-1">
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreateFolder();
                    }}
                    placeholder="文件夹名称"
                    className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateFolder()}
                    className="rounded bg-blue-600 px-2 py-1 text-[11px] text-white"
                  >
                    加
                  </button>
                </div>
              )}
              <div className="space-y-0.5">
                {folders.length === 0 ? (
                  <p className="px-2 text-[11px] text-gray-400">暂无文件夹</p>
                ) : (
                  folders.map((folder) => {
                    const active = folderId === folder.id;
                    return (
                      <div
                        key={folder.id}
                        className={`group flex items-center justify-between rounded-lg px-2 py-1.5 ${
                          active
                            ? "bg-blue-50 font-medium text-blue-700"
                            : "text-gray-700 hover:bg-gray-100"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setQuickView("all");
                            setFolderId(active ? "" : folder.id);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <Folder className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{folder.name}</span>
                        </button>
                        <div className="flex items-center gap-1">
                          <span className="font-mono-tabular text-[10px] text-gray-400">
                            {folder.assetCount}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleDeleteFolder(folder)}
                            className="hidden rounded p-0.5 text-gray-400 hover:text-rose-600 group-hover:block"
                            title="删除文件夹"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between px-2">
                <span className="text-[11px] font-semibold text-gray-400">多维标签</span>
                <button
                  type="button"
                  onClick={() => setAddingTag((prev) => !prev)}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                  title="新建标签"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {addingTag && (
                <div className="mb-2 space-y-1 rounded-lg border border-gray-200 bg-white p-2">
                  <select
                    value={newTagDim}
                    onChange={(e) => setNewTagDim(e.target.value as TagDimension)}
                    className="w-full rounded border border-gray-200 px-1.5 py-1 text-[11px]"
                  >
                    {DIMENSION_ORDER.map((dim) => (
                      <option key={dim} value={dim}>
                        {TAG_DIMENSION_LABELS[dim]}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleCreateTag();
                      }}
                      placeholder="标签名称"
                      className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-[11px] focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreateTag()}
                      className="rounded bg-blue-600 px-2 py-1 text-[11px] text-white"
                    >
                      加
                    </button>
                  </div>
                </div>
              )}
              <div className="space-y-2.5 px-1">
                {DIMENSION_ORDER.map((dim) => {
                  const dimTags = tagsByDimension.get(dim) ?? [];
                  if (dimTags.length === 0) return null;
                  return (
                    <div key={dim}>
                      <div className="mb-1 px-1 text-[10px] font-medium text-gray-400">
                        {TAG_DIMENSION_LABELS[dim]}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {dimTags.map((tag) => {
                          const active = tagId === tag.id;
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              onClick={() => {
                                setQuickView("all");
                                setTagId(active ? "" : tag.id);
                              }}
                              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
                                active
                                  ? "border-blue-500 bg-blue-50 font-medium text-blue-700"
                                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                              }`}
                            >
                              <span>{tag.name}</span>
                              {tag.assetCount > 0 && (
                                <span className="font-mono-tabular text-[10px] text-gray-400">
                                  {tag.assetCount}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 px-2 text-[11px] font-semibold text-gray-400">存储位置</div>
              <div className="space-y-0.5">
                {storages.map((st) => {
                  const active = storageId === st.id;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setStorageId(active ? "" : st.id)}
                      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left ${
                        active
                          ? "bg-blue-50 font-medium text-blue-700"
                          : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <HardDrive className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{st.name}</span>
                      </span>
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          st.status === "healthy"
                            ? "bg-emerald-500"
                            : st.status === "offline"
                              ? "bg-rose-500"
                              : "bg-amber-400"
                        }`}
                        title={st.status}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </aside>

        {/* Center Workspace */}
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          {...workspaceDropProps}
        >
          {draggingOver && (
            <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center border-2 border-dashed border-blue-500 bg-blue-50/85 backdrop-blur-[1px]">
              <Upload className="h-9 w-9 text-blue-600" />
              <p className="mt-2 text-sm font-semibold text-blue-700">松开即可批量上传到当前视图</p>
            </div>
          )}

          {/* Filter Bar */}
          <div className="space-y-2 border-b border-gray-200 bg-white px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索文件名、SPU、标签、备注（支持中/英/泰）..."
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pr-3 pl-8 text-xs focus:border-blue-500 focus:bg-white focus:outline-none"
                />
              </div>

              <select
                value={sort}
                onChange={(e) =>
                  setSort(e.target.value as "newest" | "oldest" | "name_asc" | "size_desc")
                }
                className="shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="newest">最新上传</option>
                <option value="oldest">最早上传</option>
                <option value="name_asc">名称 A-Z</option>
                <option value="size_desc">体积从大到小</option>
              </select>

              <div className="flex shrink-0 items-center rounded-lg border border-gray-200 p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`rounded p-1 ${
                    viewMode === "grid"
                      ? "bg-blue-50 text-blue-600"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                  title="网格视图"
                  aria-label="网格视图"
                >
                  <Grid className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`rounded p-1 ${
                    viewMode === "list"
                      ? "bg-blue-50 text-blue-600"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                  title="列表视图"
                  aria-label="列表视图"
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={productId}
                onChange={(e) => {
                  const nextVal = e.target.value;
                  setProductId(nextVal);
                  const nextParams = new URLSearchParams(searchParams);
                  if (nextVal) nextParams.set("productId", nextVal);
                  else nextParams.delete("productId");
                  setSearchParams(nextParams, { replace: true });
                }}
                className="max-w-[132px] rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="">全部商品</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.spu} · {p.nameZh}
                  </option>
                ))}
              </select>

              {stores.length > 0 && (
                <select
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                  className="max-w-[122px] rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">全部店铺</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.market})
                    </option>
                  ))}
                </select>
              )}

              <select
                value={assetType}
                onChange={(e) => setAssetType(e.target.value as AssetType | "")}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="">全部类型</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
                <option value="document">文档</option>
                <option value="archive">压缩包</option>
                <option value="other">其他</option>
              </select>

              <select
                value={quickView === "pending" ? "pending" : reviewStatus}
                onChange={(e) => {
                  const nextReview = e.target.value as ReviewStatus | "";
                  setQuickView(nextReview === "pending" ? "pending" : "all");
                  setReviewStatus(nextReview);
                  const nextParams = new URLSearchParams(searchParams);
                  if (nextReview) nextParams.set("reviewStatus", nextReview);
                  else nextParams.delete("reviewStatus");
                  setSearchParams(nextParams, { replace: true });
                }}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="">全部审核态</option>
                <option value="pending">待审核</option>
                <option value="approved">已通过</option>
                <option value="rejected">已拒绝</option>
              </select>

              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="ml-auto inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>重置筛选</span>
                </button>
              )}
            </div>
          </div>

          {/* Batch Action Bar */}
          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs">
              <button
                type="button"
                onClick={toggleSelectAll}
                className="font-medium text-blue-700 hover:underline"
              >
                已选 {selectedIds.size} / {items.length}
              </button>
              <span className="text-blue-300">|</span>

              <div className="flex items-center gap-1">
                <select
                  value={batchFolderId}
                  onChange={(e) => setBatchFolderId(e.target.value)}
                  className="rounded border border-blue-200 bg-white px-2 py-1 text-[11px]"
                >
                  <option value="">移至未归类</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={batchBusy}
                  onClick={() =>
                    void runBatch("move_folder", { folderId: batchFolderId || null })
                  }
                  className="rounded border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                >
                  移动文件夹
                </button>
              </div>

              <div className="flex items-center gap-1">
                <select
                  value={batchTagId}
                  onChange={(e) => setBatchTagId(e.target.value)}
                  className="rounded border border-blue-200 bg-white px-2 py-1 text-[11px]"
                >
                  <option value="">选择标签...</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      [{TAG_DIMENSION_LABELS[t.dimension]}] {t.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={batchBusy || !batchTagId}
                  onClick={() => void runBatch("add_tags", { tagIds: [batchTagId] })}
                  className="rounded border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                >
                  打标签
                </button>
              </div>

              <div className="flex items-center gap-1">
                <select
                  value={batchProductId}
                  onChange={(e) => setBatchProductId(e.target.value)}
                  className="max-w-[140px] rounded border border-blue-200 bg-white px-2 py-1 text-[11px]"
                >
                  <option value="">选择商品...</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.spu}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={batchBusy || !batchProductId}
                  onClick={() =>
                    void runBatch("link_products", { productIds: [batchProductId] })
                  }
                  className="rounded border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                >
                  关联商品
                </button>
              </div>

              <button
                type="button"
                disabled={batchBusy}
                onClick={() =>
                  void runBatch("set_review_status", { reviewStatus: "approved" })
                }
                className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
              >
                批量通过
              </button>
              <button
                type="button"
                disabled={batchBusy}
                onClick={() => void runBatch("soft_delete")}
                className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
              >
                移入回收站
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="ml-auto text-[11px] text-gray-500 hover:text-gray-800"
              >
                取消选择
              </button>
            </div>
          )}

          {/* Virtualized Asset Canvas */}
          <div ref={scrollParentRef} className="flex-1 overflow-y-auto p-3">
            {loading && items.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-gray-400">
                正在加载素材库...
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-8 text-center">
                <Upload className="h-9 w-9 text-gray-300" />
                <p className="mt-2 text-sm font-medium text-gray-700">当前条件下暂无素材</p>
                <p className="mt-1 text-xs text-gray-400">
                  可直接拖拽文件到此区域上传，或点击右上角「上传素材」按钮
                </p>
              </div>
            ) : (
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative"
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  if (viewMode === "list") {
                    const item = items[virtualRow.index];
                    if (!item) return null;
                    const isSelected = selectedIds.has(item.id);
                    const isActive = activeAssetId === item.id;
                    const reviewMeta = REVIEW_STATUS_META[item.reviewStatus];
                    return (
                      <div
                        key={item.id}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`
                        }}
                        className="pb-1.5"
                      >
                        <div
                          onClick={() => setActiveAssetId(item.id)}
                          onDoubleClick={() => setLightboxIndex(virtualRow.index)}
                          className={`flex h-full cursor-pointer items-center gap-3 rounded-lg border px-2.5 text-xs transition-colors ${
                            isActive
                              ? "border-blue-500 bg-blue-50/40"
                              : "border-gray-200 bg-white hover:border-gray-300"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSelect(item.id);
                            }}
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              isSelected
                                ? "border-blue-600 bg-blue-600 text-white"
                                : "border-gray-300 bg-white"
                            }`}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                          </button>

                          <div className="h-9 w-9 shrink-0 overflow-hidden rounded border border-gray-200 bg-gray-100">
                            {item.thumbStatus === "ready" || item.assetType === "image" ? (
                              <img
                                src={api.thumbnailUrl(
                                  item.id,
                                  item.currentVersionId,
                                  thumbBustMap[item.currentVersionId]
                                )}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center">
                                {renderAssetIcon(item)}
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-gray-900">{item.name}</div>
                            <div className="font-mono-tabular truncate text-[10px] text-gray-400">
                              {item.originalFilename}
                            </div>
                          </div>

                          <div className="font-mono-tabular hidden w-24 text-right text-[11px] text-gray-500 sm:block">
                            {item.width && item.height ? `${item.width}×${item.height}` : "—"}
                          </div>
                          <div className="font-mono-tabular w-16 text-right text-[11px] text-gray-500">
                            {formatBytes(item.sizeBytes)}
                          </div>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewMeta.className}`}
                          >
                            {reviewMeta.label}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleFavorite(item);
                            }}
                            className={`p-1 ${
                              item.isFavorite
                                ? "text-amber-500"
                                : "text-gray-300 hover:text-amber-500"
                            }`}
                          >
                            <Star className="h-3.5 w-3.5 fill-current" />
                          </button>
                        </div>
                      </div>
                    );
                  }

                  // Grid row
                  const startIdx = virtualRow.index * gridColumns;
                  const rowItems = items.slice(startIdx, startIdx + gridColumns);
                  return (
                    <div
                      key={virtualRow.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                        display: "grid",
                        gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                        gap: "10px",
                        paddingBottom: "10px"
                      }}
                    >
                      {rowItems.map((item, offset) => {
                        const itemIndex = startIdx + offset;
                        const isSelected = selectedIds.has(item.id);
                        const isActive = activeAssetId === item.id;
                        const reviewMeta = REVIEW_STATUS_META[item.reviewStatus];
                        return (
                          <div
                            key={item.id}
                            onClick={() => setActiveAssetId(item.id)}
                            onDoubleClick={() => setLightboxIndex(itemIndex)}
                            className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-white transition-all ${
                              isActive
                                ? "border-blue-600 ring-2 ring-blue-500/20"
                                : isSelected
                                  ? "border-blue-400"
                                  : "border-gray-200 hover:border-gray-300"
                            }`}
                          >
                            <div className="relative h-36 w-full overflow-hidden bg-gray-100">
                              {item.thumbStatus === "ready" || item.assetType === "image" ? (
                                <img
                                  src={api.thumbnailUrl(
                                    item.id,
                                    item.currentVersionId,
                                    thumbBustMap[item.currentVersionId]
                                  )}
                                  alt={item.name}
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full w-full flex-col items-center justify-center gap-1">
                                  {renderAssetIcon(item)}
                                  <span className="font-mono-tabular text-[10px] uppercase text-gray-400">
                                    {item.ext || item.assetType}
                                  </span>
                                </div>
                              )}

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleSelect(item.id);
                                }}
                                className={`absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded border transition-opacity ${
                                  isSelected
                                    ? "border-blue-600 bg-blue-600 text-white opacity-100"
                                    : "border-gray-300 bg-white/90 text-transparent opacity-0 group-hover:opacity-100"
                                }`}
                              >
                                <Check className="h-3 w-3" />
                              </button>

                              <span
                                className={`absolute top-2 right-2 rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewMeta.className}`}
                              >
                                {reviewMeta.label}
                              </span>

                              <div className="absolute right-2 bottom-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleToggleFavorite(item);
                                  }}
                                  className={`rounded-md bg-black/55 p-1 ${
                                    item.isFavorite ? "text-amber-400" : "text-white"
                                  }`}
                                  title="收藏"
                                >
                                  <Star className="h-3 w-3 fill-current" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLightboxIndex(itemIndex);
                                  }}
                                  className="rounded-md bg-black/55 p-1 text-white"
                                  title="预览"
                                >
                                  <Maximize2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>

                            <div className="flex flex-1 flex-col justify-between p-2 text-xs">
                              <div
                                className="truncate font-medium text-gray-900"
                                title={item.name}
                              >
                                {item.name}
                              </div>
                              <div className="font-mono-tabular flex items-center justify-between text-[10px] text-gray-400">
                                <span>
                                  {item.width && item.height
                                    ? `${item.width}×${item.height}`
                                    : item.assetType}
                                </span>
                                <span>{formatBytes(item.sizeBytes)}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Inspector Panel (desktop docked + <xl slide-over drawer) */}
        <aside
          className={
            activeAssetId
              ? "fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-gray-200 bg-white shadow-2xl xl:static xl:z-auto xl:w-80 xl:max-w-none xl:shrink-0 xl:shadow-none"
              : "hidden w-80 shrink-0 flex-col border-l border-gray-200 bg-white xl:flex"
          }
        >
          {!activeAssetId ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-xs text-gray-400">
              <Tag className="h-8 w-8 text-gray-300" />
              <p className="mt-2 font-medium text-gray-600">未选中素材</p>
              <p className="mt-1">单击任意素材查看详情、编辑元数据、标签或关联商品</p>
            </div>
          ) : inspectorLoading && !activeAsset ? (
            <div className="flex flex-1 items-center justify-center text-xs text-gray-400">
              正在加载素材详情...
            </div>
          ) : activeAsset ? (
            <div className="flex h-full min-h-0 flex-col text-xs">
              <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3">
                <span className="font-semibold text-gray-900">素材详情</span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveAssetId(null);
                    setActiveAsset(null);
                  }}
                  aria-label="关闭素材详情"
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div
                className="relative aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
                onClick={() => {
                  const idx = items.findIndex((i) => i.id === activeAsset.id);
                  if (idx >= 0) setLightboxIndex(idx);
                }}
              >
                {activeAsset.thumbStatus === "ready" || activeAsset.assetType === "image" ? (
                  <img
                    src={api.thumbnailUrl(
                      activeAsset.id,
                      activeAsset.currentVersionId,
                      thumbBustMap[activeAsset.currentVersionId]
                    )}
                    alt={activeAsset.name}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1">
                    {renderAssetIcon(activeAsset)}
                    <span className="font-mono-tabular text-[11px] uppercase text-gray-400">
                      {activeAsset.ext || activeAsset.assetType}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <a
                  href={api.contentUrl(activeAsset.id, activeAsset.currentVersionId)}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>下载原文件</span>
                </a>
                {activeAsset.assetType === "image" && (
                  <button
                    type="button"
                    disabled={regenBusy}
                    onClick={() => void handleRegenerateThumb()}
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    title="重新生成缩略图"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${regenBusy ? "animate-spin" : ""}`} />
                    <span>重建缩略图</span>
                  </button>
                )}
              </div>

              <div className="space-y-1.5 rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-[11px]">
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500">原文件名</span>
                  <span className="font-mono-tabular truncate text-gray-800" title={activeAsset.originalFilename}>
                    {activeAsset.originalFilename}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500">尺寸 / 体积</span>
                  <span className="font-mono-tabular text-gray-800">
                    {activeAsset.width && activeAsset.height
                      ? `${activeAsset.width}×${activeAsset.height} · `
                      : ""}
                    {formatBytes(activeAsset.sizeBytes)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500">MIME / 版本</span>
                  <span className="font-mono-tabular text-gray-800">
                    {activeAsset.mimeType} · V{activeAsset.versionNo}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-500">存储位置</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono-tabular text-gray-800">{activeAsset.storageId}</span>
                    <StorageStatusBadge status={activeAsset.storageStatus} />
                  </div>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500">SHA-256</span>
                  <span className="font-mono-tabular text-gray-600">
                    {activeAsset.sha256.slice(0, 14)}…
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500">上传时间</span>
                  <span className="font-mono-tabular text-gray-600">
                    {formatDateTime(activeAsset.createdAt)}
                  </span>
                </div>
              </div>

              {/* Version History & Append New Version */}
              <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-semibold text-gray-900">
                    <History className="h-3.5 w-3.5 text-blue-600" />
                    <span>版本历史 ({activeAsset.versions.length})</span>
                  </span>
                  <button
                    type="button"
                    disabled={versionUploading}
                    onClick={() => setVersionFormOpen((prev) => !prev)}
                    className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                  >
                    <Upload className="h-3 w-3" />
                    <span>{versionFormOpen ? "收起" : "上传新版本"}</span>
                  </button>
                </div>

                {versionFormOpen && (
                  <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50/40 p-2.5 text-[11px]">
                    <p className="text-gray-600">
                      追加为 V{activeAsset.versions.length + 1}，不覆盖旧版本与已锁定的商品母图。
                    </p>
                    <FileDropButton
                      disabled={versionUploading}
                      onFiles={(files) => {
                        if (versionUploadInFlight.current) return;
                        if (files.length > 1) {
                          setVersionFileError("每次只能上传一个版本文件，请重新选择或拖入单个文件。");
                          return;
                        }
                        setVersionFile(files[0] ?? null);
                        setVersionFileError(null);
                      }}
                      className="flex items-center justify-center gap-1.5 px-2 py-2 font-medium"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      <span>拖入单个文件，或点击选择</span>
                    </FileDropButton>
                    {versionFile && (
                      <p className="break-all text-gray-700">已选择：{versionFile.name}</p>
                    )}
                    {versionFileError && (
                      <p role="alert" className="text-rose-700">{versionFileError}</p>
                    )}
                    <input
                      type="text"
                      disabled={versionUploading}
                      value={versionChangeNote}
                      onChange={(e) => setVersionChangeNote(e.target.value)}
                      placeholder="变更说明（如：调整高光、修复文字）"
                      className="w-full rounded border border-gray-200 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none"
                    />
                    <textarea
                      rows={2}
                      disabled={versionUploading}
                      value={versionPromptText}
                      onChange={(e) => setVersionPromptText(e.target.value)}
                      placeholder="提示词 / 生成参数（可选）"
                      className="w-full rounded border border-gray-200 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none"
                    />
                    <label className="flex cursor-pointer items-center gap-1.5 text-gray-700">
                      <input
                        type="checkbox"
                        disabled={versionUploading}
                        checked={versionSetCurrent}
                        onChange={(e) => setVersionSetCurrent(e.target.checked)}
                        className="rounded border-gray-300"
                      />
                      <span>上传后设为当前展示版本</span>
                    </label>
                    <button
                      type="button"
                      disabled={!versionFile || !!versionFileError || versionUploading}
                      onClick={() => void handleAppendVersion()}
                      className="w-full rounded-lg bg-blue-600 px-2.5 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {versionUploading ? "正在上传新版本..." : "提交新版本"}
                    </button>
                  </div>
                )}

                <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
                  {activeAsset.versions.map((ver) => {
                    const isCurrent = ver.id === activeAsset.currentVersionId;
                    const verReview = REVIEW_STATUS_META[ver.reviewStatus];
                    const isReviewOpen = reviewingVersionId === ver.id;
                    const busy = versionActionBusyId === ver.id;
                    return (
                      <div
                        key={ver.id}
                        className={`rounded-lg border p-2 text-[11px] ${
                          isCurrent ? "border-blue-300 bg-blue-50/30" : "border-gray-100 bg-gray-50/70"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="font-mono-tabular font-semibold text-gray-900">
                              V{ver.versionNo}
                            </span>
                            {isCurrent && (
                              <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                                当前
                              </span>
                            )}
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${verReview.className}`}
                            >
                              {verReview.label}
                            </span>
                          </div>
                          <span className="font-mono-tabular text-[10px] text-gray-400">
                            {formatBytes(ver.sizeBytes)}
                          </span>
                        </div>

                        {ver.lockedMasterProducts && ver.lockedMasterProducts.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {ver.lockedMasterProducts.map((mp) => (
                              <span
                                key={mp.masterImageId}
                                className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                              >
                                <Lock className="h-2.5 w-2.5" />
                                母图 {mp.spu}·{mp.angle}
                              </span>
                            ))}
                          </div>
                        )}

                        {ver.changeNote && (
                          <p className="mt-1 text-gray-700">说明：{ver.changeNote}</p>
                        )}
                        {ver.reviewNote && (
                          <p className="mt-0.5 text-gray-500">审核意见：{ver.reviewNote}</p>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-gray-200/70 pt-2">
                          {!isCurrent && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleSwitchVersion(ver.id, ver.versionNo)}
                              className="rounded border border-blue-200 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-50"
                            >
                              设为当前
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (isReviewOpen) {
                                setReviewingVersionId(null);
                              } else {
                                setReviewingVersionId(ver.id);
                                setVersionReviewNote(ver.reviewNote || "");
                              }
                            }}
                            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-100"
                          >
                            {isReviewOpen ? "取消审核" : "独立审核"}
                          </button>
                          <a
                            href={api.contentUrl(activeAsset.id, ver.id)}
                            className="ml-auto rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
                          >
                            下载
                          </a>
                        </div>

                        {isReviewOpen && (
                          <div className="mt-2 space-y-1.5 border-t border-gray-200 pt-2">
                            <input
                              type="text"
                              value={versionReviewNote}
                              onChange={(e) => setVersionReviewNote(e.target.value)}
                              placeholder="输入本版本审核意见（可选）"
                              className="w-full rounded border border-gray-200 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none"
                            />
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleReviewVersion(ver.id, "approved")}
                                className="flex-1 rounded bg-emerald-600 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                通过
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleReviewVersion(ver.id, "rejected")}
                                className="flex-1 rounded bg-rose-600 py-1 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                              >
                                拒绝
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleReviewVersion(ver.id, "pending")}
                                className="flex-1 rounded border border-gray-200 bg-white py-1 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                              >
                                待审
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2.5">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">显示名称</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block font-medium text-gray-700">用途</label>
                    <select
                      value={editPurpose}
                      onChange={(e) => setEditPurpose(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 focus:border-blue-500 focus:outline-none"
                    >
                      {ASSET_PURPOSES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-gray-700">文件夹</label>
                    <select
                      value={editFolderId}
                      onChange={(e) => setEditFolderId(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">未归类</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-gray-700">来源说明</label>
                  <input
                    type="text"
                    value={editSource}
                    onChange={(e) => setEditSource(e.target.value)}
                    placeholder="如：摄影棚实拍 / Midjourney"
                    className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-medium text-gray-700">备注</label>
                  <textarea
                    rows={2}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-medium text-gray-700">关联标签</label>
                  <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
                    {tags.map((tag) => {
                      const checked = editTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() =>
                            setEditTagIds((prev) =>
                              checked ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]
                            )
                          }
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${
                            checked
                              ? "border-blue-500 bg-blue-50 font-medium text-blue-700"
                              : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                          }`}
                        >
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-gray-700">关联商品</label>
                  <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
                    {products.length === 0 ? (
                      <p className="text-[11px] text-gray-400">暂无商品</p>
                    ) : (
                      products.map((prod) => {
                        const checked = editProductIds.includes(prod.id);
                        return (
                          <label
                            key={prod.id}
                            className="flex cursor-pointer items-center gap-2 text-[11px] text-gray-700"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setEditProductIds((prev) =>
                                  checked
                                    ? prev.filter((id) => id !== prod.id)
                                    : [...prev, prod.id]
                                )
                              }
                              className="rounded border-gray-300"
                            />
                            <span className="font-mono-tabular text-gray-500">{prod.spu}</span>
                            <span className="truncate">{prod.nameZh}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

              </div>
              </div>

              <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 bg-white px-4 py-3">
                <button
                  type="button"
                  disabled={savingInspector}
                  onClick={() => void handleSaveInspector()}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>{savingInspector ? "保存中..." : "保存元数据"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSoftDeleteSingle(activeAsset)}
                  className="rounded-lg border border-rose-200 p-2 text-rose-600 transition-colors hover:bg-rose-50"
                  title="移入回收站"
                  aria-label="移入回收站"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
        </aside>
        {activeAssetId && (
          <div
            className="fixed inset-0 z-30 bg-gray-900/35 backdrop-blur-[1px] xl:hidden"
            onClick={() => {
              setActiveAssetId(null);
              setActiveAsset(null);
            }}
          />
        )}
      </div>

      {/* Upload Modal */}
      {uploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-gray-900">批量上传素材</h2>
              <button
                type="button"
                disabled={uploading}
                onClick={() => setUploadModalOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3.5 p-5 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">关联商品（选填）</label>
                  <select
                    disabled={uploading}
                    value={uploadTargetProductId}
                    onChange={(e) => setUploadTargetProductId(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">暂不关联商品</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.spu} · {p.nameZh}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">目标文件夹</label>
                  <select
                    disabled={uploading}
                    value={uploadTargetFolderId}
                    onChange={(e) => setUploadTargetFolderId(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">未归类</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">默认用途</label>
                  <select
                    disabled={uploading}
                    value={uploadTargetPurpose}
                    onChange={(e) => setUploadTargetPurpose(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    {ASSET_PURPOSES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">目标存储空间</label>
                  <select
                    disabled={uploading}
                    value={uploadTargetStorageId}
                    onChange={(e) => setUploadTargetStorageId(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">使用系统默认存储</option>
                    {storages
                      .filter((s) => s.enabled)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.type.toUpperCase()})
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div>
                <FileDropButton
                  multiple
                  disabled={uploading}
                  onFiles={(files) => {
                    if (uploadInFlight.current) return;
                    setUploadPendingFiles(files);
                    setUploadModalError(null);
                  }}
                  className="flex flex-col items-center justify-center px-4 py-6"
                >
                  <Upload className="h-6 w-6 text-gray-400" />
                  <span className="mt-1.5 font-medium text-gray-700">拖入文件，或点击选择</span>
                  <span className="mt-0.5 text-[11px] text-gray-400">
                    支持多文件批量上传，相同底层文件自动基于 SHA-256 去重
                  </span>
                </FileDropButton>
                {uploadModalError && (
                  <p role="alert" className="mt-2 text-rose-700">{uploadModalError}</p>
                )}
                {uploadPendingFiles.length > 0 && (
                  <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
                    {uploadPendingFiles.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        className="flex items-center justify-between text-[11px]"
                      >
                        <span className="truncate text-gray-800">{file.name}</span>
                        <span className="font-mono-tabular shrink-0 text-gray-400">
                          {formatBytes(file.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => setUploadModalOpen(false)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={uploading || uploadPendingFiles.length === 0}
                  onClick={() =>
                    void performUpload(uploadPendingFiles, {
                      productId: uploadTargetProductId || undefined,
                      folderId: uploadTargetFolderId || undefined,
                      purpose: uploadTargetPurpose || undefined,
                      storageId: uploadTargetStorageId || undefined
                    })
                  }
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {uploading
                    ? "上传中..."
                    : `开始上传 (${uploadPendingFiles.length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {lightboxIndex !== null && items[lightboxIndex] && (
        <AssetLightbox
          items={items}
          currentIndex={lightboxIndex}
          onChangeIndex={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      <ConfirmDialog
        dialog={confirmDialog}
        busy={confirmBusy}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}
