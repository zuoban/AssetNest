import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  Film,
  GripVertical,
  History,
  Images,
  Info,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Smartphone,
  Trash2,
  X
} from "lucide-react";
import type {
  AssetListItem,
  AssetSetItemRecord,
  AssetSetKind,
  DictionariesResponse,
  ListingAssetSetsResponse,
  ListingDetail,
  ListingPdpResponse,
  ListingStatus,
  ListingSummary,
  PdpContent,
  PdpVersionRecord,
  ProductDetail,
  StoreRecord
} from "../../shared/types";
import { api } from "../api/client";
import {
  countCodePoints,
  formatAspectRatio,
  formatBytes,
  formatDateTime,
  LISTING_STATUS_META,
  REVIEW_STATUS_META
} from "../utils/format";

type WorkbenchTab = "assets" | "skus" | "pdp";

interface SortableCardProps {
  item: AssetSetItemRecord;
  index: number;
  isMainSlot: boolean;
  onRemove: (id: string) => void;
  onUpgrade: (id: string) => void;
}

function SortableCarouselCard({
  item,
  index,
  isMainSlot,
  onRemove,
  onUpgrade
}: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };
  const reviewMeta = REVIEW_STATUS_META[item.reviewStatus];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xs"
    >
      <div className="relative aspect-square bg-gray-100">
        <img
          src={api.thumbnailUrl(item.assetId, item.assetVersionId)}
          alt={item.assetName}
          className="h-full w-full object-contain"
          loading="lazy"
        />
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <button
            type="button"
            {...attributes}
            {...listeners}
            title="拖拽调整排序"
            className="inline-flex cursor-grab items-center gap-0.5 rounded-md bg-gray-900/75 px-1.5 py-0.5 text-[11px] font-medium text-white active:cursor-grabbing"
          >
            <GripVertical className="h-3 w-3" />
            <span className="font-mono-tabular">#{index + 1}</span>
          </button>
          {isMainSlot && (
            <span className="rounded-md bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              主图
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          title="从当前素材组移除"
          className="absolute top-2 right-2 rounded-md bg-white/90 p-1 text-rose-600 shadow-xs hover:bg-rose-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <div className="absolute right-2 bottom-2 left-2 flex flex-wrap items-center justify-between gap-1">
          <span className="rounded bg-gray-900/75 px-1.5 py-0.5 font-mono-tabular text-[10px] text-white">
            V{item.versionNo}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewMeta.className}`}
          >
            {reviewMeta.label}
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-between p-2.5 text-[11px]">
        <div>
          <div className="truncate font-medium text-gray-900" title={item.assetName}>
            {item.assetName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono-tabular text-[10px] text-gray-500">
            <span>
              {item.width && item.height ? `${item.width}×${item.height}` : "—"}
            </span>
            <span>{formatAspectRatio(item.width, item.height)}</span>
            <span>{formatBytes(item.sizeBytes)}</span>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          {(item.isDuplicateVersion || item.isDuplicateAsset) && (
            <div className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>{item.isDuplicateVersion ? "同版本重复引用" : "同素材重复出现"}</span>
            </div>
          )}
          {item.hasNewerVersion && (
            <button
              type="button"
              onClick={() => onUpgrade(item.id)}
              className="flex w-full items-center justify-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700 hover:bg-blue-100"
            >
              <ArrowUpCircle className="h-3 w-3" />
              升级到 V{item.latestVersionNo}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SortableRowProps {
  item: AssetSetItemRecord;
  index: number;
  onRemove: (id: string) => void;
  onUpgrade: (id: string) => void;
}

function SortableLinearRow({ item, index, onRemove, onUpgrade }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };
  const reviewMeta = REVIEW_STATUS_META[item.reviewStatus];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-2.5 text-xs"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        title="拖拽调整顺序"
        className="flex cursor-grab items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-gray-600 hover:bg-gray-200 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
        <span className="font-mono-tabular font-medium">#{index + 1}</span>
      </button>

      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
        <img
          src={api.thumbnailUrl(item.assetId, item.assetVersionId)}
          alt={item.assetName}
          className="h-full w-full object-contain"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-gray-900">{item.assetName}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono-tabular text-[10px] text-gray-700">
            V{item.versionNo}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewMeta.className}`}
          >
            {reviewMeta.label}
          </span>
          {(item.isDuplicateVersion || item.isDuplicateAsset) && (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
              <AlertTriangle className="h-3 w-3" />
              重复引用
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 font-mono-tabular text-[11px] text-gray-500">
          <span>{item.originalFilename}</span>
          <span>{item.width && item.height ? `${item.width}×${item.height}` : "—"}</span>
          <span>{formatAspectRatio(item.width, item.height)}</span>
          <span>{formatBytes(item.sizeBytes)}</span>
          {item.assetType === "video" && (
            <a
              href={api.contentUrl(item.assetId, item.assetVersionId, true)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
            >
              <Film className="h-3 w-3" />
              播放预览
            </a>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {item.hasNewerVersion && (
          <button
            type="button"
            onClick={() => onUpgrade(item.id)}
            className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
          >
            <ArrowUpCircle className="h-3 w-3" />
            升级到 V{item.latestVersionNo}
          </button>
        )}
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className="rounded-md border border-rose-200 p-1.5 text-rose-600 hover:bg-rose-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function emptyPdp(): PdpContent {
  return {
    title: "",
    shortDescription: "",
    bullets: [],
    fullDescription: "",
    specs: [],
    packageList: "",
    usageInstructions: "",
    seoKeywords: "",
    notes: ""
  };
}

export function ListingWorkbenchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<WorkbenchTab>("assets");
  const [activeSetKind, setActiveSetKind] = useState<AssetSetKind>("carousel");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [siblings, setSiblings] = useState<ListingSummary[]>([]);
  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [dictionaries, setDictionaries] = useState<DictionariesResponse | null>(null);
  const [assetSets, setAssetSets] = useState<ListingAssetSetsResponse | null>(null);
  const [pdp, setPdp] = useState<ListingPdpResponse | null>(null);

  // Header metadata form
  const [metaName, setMetaName] = useState("");
  const [metaStatus, setMetaStatus] = useState<ListingStatus>("draft");
  const [metaLanguage, setMetaLanguage] = useState("en");
  const [metaExternalId, setMetaExternalId] = useState("");
  const [metaExternalUrl, setMetaExternalUrl] = useState("");
  const [metaNotes, setMetaNotes] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);

  // Asset set saving state
  const [savingSet, setSavingSet] = useState(false);
  const [mobilePreviewWidth, setMobilePreviewWidth] = useState(true);

  // Asset Picker Modal (also supports SKU target and cross-listing reuse)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<AssetSetKind>("carousel");
  const [pickerSkuTarget, setPickerSkuTarget] = useState<string | null>(null);
  const [pickerSourceTab, setPickerSourceTab] = useState<"product" | "all" | "sibling">("product");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerAssets, setPickerAssets] = useState<AssetListItem[]>([]);
  const [pickerSiblingId, setPickerSiblingId] = useState("");
  const [pickerSiblingSets, setPickerSiblingSets] = useState<ListingAssetSetsResponse | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);

  // SKU Binding Editor State
  const [skuDraft, setSkuDraft] = useState<
    Record<string, { selected: boolean; channelCode: string; displayName: string }>
  >({});
  const [savingSkus, setSavingSkus] = useState(false);

  // PDP Draft Editor State
  const [pdpLang, setPdpLang] = useState("en");
  const [pdpContent, setPdpContent] = useState<PdpContent>(emptyPdp());
  const [savingPdp, setSavingPdp] = useState(false);
  const [freezeNote, setFreezeNote] = useState("");
  const [freezingPdp, setFreezingPdp] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<PdpVersionRecord | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Copy PDP Modal
  const [copyPdpOpen, setCopyPdpOpen] = useState(false);
  const [copyTargetListingId, setCopyTargetListingId] = useState("");
  const [copyVersionId, setCopyVersionId] = useState("");
  const [copyKeepTargetLang, setCopyKeepTargetLang] = useState(true);
  const [copyingPdp, setCopyingPdp] = useState(false);

  // Duplicate Listing Modal
  const [dupOpen, setDupOpen] = useState(false);
  const [dupStoreId, setDupStoreId] = useState("");
  const [dupDisplayName, setDupDisplayName] = useState("");
  const [dupLanguage, setDupLanguage] = useState("");
  const [duplicating, setDuplicating] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const loadAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, setsRes, pdpRes, storesRes, dictsRes] = await Promise.all([
        api.getListing(id),
        api.getListingAssetSets(id),
        api.getListingPdp(id),
        api.listStores(),
        api.getDictionaries()
      ]);
      setListing(detailRes);
      setAssetSets(setsRes);
      setPdp(pdpRes);
      setStores(storesRes.items);
      setDictionaries(dictsRes);

      setMetaName(detailRes.displayName);
      setMetaStatus(detailRes.status);
      setMetaLanguage(detailRes.language);
      setMetaExternalId(detailRes.externalId ?? "");
      setMetaExternalUrl(detailRes.externalUrl ?? "");
      setMetaNotes(detailRes.notes);

      setPdpLang(pdpRes.draft.language);
      setPdpContent(pdpRes.draft.content);

      const [prodRes, sibRes] = await Promise.all([
        api.getProduct(detailRes.productId),
        api.listListings({ productId: detailRes.productId, page: 1, pageSize: 50 })
      ]);
      setProduct(prodRes);
      setSiblings(sibRes.items);

      const boundBySkuId = new Map(detailRes.skus.map((s) => [s.skuId, s]));
      const nextSkuDraft: Record<
        string,
        { selected: boolean; channelCode: string; displayName: string }
      > = {};
      for (const sku of prodRes.skus) {
        const existing = boundBySkuId.get(sku.id);
        nextSkuDraft[sku.id] = {
          selected: Boolean(existing),
          channelCode: existing?.channelCode ?? "",
          displayName: existing?.displayName ?? ""
        };
      }
      setSkuDraft(nextSkuDraft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载上架工作台失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const labelOf = (category: "platform" | "market" | "language", code: string): string => {
    const list =
      category === "platform"
        ? dictionaries?.platforms
        : category === "market"
          ? dictionaries?.markets
          : dictionaries?.languages;
    return list?.find((d) => d.code === code)?.label ?? code;
  };

  const flashNotice = (msg: string) => {
    setNotice(msg);
    setError(null);
  };

  const copyToClipboard = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1600);
    } catch {
      setError("浏览器未授予剪贴板权限，请手动全选复制");
    }
  };

  const handleSaveMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSavingMeta(true);
    setError(null);
    try {
      const updated = await api.updateListing(id, {
        displayName: metaName.trim(),
        status: metaStatus,
        language: metaLanguage,
        externalId: metaExternalId.trim() || null,
        externalUrl: metaExternalUrl.trim() || null,
        notes: metaNotes
      });
      setListing(updated);
      flashNotice("已保存上架链接基础信息与人工状态");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存基础信息失败");
    } finally {
      setSavingMeta(false);
    }
  };

  const persistSetItems = async (
    kind: AssetSetKind,
    items: Array<{ assetVersionId: string; listingSkuId?: string | null }>,
    successMsg: string
  ) => {
    if (!id) return;
    setSavingSet(true);
    setError(null);
    try {
      const updated = await api.replaceListingAssetSet(id, kind, items);
      setAssetSets(updated);
      flashNotice(successMsg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存素材组失败");
    } finally {
      setSavingSet(false);
    }
  };

  const currentSetItems = useMemo(() => {
    if (!assetSets) return [];
    return assetSets.sets[activeSetKind].items;
  }, [assetSets, activeSetKind]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !assetSets) return;
    const items = assetSets.sets[activeSetKind].items;
    const oldIndex = items.findIndex((item) => item.id === active.id);
    const newIndex = items.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(items, oldIndex, newIndex);
    setAssetSets({
      ...assetSets,
      sets: {
        ...assetSets.sets,
        [activeSetKind]: {
          ...assetSets.sets[activeSetKind],
          items: reordered.map((it, idx) => ({ ...it, position: idx }))
        }
      }
    });
    void persistSetItems(
      activeSetKind,
      reordered.map((it) => ({
        assetVersionId: it.assetVersionId,
        listingSkuId: it.listingSkuId
      })),
      "已更新素材组排序"
    );
  };

  const handleRemoveSetItem = (kind: AssetSetKind, itemId: string) => {
    if (!assetSets) return;
    const remaining = assetSets.sets[kind].items.filter((it) => it.id !== itemId);
    void persistSetItems(
      kind,
      remaining.map((it) => ({
        assetVersionId: it.assetVersionId,
        listingSkuId: it.listingSkuId
      })),
      "已从素材组移除该条目"
    );
  };

  const handleUpgradeSetItem = (kind: AssetSetKind, itemId: string) => {
    if (!assetSets) return;
    const updatedList = assetSets.sets[kind].items.map((it) => ({
      assetVersionId: it.id === itemId ? it.latestVersionId : it.assetVersionId,
      listingSkuId: it.listingSkuId
    }));
    void persistSetItems(kind, updatedList, "已手动升级该条目的固定素材版本");
  };

  const loadPickerAssets = useCallback(
    async (source: "product" | "all", query: string, kind: AssetSetKind) => {
      if (!listing) return;
      setPickerLoading(true);
      try {
        const res = await api.listAssets({
          productId: source === "product" ? listing.productId : undefined,
          q: query.trim() || undefined,
          type: kind === "video" ? "video" : "image",
          page: 1,
          pageSize: 60
        });
        setPickerAssets(res.items);
      } catch {
        setPickerAssets([]);
      } finally {
        setPickerLoading(false);
      }
    },
    [listing]
  );

  const openPicker = (kind: AssetSetKind, skuTargetId: string | null = null) => {
    setPickerKind(kind);
    setPickerSkuTarget(skuTargetId);
    setPickerSourceTab("product");
    setPickerQuery("");
    setPickerOpen(true);
    void loadPickerAssets("product", "", kind);
    const otherSiblings = siblings.filter((s) => s.id !== id);
    const firstOtherSibling = otherSiblings[0];
    if (firstOtherSibling && !pickerSiblingId) {
      setPickerSiblingId(firstOtherSibling.id);
    }
  };

  useEffect(() => {
    if (!pickerOpen) return;
    if (pickerSourceTab === "product" || pickerSourceTab === "all") {
      void loadPickerAssets(pickerSourceTab, pickerQuery, pickerKind);
    } else if (pickerSourceTab === "sibling" && pickerSiblingId) {
      setPickerLoading(true);
      api
        .getListingAssetSets(pickerSiblingId)
        .then((res) => setPickerSiblingSets(res))
        .catch(() => setPickerSiblingSets(null))
        .finally(() => setPickerLoading(false));
    }
  }, [pickerOpen, pickerSourceTab, pickerQuery, pickerKind, pickerSiblingId, loadPickerAssets]);

  const handlePickVersion = (assetVersionId: string) => {
    if (!assetSets) return;
    if (pickerKind === "sku" && pickerSkuTarget) {
      const existing = assetSets.sets.sku.items.filter(
        (it) => it.listingSkuId !== pickerSkuTarget
      );
      const next = [
        ...existing.map((it) => ({
          assetVersionId: it.assetVersionId,
          listingSkuId: it.listingSkuId
        })),
        { assetVersionId, listingSkuId: pickerSkuTarget }
      ];
      setPickerOpen(false);
      void persistSetItems("sku", next, "已更新该 SKU 专属图片（其他 SKU 绑定不受影响）");
      return;
    }

    const existing = assetSets.sets[pickerKind].items;
    const next = [
      ...existing.map((it) => ({
        assetVersionId: it.assetVersionId,
        listingSkuId: it.listingSkuId
      })),
      { assetVersionId, listingSkuId: null }
    ];
    void persistSetItems(pickerKind, next, "已添加固定版本到当前素材组");
  };

  const handleSaveSkuBindings = async () => {
    if (!id || !product) return;
    setSavingSkus(true);
    setError(null);
    try {
      const items = product.skus
        .filter((sku) => skuDraft[sku.id]?.selected)
        .map((sku) => ({
          skuId: sku.id,
          channelCode: skuDraft[sku.id]?.channelCode.trim() ?? "",
          displayName: skuDraft[sku.id]?.displayName.trim() ?? ""
        }));
      const updated = await api.syncListingSkus(id, items);
      setListing(updated);
      const refreshedSets = await api.getListingAssetSets(id);
      setAssetSets(refreshedSets);
      flashNotice(`已更新当前上架链接的 ${items.length} 个 SKU 映射`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存 SKU 映射失败");
    } finally {
      setSavingSkus(false);
    }
  };

  const handleSavePdpDraft = async () => {
    if (!id) return;
    setSavingPdp(true);
    setError(null);
    try {
      const updated = await api.saveListingPdpDraft(id, {
        language: pdpLang,
        content: pdpContent
      });
      setPdp(updated);
      setPdpContent(updated.draft.content);
      flashNotice(`已保存 PDP 文案草稿（修订 #${updated.draft.revision}）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存 PDP 草稿失败");
    } finally {
      setSavingPdp(false);
    }
  };

  const handleFreezePdpVersion = async () => {
    if (!id) return;
    setFreezingPdp(true);
    setError(null);
    try {
      await api.saveListingPdpDraft(id, {
        language: pdpLang,
        content: pdpContent
      });
      const created = await api.createListingPdpVersion(id, {
        note: freezeNote.trim() || undefined
      });
      setFreezeNote("");
      setPdp(created.pdp);
      flashNotice(`已固化不可变 PDP 文案版本 V${created.version.versionNo}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "固化 PDP 版本失败");
    } finally {
      setFreezingPdp(false);
    }
  };

  const handleRestorePdpVersion = async (ver: PdpVersionRecord) => {
    if (!id) return;
    if (
      !window.confirm(
        `确认将历史版本 V${ver.versionNo} 恢复为新的当前草稿？原有历史版本保持只读不被覆盖。`
      )
    ) {
      return;
    }
    setError(null);
    try {
      const restored = await api.restoreListingPdpVersion(id, ver.id);
      setPdp(restored);
      setPdpLang(restored.draft.language);
      setPdpContent(restored.draft.content);
      setPreviewVersion(null);
      flashNotice(`已将 V${ver.versionNo} 恢复为当前草稿（修订 #${restored.draft.revision}）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复 PDP 版本失败");
    }
  };

  const handleImportProductSpecs = () => {
    if (!pdp || pdp.productSpecs.length === 0) return;
    if (
      pdpContent.specs.length > 0 &&
      !window.confirm("确认用商品当前公共规格更新草稿中的规格表？（未保存前仍可撤销）")
    ) {
      return;
    }
    setPdpContent({
      ...pdpContent,
      specs: pdp.productSpecs.map((s) => ({ ...s }))
    });
    flashNotice("已从商品公共规格导入到草稿，请确认后点击「保存草稿」");
  };

  const handleCopyPdpToTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !copyTargetListingId) return;
    setCopyingPdp(true);
    setError(null);
    try {
      await api.copyListingPdpTo(id, {
        targetListingId: copyTargetListingId,
        versionId: copyVersionId || undefined,
        keepTargetLanguage: copyKeepTargetLang
      });
      setCopyPdpOpen(false);
      flashNotice("已将 PDP 文案复制到目标上架链接草稿");
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制 PDP 文案失败");
    } finally {
      setCopyingPdp(false);
    }
  };

  const handleDuplicateCurrent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setDuplicating(true);
    setError(null);
    try {
      const created = await api.duplicateListing(id, {
        storeId: dupStoreId || undefined,
        displayName: dupDisplayName.trim() || undefined,
        language: dupLanguage || undefined
      });
      setDupOpen(false);
      navigate(`/listings/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制上架链接失败");
    } finally {
      setDuplicating(false);
    }
  };

  const buildFullPdpText = (): string => {
    const lines: string[] = [];
    if (pdpContent.title) lines.push(`【Title】\n${pdpContent.title}`);
    if (pdpContent.shortDescription) lines.push(`【Short Description】\n${pdpContent.shortDescription}`);
    if (pdpContent.bullets.filter((b) => b.trim()).length > 0) {
      lines.push(
        `【Highlights】\n${pdpContent.bullets
          .filter((b) => b.trim())
          .map((b) => `• ${b}`)
          .join("\n")}`
      );
    }
    if (pdpContent.fullDescription) lines.push(`【Description】\n${pdpContent.fullDescription}`);
    if (pdpContent.specs.filter((s) => s.specKey.trim()).length > 0) {
      lines.push(
        `【Specifications】\n${pdpContent.specs
          .filter((s) => s.specKey.trim())
          .map((s) => `${s.specKey}: ${s.specValue}${s.unit ? ` ${s.unit}` : ""}`)
          .join("\n")}`
      );
    }
    if (pdpContent.packageList) lines.push(`【Package List】\n${pdpContent.packageList}`);
    if (pdpContent.usageInstructions) lines.push(`【Usage】\n${pdpContent.usageInstructions}`);
    if (pdpContent.seoKeywords) lines.push(`【SEO Keywords】\n${pdpContent.seoKeywords}`);
    return lines.join("\n\n");
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-xs text-gray-500">
        正在加载上架工作台...
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="rounded-xl border border-rose-200 bg-white p-8 text-center">
        <p className="text-sm font-medium text-rose-700">{error ?? "未找到该上架链接"}</p>
        <Link
          to="/listings"
          className="mt-4 inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white"
        >
          返回上架列表
        </Link>
      </div>
    );
  }

  const statusMeta = LISTING_STATUS_META[listing.status];
  const titleCodePoints = countCodePoints(pdpContent.title);
  const titleUtf8Bytes = new TextEncoder().encode(pdpContent.title).length;
  const otherSiblings = siblings.filter((s) => s.id !== listing.id);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/listings"
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            上架列表
          </Link>
          <Link
            to={`/products/${listing.productId}`}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            商品：<span className="font-mono-tabular font-medium">{listing.productSpu}</span> ·{" "}
            {listing.productNameZh}
          </Link>
          <span
            className={`rounded-md border px-2 py-1 text-[11px] font-medium ${statusMeta.className}`}
          >
            {statusMeta.label}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadAll()}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          <button
            type="button"
            onClick={() => {
              setDupStoreId(listing.storeId);
              setDupDisplayName(`${listing.displayName} (副本)`);
              setDupLanguage(listing.language);
              setDupOpen(true);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Copy className="h-3.5 w-3.5" />
            复制为独立草稿
          </button>
        </div>
      </div>

      {siblings.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-xs">
          <span className="font-medium text-gray-500">同商品多渠道切换：</span>
          {siblings.map((sib) => {
            const isCurrent = sib.id === listing.id;
            return (
              <Link
                key={sib.id}
                to={`/listings/${sib.id}`}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium transition-colors ${
                  isCurrent
                    ? "border-blue-600 bg-blue-50 text-blue-700"
                    : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                }`}
              >
                <span>
                  {sib.market} {labelOf("platform", sib.platform)}
                </span>
                <span className="text-[10px] opacity-75">· {sib.storeName}</span>
              </Link>
            );
          })}
        </div>
      )}

      <form
        onSubmit={(e) => void handleSaveMeta(e)}
        className="rounded-xl border border-gray-200 bg-white p-4"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold text-gray-900">{listing.displayName}</h1>
            <span className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
              {labelOf("platform", listing.platform)} · {labelOf("market", listing.market)}
            </span>
            <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700">
              店铺：{listing.storeName}
            </span>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
            <Info className="h-3.5 w-3.5" />
            外部平台发布状态由人工维护
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 text-xs md:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-600">展示名称</label>
            <input
              type="text"
              value={metaName}
              onChange={(e) => setMetaName(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-600">
              发布状态（人工维护）
            </label>
            <select
              value={metaStatus}
              onChange={(e) => setMetaStatus(e.target.value as ListingStatus)}
              className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5"
            >
              <option value="draft">草稿</option>
              <option value="ready">已准备</option>
              <option value="published">已上架（人工标记）</option>
              <option value="archived">已归档</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-600">文案语言</label>
            <select
              value={metaLanguage}
              onChange={(e) => setMetaLanguage(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5"
            >
              {dictionaries?.languages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-600">
              外部平台 ID（人工记录）
            </label>
            <input
              type="text"
              value={metaExternalId}
              onChange={(e) => setMetaExternalId(e.target.value)}
              placeholder="例如 Item ID"
              className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 font-mono-tabular focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-[11px] font-medium text-gray-600">
                外部链接（选填）
              </label>
              <input
                type="text"
                value={metaExternalUrl}
                onChange={(e) => setMetaExternalUrl(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 focus:border-blue-500 focus:outline-none"
              />
            </div>
            {metaExternalUrl.trim().startsWith("http") && (
              <a
                href={metaExternalUrl.trim()}
                target="_blank"
                rel="noreferrer"
                title="打开外部链接"
                className="rounded-lg border border-gray-200 p-1.5 text-gray-600 hover:bg-gray-50"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button
              type="submit"
              disabled={savingMeta}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {savingMeta ? "保存中" : "保存"}
            </button>
          </div>
        </div>
      </form>

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

      <div className="flex items-center gap-2 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setActiveTab("assets")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium ${
            activeTab === "assets"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <Images className="h-4 w-4" />
          素材组编排
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("skus")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium ${
            activeTab === "skus"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <Layers className="h-4 w-4" />
          SKU 绑定与渠道映射 ({listing.skus.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("pdp")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium ${
            activeTab === "pdp"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <FileText className="h-4 w-4" />
          PDP 多语言文案 ({pdp?.versions.length ?? 0} 个历史版本)
        </button>
      </div>

      {activeTab === "assets" && assetSets && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { kind: "carousel", label: "轮播图组 (主图+副图)" },
                  { kind: "detail", label: "详情图组 (竖屏瀑布流)" },
                  { kind: "sku", label: "SKU 专属图" },
                  { kind: "video", label: "视频组" }
                ] as Array<{ kind: AssetSetKind; label: string }>
              ).map((tabItem) => (
                <button
                  key={tabItem.kind}
                  type="button"
                  onClick={() => setActiveSetKind(tabItem.kind)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeSetKind === tabItem.kind
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {tabItem.label} ({assetSets.sets[tabItem.kind].items.length})
                </button>
              ))}
            </div>

            {activeSetKind !== "sku" && (
              <div className="flex items-center gap-2">
                {savingSet && (
                  <span className="text-xs text-blue-600">正在同步素材组排序...</span>
                )}
                <button
                  type="button"
                  onClick={() => openPicker(activeSetKind, null)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加 / 复用素材版本
                </button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
            素材组固定引用具体的素材版本（例如 V1）。当同一素材上传 V2 时，系统不会静默覆盖当前上架素材，仅提示「升级到 V2」供您手动确认。
          </div>

          {activeSetKind === "carousel" && (
            <>
              {currentSetItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-xs text-gray-500">
                  当前轮播图组为空。点击右上角「添加 / 复用素材版本」，第 1 位自动标识为主图。
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={currentSetItems.map((it) => it.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                      {currentSetItems.map((item, idx) => (
                        <SortableCarouselCard
                          key={item.id}
                          item={item}
                          index={idx}
                          isMainSlot={idx === 0}
                          onRemove={(itemId) => handleRemoveSetItem("carousel", itemId)}
                          onUpgrade={(itemId) => handleUpgradeSetItem("carousel", itemId)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </>
          )}

          {activeSetKind === "detail" && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
              <div className="space-y-2.5 lg:col-span-7">
                {currentSetItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-xs text-gray-500">
                    暂无详情长图。添加图片后可拖拽调整顺序，右侧将实时呈现无缝竖屏瀑布流预览。
                  </div>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={currentSetItems.map((it) => it.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-2">
                        {currentSetItems.map((item, idx) => (
                          <SortableLinearRow
                            key={item.id}
                            item={item}
                            index={idx}
                            onRemove={(itemId) => handleRemoveSetItem("detail", itemId)}
                            onUpgrade={(itemId) => handleUpgradeSetItem("detail", itemId)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </div>

              <div className="lg:col-span-5">
                <div className="sticky top-20 rounded-xl border border-gray-200 bg-white p-3.5">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-900">
                      <Smartphone className="h-4 w-4 text-blue-600" />
                      详情页连续竖屏瀑布流预览（9:16 适配）
                    </div>
                    <button
                      type="button"
                      onClick={() => setMobilePreviewWidth((v) => !v)}
                      className="rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      {mobilePreviewWidth ? "手机窄屏 (375px)" : "自适应宽度"}
                    </button>
                  </div>
                  <div className="max-h-[680px] overflow-y-auto rounded-xl border border-gray-200 bg-gray-100 p-3">
                    {currentSetItems.length === 0 ? (
                      <div className="py-16 text-center text-xs text-gray-400">
                        添加详情图后在此无缝拼接预览
                      </div>
                    ) : (
                      <div
                        className={`mx-auto overflow-hidden bg-white shadow-sm ${
                          mobilePreviewWidth ? "max-w-[375px]" : "w-full"
                        }`}
                      >
                        {currentSetItems.map((item, idx) => (
                          <div key={item.id} className="relative">
                            <img
                              src={api.contentUrl(item.assetId, item.assetVersionId, true)}
                              alt={`详情图 #${idx + 1} ${item.assetName}`}
                              className="block w-full"
                              loading="lazy"
                            />
                            <span className="absolute top-1.5 left-1.5 rounded bg-gray-900/65 px-1.5 py-0.5 font-mono-tabular text-[10px] text-white">
                              #{idx + 1} · V{item.versionNo}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSetKind === "sku" && (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              {listing.skus.length === 0 ? (
                <div className="p-10 text-center text-xs text-gray-500">
                  当前上架链接尚未绑定任何 SKU。请先切换到「SKU 绑定与渠道映射」勾选要上架的 SKU。
                </div>
              ) : (
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="border-b border-gray-200 bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-4 py-3 font-medium">商品 SKU</th>
                      <th className="px-4 py-3 font-medium">渠道 SKU 编码 / 展示名</th>
                      <th className="px-4 py-3 font-medium">已绑定图片版本</th>
                      <th className="px-4 py-3 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {listing.skus.map((lsku) => {
                      const boundItem = assetSets.sets.sku.items.find(
                        (it) => it.listingSkuId === lsku.id
                      );
                      return (
                        <tr key={lsku.id} className="hover:bg-gray-50/60">
                          <td className="px-4 py-3">
                            <div className="font-mono-tabular font-medium text-gray-900">
                              {lsku.skuCode}
                            </div>
                            <div className="text-[11px] text-gray-500">{lsku.skuName}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-mono-tabular text-gray-800">
                              {lsku.channelCode || "—"}
                            </div>
                            <div className="text-[11px] text-gray-500">
                              {lsku.displayName || lsku.skuName}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {boundItem ? (
                              <div className="flex items-center gap-3">
                                <img
                                  src={api.thumbnailUrl(
                                    boundItem.assetId,
                                    boundItem.assetVersionId
                                  )}
                                  alt={boundItem.assetName}
                                  className="h-12 w-12 rounded-lg border border-gray-200 bg-gray-50 object-contain"
                                />
                                <div>
                                  <div className="flex items-center gap-1.5 font-medium text-gray-900">
                                    <span>{boundItem.assetName}</span>
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono-tabular text-[10px]">
                                      V{boundItem.versionNo}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 font-mono-tabular text-[11px] text-gray-500">
                                    {boundItem.width && boundItem.height
                                      ? `${boundItem.width}×${boundItem.height}`
                                      : "—"}{" "}
                                    · {formatBytes(boundItem.sizeBytes)}
                                  </div>
                                  {boundItem.hasNewerVersion && (
                                    <button
                                      type="button"
                                      onClick={() => handleUpgradeSetItem("sku", boundItem.id)}
                                      className="mt-1 inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-100"
                                    >
                                      <ArrowUpCircle className="h-3 w-3" />
                                      升级到 V{boundItem.latestVersionNo}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-400">未绑定 SKU 图</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => openPicker("sku", lsku.id)}
                                className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                              >
                                {boundItem ? "替换该 SKU 图" : "选择 SKU 图"}
                              </button>
                              {boundItem && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveSetItem("sku", boundItem.id)}
                                  className="rounded-md border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-600 hover:bg-rose-50"
                                >
                                  解绑
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activeSetKind === "video" && (
            <>
              {currentSetItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-xs text-gray-500">
                  当前视频组为空。点击右上角添加商品视频或复用其他上架链接的视频版本。
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={currentSetItems.map((it) => it.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {currentSetItems.map((item, idx) => (
                        <SortableLinearRow
                          key={item.id}
                          item={item}
                          index={idx}
                          onRemove={(itemId) => handleRemoveSetItem("video", itemId)}
                          onUpgrade={(itemId) => handleUpgradeSetItem("video", itemId)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "skus" && product && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-600">
              勾选本上架链接需要售卖的商品 SKU 子集，并配置渠道侧 SKU 编码与展示名称。取消勾选已绑定 SKU 图的条目时，该 SKU 的图片绑定也会同步解除。
            </p>
            <button
              type="button"
              disabled={savingSkus}
              onClick={() => void handleSaveSkuBindings()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {savingSkus ? "保存中..." : "保存 SKU 映射"}
            </button>
          </div>

          {product.skus.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-xs text-gray-500">
              该商品尚未建立 SKU。请先前往{" "}
              <Link to={`/products/${product.id}`} className="text-blue-600 hover:underline">
                商品详情页
              </Link>{" "}
              添加 SKU。
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="border-b border-gray-200 bg-gray-50 text-gray-600">
                  <tr>
                    <th className="w-12 px-4 py-3 text-center font-medium">启用</th>
                    <th className="px-4 py-3 font-medium">商品 SKU 编码</th>
                    <th className="px-4 py-3 font-medium">SKU 名称与规格属性</th>
                    <th className="px-4 py-3 font-medium">渠道 SKU 编码（如 Shopee/TikTok 编码）</th>
                    <th className="px-4 py-3 font-medium">渠道展示名称</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {product.skus.map((sku) => {
                    const row = skuDraft[sku.id] ?? {
                      selected: false,
                      channelCode: "",
                      displayName: ""
                    };
                    return (
                      <tr key={sku.id} className={row.selected ? "bg-blue-50/30" : ""}>
                        <td className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={(e) =>
                              setSkuDraft({
                                ...skuDraft,
                                [sku.id]: { ...row, selected: e.target.checked }
                              })
                            }
                            className="h-4 w-4 rounded border-gray-300 text-blue-600"
                          />
                        </td>
                        <td className="px-4 py-3 font-mono-tabular font-medium text-gray-900">
                          {sku.code}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-800">{sku.name}</div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {Object.entries(sku.attributes).map(([k, v]) => (
                              <span
                                key={k}
                                className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600"
                              >
                                {k}: {v}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="text"
                            disabled={!row.selected}
                            value={row.channelCode}
                            onChange={(e) =>
                              setSkuDraft({
                                ...skuDraft,
                                [sku.id]: { ...row, channelCode: e.target.value }
                              })
                            }
                            placeholder="例如：SHP-PH-BLK"
                            className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 font-mono-tabular disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="text"
                            disabled={!row.selected}
                            value={row.displayName}
                            onChange={(e) =>
                              setSkuDraft({
                                ...skuDraft,
                                [sku.id]: { ...row, displayName: e.target.value }
                              })
                            }
                            placeholder={sku.name}
                            className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "pdp" && pdp && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-8">
            {pdp.specDiff.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    检测到商品公共规格与当前 PDP 规格存在 {pdp.specDiff.length} 处差异（系统不会自动覆盖文案）
                  </div>
                  <button
                    type="button"
                    onClick={handleImportProductSpecs}
                    className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                  >
                    手动导入商品公共规格
                  </button>
                </div>
                <ul className="mt-2 space-y-1 text-[11px]">
                  {pdp.specDiff.slice(0, 5).map((diff) => (
                    <li key={diff.specKey}>
                      <span className="font-medium">{diff.specKey}</span>：
                      {diff.kind === "added_in_product" &&
                        `商品新增「${diff.productValue}${diff.productUnit ? ` ${diff.productUnit}` : ""}」`}
                      {diff.kind === "changed_in_product" &&
                        `商品为「${diff.productValue}${diff.productUnit ? ` ${diff.productUnit}` : ""}」，草稿为「${diff.pdpValue}${diff.pdpUnit ? ` ${diff.pdpUnit}` : ""}」`}
                      {diff.kind === "only_in_pdp" &&
                        `仅存在于草稿「${diff.pdpValue}${diff.pdpUnit ? ` ${diff.pdpUnit}` : ""}」`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-sm font-semibold text-gray-900">结构化 PDP 文案草稿</h2>
                  <span className="rounded bg-gray-100 px-2 py-0.5 font-mono-tabular text-[11px] text-gray-600">
                    修订 #{pdp.draft.revision}
                  </span>
                  <select
                    value={pdpLang}
                    onChange={(e) => setPdpLang(e.target.value)}
                    className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
                  >
                    {dictionaries?.languages.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard("full", buildFullPdpText())}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {copiedKey === "full" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedKey === "full" ? "已复制整套文案" : "复制整套文案"}
                  </button>
                  {otherSiblings.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setCopyTargetListingId(otherSiblings[0]?.id ?? "");
                        setCopyVersionId("");
                        setCopyKeepTargetLang(true);
                        setCopyPdpOpen(true);
                      }}
                      className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      复制到其他链接
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={savingPdp}
                    onClick={() => void handleSavePdpDraft()}
                    className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {savingPdp ? "保存中..." : "保存草稿"}
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <label className="font-medium text-gray-700">商品标题 (Title)</label>
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono-tabular text-[11px] text-gray-500"
                      title="按 Unicode 码点计数（含泰文音调组合字符与 emoji）"
                    >
                      {titleCodePoints} 字符（Unicode 码点）· {titleUtf8Bytes} B
                    </span>
                    <button
                      type="button"
                      onClick={() => void copyToClipboard("title", pdpContent.title)}
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      {copiedKey === "title" ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={pdpContent.title}
                  onChange={(e) => setPdpContent({ ...pdpContent, title: e.target.value })}
                  placeholder="支持英文 / 泰文 (เช่น แว่นกันแดดแคทอาย UV400) / 中文等多语言 UTF-8 标题"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <label className="font-medium text-gray-700">短描述 (Short Description)</label>
                  <button
                    type="button"
                    onClick={() => void copyToClipboard("short", pdpContent.shortDescription)}
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    {copiedKey === "short" ? "已复制" : "复制"}
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={pdpContent.shortDescription}
                  onChange={(e) =>
                    setPdpContent({ ...pdpContent, shortDescription: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <label className="font-medium text-gray-700">核心卖点 (Bullet Points)</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void copyToClipboard(
                          "bullets",
                          pdpContent.bullets
                            .filter((b) => b.trim())
                            .map((b) => `• ${b}`)
                            .join("\n")
                        )
                      }
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      {copiedKey === "bullets" ? "已复制" : "复制卖点"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPdpContent({ ...pdpContent, bullets: [...pdpContent.bullets, ""] })
                      }
                      className="inline-flex items-center gap-0.5 rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                    >
                      <Plus className="h-3 w-3" />
                      添加卖点
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  {pdpContent.bullets.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
                      暂无卖点，点击右上角「添加卖点」
                    </div>
                  ) : (
                    pdpContent.bullets.map((bullet, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="w-5 text-center font-mono-tabular text-[11px] text-gray-400">
                          {idx + 1}
                        </span>
                        <input
                          type="text"
                          value={bullet}
                          onChange={(e) => {
                            const next = [...pdpContent.bullets];
                            next[idx] = e.target.value;
                            setPdpContent({ ...pdpContent, bullets: next });
                          }}
                          className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setPdpContent({
                              ...pdpContent,
                              bullets: pdpContent.bullets.filter((_, i) => i !== idx)
                            })
                          }
                          className="rounded p-1 text-rose-500 hover:bg-rose-50"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <label className="font-medium text-gray-700">长描述 (Full Description)</label>
                  <button
                    type="button"
                    onClick={() => void copyToClipboard("fullDesc", pdpContent.fullDescription)}
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    {copiedKey === "fullDesc" ? "已复制" : "复制"}
                  </button>
                </div>
                <textarea
                  rows={5}
                  value={pdpContent.fullDescription}
                  onChange={(e) =>
                    setPdpContent({ ...pdpContent, fullDescription: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <label className="font-medium text-gray-700">规格参数表 (Specs)</label>
                  <div className="flex items-center gap-2">
                    {pdp.productSpecs.length > 0 && (
                      <button
                        type="button"
                        onClick={handleImportProductSpecs}
                        className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100"
                      >
                        导入商品公共规格 ({pdp.productSpecs.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setPdpContent({
                          ...pdpContent,
                          specs: [...pdpContent.specs, { specKey: "", specValue: "", unit: "" }]
                        })
                      }
                      className="inline-flex items-center gap-0.5 rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                    >
                      <Plus className="h-3 w-3" />
                      添加规格行
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  {pdpContent.specs.map((spec, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2">
                      <input
                        type="text"
                        placeholder="参数名"
                        value={spec.specKey}
                        onChange={(e) => {
                          const next = [...pdpContent.specs];
                          next[idx] = { ...spec, specKey: e.target.value };
                          setPdpContent({ ...pdpContent, specs: next });
                        }}
                        className="col-span-4 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        type="text"
                        placeholder="参数值"
                        value={spec.specValue}
                        onChange={(e) => {
                          const next = [...pdpContent.specs];
                          next[idx] = { ...spec, specValue: e.target.value };
                          setPdpContent({ ...pdpContent, specs: next });
                        }}
                        className="col-span-5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        type="text"
                        placeholder="单位"
                        value={spec.unit}
                        onChange={(e) => {
                          const next = [...pdpContent.specs];
                          next[idx] = { ...spec, unit: e.target.value };
                          setPdpContent({ ...pdpContent, specs: next });
                        }}
                        className="col-span-2 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setPdpContent({
                            ...pdpContent,
                            specs: pdpContent.specs.filter((_, i) => i !== idx)
                          })
                        }
                        className="col-span-1 flex items-center justify-center rounded text-rose-500 hover:bg-rose-50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <label className="font-medium text-gray-700">包装清单 (Package List)</label>
                    <button
                      type="button"
                      onClick={() => void copyToClipboard("pkg", pdpContent.packageList)}
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      {copiedKey === "pkg" ? "已复制" : "复制"}
                    </button>
                  </div>
                  <textarea
                    rows={3}
                    value={pdpContent.packageList}
                    onChange={(e) =>
                      setPdpContent({ ...pdpContent, packageList: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <label className="font-medium text-gray-700">使用说明 / 注意事项</label>
                    <button
                      type="button"
                      onClick={() => void copyToClipboard("usage", pdpContent.usageInstructions)}
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      {copiedKey === "usage" ? "已复制" : "复制"}
                    </button>
                  </div>
                  <textarea
                    rows={3}
                    value={pdpContent.usageInstructions}
                    onChange={(e) =>
                      setPdpContent({ ...pdpContent, usageInstructions: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <label className="font-medium text-gray-700">SEO 关键词</label>
                    <button
                      type="button"
                      onClick={() => void copyToClipboard("seo", pdpContent.seoKeywords)}
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      {copiedKey === "seo" ? "已复制" : "复制"}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={pdpContent.seoKeywords}
                    onChange={(e) =>
                      setPdpContent({ ...pdpContent, seoKeywords: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">内部备注</label>
                  <input
                    type="text"
                    value={pdpContent.notes}
                    onChange={(e) => setPdpContent({ ...pdpContent, notes: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:col-span-4">
            <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                固化不可变文案版本
              </h3>
              <p className="text-[11px] text-gray-500">
                固化后的版本为只读快照（数据库级禁止修改或删除），可用于发布归档与历史回滚。
              </p>
              <input
                type="text"
                value={freezeNote}
                onChange={(e) => setFreezeNote(e.target.value)}
                placeholder="版本说明（例如：双11泰文首发定稿）"
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={freezingPdp}
                onClick={() => void handleFreezePdpVersion()}
                className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {freezingPdp ? "固化中..." : "保存草稿并固化新版本"}
              </button>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                  <History className="h-4 w-4 text-gray-600" />
                  只读历史版本 ({pdp.versions.length})
                </h3>
              </div>
              {pdp.versions.length === 0 ? (
                <p className="text-xs text-gray-400">尚未固化任何历史版本。</p>
              ) : (
                <div className="space-y-2.5">
                  {pdp.versions.map((ver) => (
                    <div
                      key={ver.id}
                      className="rounded-lg border border-gray-200 bg-gray-50/70 p-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 font-mono-tabular text-[11px] font-semibold text-blue-800">
                            V{ver.versionNo}
                          </span>
                          <span className="font-mono-tabular text-[10px] text-gray-500">
                            {ver.language.toUpperCase()} · {ver.titleCodePoints} 字
                          </span>
                        </div>
                        <span className="font-mono-tabular text-[10px] text-gray-400">
                          {formatDateTime(ver.createdAt)}
                        </span>
                      </div>
                      {ver.note && (
                        <div className="mt-1 text-[11px] font-medium text-gray-700">
                          {ver.note}
                        </div>
                      )}
                      <div className="mt-1 line-clamp-2 text-[11px] text-gray-600">
                        {ver.content.title || "（无标题）"}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setPreviewVersion(ver)}
                          className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-100"
                        >
                          查看全文
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRestorePdpVersion(ver)}
                          className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                        >
                          <RotateCcw className="h-3 w-3" />
                          恢复为新草稿
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  {pickerSkuTarget
                    ? "选择该 SKU 的专属图片版本"
                    : `添加素材版本到「${pickerKind}」素材组`}
                </h2>
                <p className="text-[11px] text-gray-500">
                  直接引用已有素材的当前版本，无需重复上传原文件
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-2.5 text-xs">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPickerSourceTab("product")}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    pickerSourceTab === "product"
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  当前商品素材
                </button>
                <button
                  type="button"
                  onClick={() => setPickerSourceTab("all")}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    pickerSourceTab === "all"
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  全部素材库
                </button>
                {otherSiblings.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPickerSourceTab("sibling")}
                    className={`rounded-md px-2.5 py-1 font-medium ${
                      pickerSourceTab === "sibling"
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    从同商品其他上架链接复用
                  </button>
                )}
              </div>

              {pickerSourceTab !== "sibling" ? (
                <div className="relative w-60">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    placeholder="搜索素材名..."
                    className="w-full rounded-lg border border-gray-200 py-1 pr-2.5 pl-8 text-xs"
                  />
                </div>
              ) : (
                <select
                  value={pickerSiblingId}
                  onChange={(e) => setPickerSiblingId(e.target.value)}
                  className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs"
                >
                  {otherSiblings.map((sib) => (
                    <option key={sib.id} value={sib.id}>
                      {sib.displayName} ({sib.market} {sib.platform})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {pickerLoading ? (
                <div className="py-10 text-center text-xs text-gray-500">正在加载候选素材...</div>
              ) : pickerSourceTab === "sibling" ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {(pickerSiblingSets?.sets[pickerKind].items ?? []).length === 0 ? (
                    <div className="col-span-full py-10 text-center text-xs text-gray-400">
                      该链接的「{pickerKind}」素材组为空
                    </div>
                  ) : (
                    (pickerSiblingSets?.sets[pickerKind].items ?? []).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handlePickVersion(item.assetVersionId)}
                        className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-left hover:border-blue-500"
                      >
                        <div className="aspect-square bg-gray-100">
                          <img
                            src={api.thumbnailUrl(item.assetId, item.assetVersionId)}
                            alt={item.assetName}
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <div className="p-2 text-[11px]">
                          <div className="truncate font-medium text-gray-900">{item.assetName}</div>
                          <div className="font-mono-tabular text-[10px] text-gray-500">
                            固定版本 V{item.versionNo}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              ) : pickerAssets.length === 0 ? (
                <div className="py-10 text-center text-xs text-gray-400">
                  暂无匹配素材。请先在「全部素材」或商品详情页上传素材。
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {pickerAssets.map((asset) => {
                    const reviewMeta = REVIEW_STATUS_META[asset.reviewStatus];
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => handlePickVersion(asset.currentVersionId)}
                        className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-left transition-colors hover:border-blue-500"
                      >
                        <div className="relative aspect-square bg-gray-100">
                          <img
                            src={api.thumbnailUrl(asset.id, asset.currentVersionId)}
                            alt={asset.name}
                            className="h-full w-full object-contain"
                          />
                          <span
                            className={`absolute right-1.5 bottom-1.5 rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewMeta.className}`}
                          >
                            {reviewMeta.label}
                          </span>
                        </div>
                        <div className="p-2 text-[11px]">
                          <div className="truncate font-medium text-gray-900">{asset.name}</div>
                          <div className="mt-0.5 font-mono-tabular text-[10px] text-gray-500">
                            V{asset.versionNo} ·{" "}
                            {asset.width && asset.height
                              ? `${asset.width}×${asset.height}`
                              : formatBytes(asset.sizeBytes)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {previewVersion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  只读历史版本 V{previewVersion.versionNo}（{previewVersion.language.toUpperCase()}）
                </h2>
                <p className="font-mono-tabular text-[11px] text-gray-500">
                  固化时间：{formatDateTime(previewVersion.createdAt)} · {previewVersion.note || "无说明"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewVersion(null)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-5 text-xs">
              <div>
                <div className="text-[11px] font-medium text-gray-500">标题</div>
                <div className="mt-0.5 rounded-lg bg-gray-50 p-2.5 text-sm font-medium text-gray-900">
                  {previewVersion.content.title || "—"}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium text-gray-500">短描述</div>
                <div className="mt-0.5 whitespace-pre-wrap rounded-lg bg-gray-50 p-2.5 text-gray-800">
                  {previewVersion.content.shortDescription || "—"}
                </div>
              </div>
              {previewVersion.content.bullets.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-gray-500">卖点</div>
                  <ul className="mt-0.5 list-disc space-y-1 rounded-lg bg-gray-50 py-2.5 pr-3 pl-7 text-gray-800">
                    {previewVersion.content.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <div className="text-[11px] font-medium text-gray-500">长描述</div>
                <div className="mt-0.5 whitespace-pre-wrap rounded-lg bg-gray-50 p-2.5 text-gray-800">
                  {previewVersion.content.fullDescription || "—"}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
              <button
                type="button"
                onClick={() => setPreviewVersion(null)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => void handleRestorePdpVersion(previewVersion)}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                恢复为新草稿
              </button>
            </div>
          </div>
        </div>
      )}

      {copyPdpOpen && pdp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">复制 PDP 文案到其他上架链接</h2>
              <button
                type="button"
                onClick={() => setCopyPdpOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleCopyPdpToTarget(e)} className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block font-medium text-gray-700">目标上架链接</label>
                <select
                  required
                  value={copyTargetListingId}
                  onChange={(e) => setCopyTargetListingId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  {otherSiblings.map((sib) => (
                    <option key={sib.id} value={sib.id}>
                      {sib.displayName} ({sib.market} {sib.platform} · {sib.language})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">复制来源</label>
                <select
                  value={copyVersionId}
                  onChange={(e) => setCopyVersionId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  <option value="">当前草稿（修订 #{pdp.draft.revision}）</option>
                  {pdp.versions.map((ver) => (
                    <option key={ver.id} value={ver.id}>
                      历史版本 V{ver.versionNo} {ver.note ? `· ${ver.note}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-gray-700">
                <input
                  type="checkbox"
                  checked={copyKeepTargetLang}
                  onChange={(e) => setCopyKeepTargetLang(e.target.checked)}
                />
                保留目标上架链接原本的语言标记
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCopyPdpOpen(false)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={copyingPdp}
                  className="rounded-lg bg-blue-600 px-3.5 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {copyingPdp ? "复制中..." : "确认复制"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dupOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">复制为独立上架草稿</h2>
              <button
                type="button"
                onClick={() => setDupOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleDuplicateCurrent(e)} className="space-y-3 text-xs">
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
                  className="w-full rounded-lg border border-gray-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">目标语言</label>
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
                  onClick={() => setDupOpen(false)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={duplicating}
                  className="rounded-lg bg-blue-600 px-3.5 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {duplicating ? "复制中..." : "创建并跳转"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
