import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Download,
  FileArchive,
  FileText,
  Film,
  Folder,
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
  AssetSetKind,
  AssetType,
  FolderRecord,
  ProductSummary,
  StorageProviderSummary,
  StoreRecord,
  TagDimension,
  TagRecord
} from "../../shared/types";
import { api, ApiClientError, isAbortError } from "../api/client";
import { LatestRequestController } from "../utils/asyncControl";
import { AssetLightbox } from "../components/AssetLightbox";
import { BatchAssetUpload, type DirectAssetUploadRequest, type PreparedUploadOptions } from "../components/BatchAssetUpload";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { useFileDrop } from "../components/FileDropButton";
import { FolderTreeSidebar } from "../components/FolderTreeSidebar";
import { ImageCompressionSwitch } from "../components/ImageCompressionSwitch";
import { StorageStatusBadge } from "../components/StatusBadge";
import {
  buildFolderTree,
  formatFolderSelectOption,
  getFolderBreadcrumb,
  getFolderSubtreeIdSet,
  type FolderTreeNode
} from "../utils/folderTree";
import {
  ASSET_PURPOSES,
  formatBytes,
  formatDateTime,
  formatUploadCompression,
  TAG_DIMENSION_LABELS
} from "../utils/format";

type QuickView = "all" | "favorite" | "unfiled";

const ASSET_GROUP_LABELS: Record<AssetSetKind, string> = {
  carousel: "轮播图组",
  detail: "详情图组",
  sku: "SKU 图组",
  video: "视频组"
};

const DIMENSION_ORDER: TagDimension[] = [
  "market",
  "platform",
  "purpose",
  "scene",
  "color",
  "custom"
];

export function AssetsPage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const skipNextUrlSyncRef = useRef(false);

  // Taxonomy & reference lists
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [storages, setStorages] = useState<StorageProviderSummary[]>([]);
  const [stores, setStores] = useState<StoreRecord[]>([]);

  const initialQuickViewParam = searchParams.get("quickView");
  const initialFolderId = searchParams.get("folderId") || "";
  const initialQuickView: QuickView =
    !initialFolderId &&
    (initialQuickViewParam === "favorite" || initialQuickViewParam === "unfiled")
      ? initialQuickViewParam
      : "all";

  // Filter state
  const [quickView, setQuickView] = useState<QuickView>(initialQuickView);
  const [folderId, setFolderId] = useState<string>(initialFolderId);
  const [includeSubfolders, setIncludeSubfolders] = useState<boolean>(true);
  const [tagId, setTagId] = useState<string>(searchParams.get("tagId") || "");
  const [storageId, setStorageId] = useState<string>("");
  const [productId, setProductId] = useState<string>(searchParams.get("productId") || "");
  const [storeId, setStoreId] = useState<string>(searchParams.get("storeId") || "");
  const [assetType, setAssetType] = useState<AssetType | "">("");
  const [query, setQuery] = useState(searchParams.get("q") || "");
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
  const [activeAssetId, setActiveAssetId] = useState<string | null>(
    searchParams.get("assetId") || null
  );
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

  // Version upload
  const [versionFormOpen, setVersionFormOpen] = useState(false);
  const [versionChangeNote, setVersionChangeNote] = useState("");
  const [versionPromptText, setVersionPromptText] = useState("");
  const [versionSetCurrent, setVersionSetCurrent] = useState(true);
  const [compressVersionImage, setCompressVersionImage] = useState(true);
  const [versionUploading, setVersionUploading] = useState(false);
  const [versionActionBusyId, setVersionActionBusyId] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [compressUploadImages, setCompressUploadImages] = useState(true);
  const [exportingStandard, setExportingStandard] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadTargetProductId, setUploadTargetProductId] = useState("");
  const [uploadTargetFolderId, setUploadTargetFolderId] = useState("");
  const [uploadTargetPurpose, setUploadTargetPurpose] = useState("raw");
  const [uploadTargetStorageId, setUploadTargetStorageId] = useState("");
  const [canvasUpload, setCanvasUpload] = useState<DirectAssetUploadRequest | null>(null);

  // Inline tag creation
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

  const [taxonomyReq] = useState(() => new LatestRequestController());
  const [assetsReq] = useState(() => new LatestRequestController());
  const [activeAssetReq] = useState(() => new LatestRequestController());

  const loadTaxonomy = useCallback(async () => {
    const req = taxonomyReq.next();
    try {
      const [folderRes, tagRes, productRes, storageRes, storeRes] = await Promise.allSettled([
        api.listFolders({ signal: req.signal }),
        api.listTags(undefined, { signal: req.signal }),
        api.listProducts({ page: 1, pageSize: 100 }, { signal: req.signal }),
        api.getStorageProviders({ signal: req.signal }),
        api.listStores({}, { signal: req.signal })
      ]);
      if (!taxonomyReq.isCurrent(req.id)) return;

      const failures: string[] = [];
      if (folderRes.status === "fulfilled") setFolders(folderRes.value.items);
      else if (!isAbortError(folderRes.reason)) failures.push("文件夹");
      if (tagRes.status === "fulfilled") setTags(tagRes.value.items);
      else if (!isAbortError(tagRes.reason)) failures.push("标签");
      if (productRes.status === "fulfilled") setProducts(productRes.value.items);
      else if (!isAbortError(productRes.reason)) failures.push("商品");
      if (storageRes.status === "fulfilled") setStorages(storageRes.value.items);
      else if (!isAbortError(storageRes.reason)) failures.push("存储位置");
      if (storeRes.status === "fulfilled") setStores(storeRes.value.items);
      else if (!isAbortError(storeRes.reason)) failures.push("店铺");

      if (failures.length > 0) {
        setError(`部分筛选项加载失败：${failures.join("、")}`);
      }
    } finally {
      taxonomyReq.finish(req.id);
    }
  }, [taxonomyReq]);

  useEffect(() => {
    void loadTaxonomy();
    return () => {
      taxonomyReq.abort();
    };
  }, [loadTaxonomy, taxonomyReq]);

  const loadAssets = useCallback(async () => {
    const req = assetsReq.next();
    setLoading(true);
    setError(null);
    try {
      const res = await api.listAssets(
        {
          q: query.trim() || undefined,
          productId: productId || undefined,
          storeId: storeId || undefined,
          tagId: tagId || undefined,
          folderId: folderId || undefined,
          includeSubfolders: folderId ? includeSubfolders : undefined,
          storageId: storageId || undefined,
          type: assetType || undefined,
          favorite: quickView === "favorite" ? true : undefined,
          unfiled: quickView === "unfiled" ? true : undefined,
          sort,
          page: 1,
          pageSize: 200
        },
        { signal: req.signal }
      );
      if (!assetsReq.isCurrent(req.id)) return;
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
      if (!assetsReq.isCurrent(req.id) || isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "加载素材列表失败");
    } finally {
      assetsReq.finish(req.id);
      if (assetsReq.isCurrent(req.id)) {
        setLoading(false);
      }
    }
  }, [
    assetsReq,
    query,
    productId,
    storeId,
    tagId,
    folderId,
    includeSubfolders,
    storageId,
    assetType,
    quickView,
    sort
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAssets();
    }, 150);
    return () => {
      window.clearTimeout(timer);
      assetsReq.abort();
    };
  }, [assetsReq, loadAssets]);

  const syncInspectorFields = (detail: AssetDetail) => {
    setEditName(detail.name);
    setEditPurpose(detail.purpose || "other");
    setEditFolderId(detail.folderId || "");
    setEditSource(detail.source || "");
    setEditNotes(detail.notes || "");
    setEditTagIds(detail.tags.map((t) => t.id));
    setEditProductIds(detail.products.map((p) => p.id));
  };

  const loadActiveAsset = useCallback(
    async (assetId: string) => {
      const req = activeAssetReq.next();
      setInspectorLoading(true);
      try {
        const detail = await api.getAsset(assetId, { signal: req.signal });
        if (!activeAssetReq.isCurrent(req.id)) return;
        setActiveAsset(detail);
        syncInspectorFields(detail);
      } catch (err) {
        if (!activeAssetReq.isCurrent(req.id) || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : "加载素材详情失败");
      } finally {
        activeAssetReq.finish(req.id);
        if (activeAssetReq.isCurrent(req.id)) {
          setInspectorLoading(false);
        }
      }
    },
    [activeAssetReq]
  );

  useEffect(() => {
    if (!activeAssetId) {
      activeAssetReq.abort();
      setInspectorLoading(false);
      setActiveAsset(null);
      return;
    }
    setVersionFormOpen(false);
    setVersionChangeNote("");
    setVersionPromptText("");
    setVersionSetCurrent(true);
    void loadActiveAsset(activeAssetId);
    return () => {
      activeAssetReq.abort();
    };
  }, [activeAssetId, activeAssetReq, loadActiveAsset]);

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
      query.trim()
  );

  useEffect(() => {
    if (skipNextUrlSyncRef.current) {
      skipNextUrlSyncRef.current = false;
      return;
    }

    const urlAction = searchParams.get("action");
    const urlQuickView = searchParams.get("quickView");
    const urlFolderId = searchParams.get("folderId") || "";
    const urlProductId = searchParams.get("productId") || "";
    const urlStoreId = searchParams.get("storeId") || "";
    const urlTagId = searchParams.get("tagId") || "";
    const urlQ = searchParams.get("q") || "";
    const urlAssetId = searchParams.get("assetId") || "";

    const hasOtherParams = Boolean(
      urlQuickView !== null ||
        searchParams.has("folderId") ||
        searchParams.has("productId") ||
        searchParams.has("storeId") ||
        searchParams.has("tagId") ||
        searchParams.has("q") ||
        searchParams.has("assetId")
    );

    if (urlAction === "upload") {
      setUploadTargetProductId(urlProductId || productId);
      setUploadTargetFolderId(urlFolderId || folderId);
      setUploadTargetStorageId(storageId);
      setUploadModalOpen(true);

      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("action");
      skipNextUrlSyncRef.current = true;
      setSearchParams(nextParams, { replace: true });

      if (!hasOtherParams) {
        return;
      }
    }

    if (urlFolderId) {
      setFolderId(urlFolderId);
      setQuickView("all");
    } else {
      setFolderId("");
      setQuickView(
        urlQuickView === "favorite" || urlQuickView === "unfiled" ? urlQuickView : "all"
      );
    }
    setProductId(urlProductId);
    setStoreId(urlStoreId);
    setTagId(urlTagId);
    setQuery(urlQ);
    if (urlAssetId) {
      setActiveAssetId(urlAssetId);
    }
  }, [searchParams, location.key, setSearchParams]);

  const resetAllFilters = () => {
    setQuickView("all");
    setFolderId("");
    setIncludeSubfolders(true);
    setTagId("");
    setStorageId("");
    setProductId("");
    setStoreId("");
    setAssetType("");
    setQuery("");
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("productId");
    nextParams.delete("quickView");
    nextParams.delete("folderId");
    nextParams.delete("storeId");
    nextParams.delete("tagId");
    nextParams.delete("q");
    nextParams.delete("assetId");
    skipNextUrlSyncRef.current = true;
    setSearchParams(nextParams, { replace: true });
  };

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  const selectedFolderNode = useMemo(
    () => (folderId ? folderTree.nodeMap.get(folderId) ?? null : null),
    [folderId, folderTree.nodeMap]
  );

  const folderBreadcrumb = useMemo(
    () => (folderId ? getFolderBreadcrumb(folderTree.nodeMap, folderId) : []),
    [folderId, folderTree.nodeMap]
  );

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

  const toggleVersionForm = () => {
    if (versionUploading) return;
    setVersionFormOpen((prev) => !prev);
  };

  const performUpload = async (
    files: File[],
    options: Parameters<typeof api.uploadAssets>[1],
    closeModal = false
  ) => {
    setError(null);
    setNotice(null);
    const res = await api.uploadAssets(files, options);
    setNotice(
      `成功上传 ${res.uploadedCount} 个素材${
        res.deduplicatedCount > 0 ? `（${res.deduplicatedCount} 个命中内容去重）` : ""
      }${formatUploadCompression(res.compression)}`
    );
    if (closeModal) setUploadModalOpen(false);
    await Promise.all([loadAssets(), loadTaxonomy()]);
    if (res.items[0]) setActiveAssetId(res.items[0].id);
  };

  const { draggingOver, dropProps: workspaceDropProps } = useFileDrop((files) => {
    setCanvasUpload((current) => current ?? {
      files,
      options: {
        compressImages: compressUploadImages,
        productId: productId || undefined,
        folderId: folderId || undefined,
        storageId: storageId || undefined
      }
    });
  }, uploading || !!canvasUpload || uploadModalOpen);

  const handleCreateFolder = async (payload: {
    name: string;
    parentId: string | null;
  }): Promise<FolderRecord | null> => {
    const trimmed = payload.name.trim();
    if (!trimmed) return null;
    setError(null);
    try {
      const created = await api.createFolder({
        name: trimmed,
        parentId: payload.parentId
      });
      await loadTaxonomy();
      return created;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "新建文件夹失败");
      return null;
    }
  };

  const handleUpdateFolder = async (
    id: string,
    payload: { name?: string; parentId?: string | null }
  ): Promise<boolean> => {
    setError(null);
    try {
      await api.updateFolder(id, payload);
      await Promise.all([loadTaxonomy(), loadAssets()]);
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "更新文件夹失败");
      return false;
    }
  };

  const handleDeleteFolder = (node: FolderTreeNode) => {
    const { folder, descendantFolderCount, totalAssetCount, pathLabel } = node;
    const hasSubfolders = descendantFolderCount > 0;
    const description = hasSubfolders
      ? `确定删除文件夹「${pathLabel}」及其下 ${descendantFolderCount} 个子文件夹吗？其中${
          totalAssetCount > 0 ? `的 ${totalAssetCount} 个` : ""
        }素材不会被删除，将自动变为未归类。`
      : `确定删除文件夹「${pathLabel}」吗？其中素材不会被删除，将自动变为未归类。`;

    setConfirmDialog({
      title: hasSubfolders ? "删除文件夹及子目录" : "删除文件夹",
      description,
      confirmLabel: hasSubfolders ? "全部删除" : "删除文件夹",
      tone: "warning",
      onConfirm: async () => {
        setConfirmBusy(true);
        setError(null);
        try {
          const deletedSet = getFolderSubtreeIdSet(folderTree.nodeMap, folder.id);
          deletedSet.add(folder.id);
          await api.deleteFolder(folder.id, { recursive: hasSubfolders });
          if (folderId && deletedSet.has(folderId)) {
            setFolderId(folder.parentId && !deletedSet.has(folder.parentId) ? folder.parentId : "");
          }
          if (batchFolderId && deletedSet.has(batchFolderId)) setBatchFolderId("");
          if (editFolderId && deletedSet.has(editFolderId)) setEditFolderId("");
          if (uploadTargetFolderId && deletedSet.has(uploadTargetFolderId)) {
            setUploadTargetFolderId("");
          }
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

  const handleAppendVersion = async ([file]: File[], options: PreparedUploadOptions) => {
    if (!activeAsset || !file) return;
    setError(null);
    setNotice(null);
    const res = await api.appendAssetVersion(activeAsset.id, file, {
      ...options,
      changeNote: versionChangeNote.trim() || undefined,
      promptText: versionPromptText.trim() || undefined,
      setAsCurrent: versionSetCurrent
    });
    setActiveAsset(res.asset);
    syncInspectorFields(res.asset);
    setVersionChangeNote("");
    setVersionPromptText("");
    setVersionFormOpen(false);
    setNotice(
      `已追加新版本 V${res.version.versionNo}（旧版本完整保留${
        res.deduplicated ? "，复用已有底层文件" : ""
      }）${formatUploadCompression(res.compression)}`
    );
    await loadAssets();
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
      | "soft_delete",
    extra: {
      folderId?: string | null;
      tagIds?: string[];
      productIds?: string[];
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
      | "soft_delete",
    extra: {
      folderId?: string | null;
      tagIds?: string[];
      productIds?: string[];
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
        <div className="flex flex-wrap items-center gap-2">
          <ImageCompressionSwitch
            checked={compressUploadImages}
            onChange={setCompressUploadImages}
            disabled={uploading || !!canvasUpload}
          />
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
            disabled={uploading || !!canvasUpload}
            onClick={() => {
              setUploadTargetProductId(productId);
              setUploadTargetFolderId(folderId);
              setUploadTargetStorageId(storageId);
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
      {canvasUpload && (
        <BatchAssetUpload
          direct={canvasUpload}
          onSubmit={performUpload}
          onError={setError}
          onComplete={() => setCanvasUpload(null)}
        />
      )}

      <div className="flex h-[calc(100vh-11.5rem)] min-h-[560px] overflow-hidden rounded-xl border border-gray-200 bg-white">
        {/* Left Taxonomy Rail */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-gray-50/60 md:flex">
          <div className="flex-1 space-y-5 overflow-y-auto p-3 text-xs">
            <div>
              <div className="mb-1.5 px-2 text-[11px] font-semibold text-gray-400">快捷视图</div>
              <div className="space-y-0.5">
                {[
                  { key: "all" as const, label: "全部素材", icon: Layers },
                  { key: "favorite" as const, label: "收藏夹", icon: Star },
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

            <FolderTreeSidebar
              tree={folderTree}
              selectedFolderId={folderId}
              onSelectFolder={(nextFolderId) => {
                setQuickView("all");
                setFolderId(nextFolderId);
              }}
              onCreateFolder={handleCreateFolder}
              onUpdateFolder={handleUpdateFolder}
              onDeleteFolder={handleDeleteFolder}
            />

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
                  skipNextUrlSyncRef.current = true;
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

            {selectedFolderNode && folderBreadcrumb.length > 0 && (
              <div
                data-testid="folder-breadcrumb"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-100 bg-blue-50/50 px-2.5 py-1.5 text-[11px]"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1 text-gray-600">
                  <Folder className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                  <button
                    type="button"
                    onClick={() => setFolderId("")}
                    className="rounded px-1 py-0.5 text-gray-500 hover:bg-blue-100/70 hover:text-blue-700"
                  >
                    全部素材
                  </button>
                  {folderBreadcrumb.map((crumb, idx) => {
                    const isCurrent = idx === folderBreadcrumb.length - 1;
                    return (
                      <span key={crumb.folder.id} className="inline-flex items-center gap-1">
                        <ChevronRight className="h-3 w-3 text-gray-400" />
                        {isCurrent ? (
                          <span className="font-semibold text-blue-700">{crumb.folder.name}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFolderId(crumb.folder.id)}
                            className="rounded px-1 py-0.5 text-gray-700 hover:bg-blue-100/70 hover:text-blue-700"
                          >
                            {crumb.folder.name}
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {selectedFolderNode.descendantFolderCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setIncludeSubfolders((prev) => !prev)}
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        includeSubfolders
                          ? "border-blue-200 bg-blue-100/70 text-blue-700 hover:bg-blue-100"
                          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                      }`}
                      title={
                        includeSubfolders
                          ? "当前展示该目录及所有子目录中的素材，点击切换为仅当前目录"
                          : "当前仅展示该目录直属素材，点击切换为包含子目录"
                      }
                    >
                      {includeSubfolders
                        ? `含 ${selectedFolderNode.descendantFolderCount} 个子目录`
                        : "仅当前目录"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setFolderId("")}
                    className="rounded p-0.5 text-gray-400 hover:bg-blue-100/70 hover:text-gray-700"
                    title="退出文件夹筛选"
                    aria-label="退出文件夹筛选"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
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
                  {folderTree.flatNodes.map((node) => (
                    <option key={node.folder.id} value={node.folder.id} title={node.pathLabel}>
                      {formatFolderSelectOption(node)}
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

              {activeAsset.id === activeAssetId && (
                <section className="space-y-2 rounded-lg border border-gray-200 bg-white p-2.5">
                  <h3 className="inline-flex items-center gap-1 font-semibold text-gray-900">
                    <Layers className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
                    用在哪
                  </h3>
                  {activeAsset.listingUsages.length === 0 ? (
                    <p className="text-[11px] text-gray-500">当前没有上架链接引用此素材</p>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {activeAsset.listingUsages.map((usage) => (
                        <li key={usage.itemId} className="space-y-0.5 py-2">
                          <p className="break-words text-[11px] text-gray-500">{usage.storeName}</p>
                          <Link
                            to={`/listings/${encodeURIComponent(usage.listingId)}?assetGroup=${usage.kind}`}
                            className="break-words font-medium text-blue-700 underline-offset-2 hover:underline focus-visible:underline"
                          >
                            {usage.listingName}
                            <span className="sr-only"> · {ASSET_GROUP_LABELS[usage.kind]}</span>
                          </Link>
                          <p className="text-[11px] text-gray-600">
                            {ASSET_GROUP_LABELS[usage.kind]} · 第 {usage.position + 1} 位 · 固定使用 V{usage.versionNo}
                          </p>
                          {usage.kind === "sku" && usage.skuCode && (
                            <p className="break-words text-[11px] text-gray-600">商品 SKU {usage.skuCode}</p>
                          )}
                          {usage.kind === "sku" && usage.skuChannelCode && (
                            <p className="break-words text-[11px] text-gray-600">渠道 SKU {usage.skuChannelCode}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

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
                    onClick={toggleVersionForm}
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
                    <BatchAssetUpload
                      key={activeAsset.id}
                      singleFile
                      className="space-y-2"
                      compression={{ checked: compressVersionImage, onChange: setCompressVersionImage }}
                      onBusyChange={setVersionUploading}
                      onSubmit={handleAppendVersion}
                      onError={setError}
                      fields={(busy) => (
                        <>
                          <input
                            type="text"
                            disabled={busy}
                            value={versionChangeNote}
                            onChange={(e) => setVersionChangeNote(e.target.value)}
                            placeholder="变更说明（如：调整高光、修复文字）"
                            className="w-full rounded border border-gray-200 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none"
                          />
                          <textarea
                            rows={2}
                            disabled={busy}
                            value={versionPromptText}
                            onChange={(e) => setVersionPromptText(e.target.value)}
                            placeholder="提示词 / 生成参数（可选）"
                            className="w-full rounded border border-gray-200 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none"
                          />
                          <label className="flex cursor-pointer items-center gap-1.5 text-gray-700">
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={versionSetCurrent}
                              onChange={(e) => setVersionSetCurrent(e.target.checked)}
                              className="rounded border-gray-300"
                            />
                            <span>上传后设为当前展示版本</span>
                          </label>
                        </>
                      )}
                    />
                  </div>
                )}

                <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
                  {activeAsset.versions.map((ver) => {
                    const isCurrent = ver.id === activeAsset.currentVersionId;
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
                          <a
                            href={api.contentUrl(activeAsset.id, ver.id)}
                            className="ml-auto rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
                          >
                            下载
                          </a>
                        </div>
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
                      {folderTree.flatNodes.map((node) => (
                        <option key={node.folder.id} value={node.folder.id} title={node.pathLabel}>
                          {formatFolderSelectOption(node)}
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

      {uploadModalOpen && (
        <BatchAssetUpload
          dialogTitle="批量上传素材"
          compression={{ checked: compressUploadImages, onChange: setCompressUploadImages }}
          onBusyChange={setUploading}
          onClose={() => setUploadModalOpen(false)}
          onSubmit={(files, options) => performUpload(files, {
            ...options,
            productId: uploadTargetProductId || undefined,
            folderId: uploadTargetFolderId || undefined,
            purpose: uploadTargetPurpose || undefined,
            storageId: uploadTargetStorageId || undefined
          }, true)}
          fields={(busy) => (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-gray-700">关联商品（选填）</label>
                <select
                  disabled={busy}
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
                  disabled={busy}
                  value={uploadTargetFolderId}
                  onChange={(e) => setUploadTargetFolderId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">未归类</option>
                  {folderTree.flatNodes.map((node) => (
                    <option key={node.folder.id} value={node.folder.id} title={node.pathLabel}>
                      {formatFolderSelectOption(node)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">默认用途</label>
                <select
                  disabled={busy}
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
                  disabled={busy}
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
          )}
        />
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
