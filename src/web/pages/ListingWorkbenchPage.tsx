import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  PackageCheck,
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
import { api, ApiClientError } from "../api/client";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { useFileDrop } from "../components/FileDropButton";
import { BatchAssetUpload } from "../components/BatchAssetUpload";
import { isUsableSkuImage, mergeUploadBatch, reuseSkuImages, setItemInput, type SetItemInput } from "../components/listingWorkbenchAssetSets";
import { ListingReleasePanel } from "../components/ListingReleasePanel";
import {
  countCodePoints,
  formatAspectRatio,
  formatBytes,
  formatDateTime,
  LISTING_STATUS_META
} from "../utils/format";
import { recordRecentVisit } from "../utils/commandPalette";

const PICKER_PAGE_SIZE = 24;
const ASSET_GROUP_LABELS: Record<AssetSetKind, string> = {
  carousel: "轮播图组", detail: "详情图组", sku: "SKU 图组", video: "视频组"
};
type AssetTarget = { kind: AssetSetKind; assetVersionId?: string; listingSkuId?: string };

function findReplacementTarget(items: AssetSetItemRecord[], original: AssetSetItemRecord) {
  const sameVersion = items.filter((item) => item.assetVersionId === original.assetVersionId);
  return items.find((item) => item.id === original.id)
    ?? (sameVersion.length === 1 && !original.isDuplicateVersion ? sameVersion[0] : undefined);
}

type WorkbenchTab = "assets" | "skus" | "pdp" | "release";

interface SortableCardProps {
  item: AssetSetItemRecord;
  index: number;
  isMainSlot: boolean;
  highlighted: boolean;
  onSetMain: () => void;
  onReplace: () => void;
  onRemove: (id: string) => void;
  onUpgrade: (id: string) => void;
}

function SortableCarouselCard({
  item,
  index,
  isMainSlot,
  highlighted,
  onSetMain,
  onReplace,
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      tabIndex={highlighted ? -1 : undefined}
      data-workbench-target={highlighted || undefined}
      className={`group flex flex-col overflow-hidden rounded-xl border bg-white shadow-xs ${highlighted ? "border-amber-500 ring-2 ring-amber-400" : "border-gray-200"}`}
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
          title="从当前链接移除"
          aria-label={`从当前链接移除 ${item.assetName}`}
          className="absolute top-2 right-2 rounded-md bg-white/90 p-1 text-rose-600 shadow-xs hover:bg-rose-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <div className="absolute right-2 bottom-2 left-2 flex flex-wrap items-center justify-between gap-1">
          <span className="rounded bg-gray-900/75 px-1.5 py-0.5 font-mono-tabular text-[10px] text-white">
            V{item.versionNo}
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
          <div className="flex flex-wrap gap-x-2 text-blue-700">
            {!isMainSlot && <button type="button" onClick={onSetMain} className="hover:underline">设为主图</button>}
            <button type="button" onClick={onReplace} className="hover:underline">原位替换</button>
          </div>
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
  highlighted: boolean;
  previewSelected?: boolean;
  onPreview?: () => void;
  onReplace: () => void;
  onRemove: (id: string) => void;
  onUpgrade: (id: string) => void;
}

function SortableLinearRow({ item, index, highlighted, previewSelected, onPreview, onReplace, onRemove, onUpgrade }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      tabIndex={highlighted ? -1 : undefined}
      data-workbench-target={highlighted || undefined}
      className={`flex flex-wrap items-center gap-3 rounded-xl border bg-white p-2.5 text-xs ${highlighted ? "border-amber-500 ring-2 ring-amber-400" : previewSelected ? "border-blue-500" : "border-gray-200"}`}
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

      <button
        type="button"
        disabled={!onPreview}
        onClick={onPreview}
        aria-label={onPreview ? `在详情预览中定位 ${item.assetName}` : item.assetName}
        className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 enabled:hover:border-blue-500"
      >
        <img src={api.thumbnailUrl(item.assetId, item.assetVersionId)} alt={item.assetName} className="h-full w-full object-contain" />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {onPreview ? (
            <button type="button" onClick={onPreview} className="truncate font-medium text-blue-700 hover:underline">{item.assetName}</button>
          ) : <span className="truncate font-medium text-gray-900">{item.assetName}</span>}
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono-tabular text-[10px] text-gray-700">
            V{item.versionNo}
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
        <button type="button" onClick={onReplace} className="rounded-md border border-blue-200 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-50">原位替换</button>
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
          title="从当前链接移除"
          aria-label={`从当前链接移除 ${item.assetName}`}
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
  return <ListingWorkbench key={id} id={id} />;
}

function parseWorkbenchTab(raw: string | null): WorkbenchTab | null {
  if (raw === "assets" || raw === "skus" || raw === "pdp" || raw === "release") {
    return raw;
  }
  return null;
}

function ListingWorkbench({ id }: { id?: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeTab = parseWorkbenchTab(searchParams.get("tab"));
  const routeGroup = searchParams.get("assetGroup");
  const routeMissingSku = searchParams.get("missingSku") === "1";

  const [activeTab, setActiveTab] = useState<WorkbenchTab>(() => {
    if (routeTab && routeTab !== "assets") return routeTab;
    return "assets";
  });
  const [activeSetKind, setActiveSetKind] = useState<AssetSetKind>(() => {
    if (routeGroup === "carousel" || routeGroup === "detail" || routeGroup === "sku" || routeGroup === "video") {
      return routeGroup;
    }
    return routeMissingSku ? "sku" : "carousel";
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

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
  const writeLock = useRef(false);
  const [upload, setUpload] = useState<{ kind: "carousel" | "detail"; initialFiles?: File[]; batchVersions: Set<string> } | null>(null);
  const [selectedSkuIds, setSelectedSkuIds] = useState<string[]>([]);
  const [missingSkuOnly, setMissingSkuOnly] = useState(false);
  const [fixTarget, setFixTarget] = useState<AssetTarget | null>(null);
  const [detailPreviewId, setDetailPreviewId] = useState<string | null>(null);
  const detailPreviewRef = useRef<HTMLDivElement>(null);
  const [mobilePreviewWidth, setMobilePreviewWidth] = useState(true);

  // Asset Picker Modal (also supports SKU target and cross-listing reuse)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<AssetSetKind>("carousel");
  const [pickerSkuTargets, setPickerSkuTargets] = useState<string[]>([]);
  const [pickerReplaceItem, setPickerReplaceItem] = useState<AssetSetItemRecord | null>(null);
  const [pickerSelected, setPickerSelected] = useState<Array<{ id: string; name: string }>>([]);
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerTotal, setPickerTotal] = useState(0);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerSourceTab, setPickerSourceTab] = useState<"product" | "all" | "sibling">("product");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerAssets, setPickerAssets] = useState<AssetListItem[]>([]);
  const [pickerSiblingId, setPickerSiblingId] = useState("");
  const [pickerSiblingSets, setPickerSiblingSets] = useState<ListingAssetSetsResponse | null>(null);
  const [pickerSibling, setPickerSibling] = useState<ListingDetail | null>(null);
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
      recordRecentVisit({
        kind: "listing",
        title: detailRes.displayName,
        subtitle: `${detailRes.storeName} · ${detailRes.productSpu}`,
        to: `/listings/${detailRes.id}`
      });
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

  useEffect(() => {
    const group = routeGroup === "carousel" || routeGroup === "detail" || routeGroup === "sku" || routeGroup === "video"
      ? routeGroup
      : routeMissingSku ? "sku" : null;
    setMissingSkuOnly(group === "sku" && routeMissingSku);
    if (routeTab && routeTab !== "assets") {
      setActiveTab(routeTab);
      return;
    }
    if (group) {
      setActiveTab("assets");
      setActiveSetKind(group);
      setFixTarget(null);
      return;
    }
    if (routeTab === "assets") {
      setActiveTab("assets");
    }
  }, [routeTab, routeGroup, routeMissingSku]);

  const handleTabChange = useCallback(
    (nextTab: WorkbenchTab) => {
      setActiveTab(nextTab);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", nextTab);
      if (nextTab !== "assets") {
        nextParams.delete("assetGroup");
        nextParams.delete("missingSku");
      }
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  useEffect(() => {
    if (!fixTarget || activeTab !== "assets" || activeSetKind !== fixTarget.kind) return;
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('[data-workbench-target="true"]')
        ?? document.getElementById(`workbench-group-${fixTarget.kind}`);
      target?.scrollIntoView({ block: "nearest" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [fixTarget, activeTab, activeSetKind, assetSets]);

  const jumpToDetailPreview = useCallback((itemId: string, focus = true) => {
    setDetailPreviewId(itemId);
    const preview = detailPreviewRef.current;
    const image = document.getElementById(`workbench-preview-${itemId}`);
    if (preview && image) {
      preview.scrollTop += image.getBoundingClientRect().top - preview.getBoundingClientRect().top;
      if (focus) {
        preview.scrollIntoView({ block: "nearest" });
        preview.focus({ preventScroll: true });
      }
    }
  }, []);

  useEffect(() => {
    if (detailPreviewId && activeTab === "assets" && activeSetKind === "detail") {
      jumpToDetailPreview(detailPreviewId, false);
    }
  }, [detailPreviewId, activeTab, activeSetKind, jumpToDetailPreview]);

  const handleFixAsset = (target: AssetTarget) => {
    setActiveTab("assets");
    setActiveSetKind(target.kind);
    setMissingSkuOnly(target.kind === "sku" && !target.listingSkuId && !target.assetVersionId);
    setFixTarget(target);
    if (target.kind === "detail" && target.assetVersionId) {
      setDetailPreviewId(assetSets?.sets.detail.items.find((item) => item.assetVersionId === target.assetVersionId)?.id ?? null);
    }
    if (searchParams.get("tab") && searchParams.get("tab") !== "assets") {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", "assets");
      nextParams.delete("assetGroup");
      nextParams.delete("missingSku");
      setSearchParams(nextParams, { replace: true });
    }
  };

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

  const writeSet = async (
    kind: AssetSetKind,
    buildItems: (current: AssetSetItemRecord[]) => SetItemInput[],
    successMsg: string
  ) => {
    if (!id || writeLock.current) throw new Error("素材或 SKU 映射正在保存，请稍后重试");
    writeLock.current = true;
    setSavingSet(true);
    setError(null);
    try {
      const latest = await api.getListingAssetSets(id);
      setAssetSets(latest);
      const current = latest.sets[kind].items;
      const next = buildItems(current);
      if (next.length > 200) throw new Error("每个素材组最多可保存 200 项");
      const unchanged = current.length === next.length && current.every((item, index) =>
        item.assetVersionId === next[index]?.assetVersionId && item.listingSkuId === next[index]?.listingSkuId
      );
      if (!unchanged) {
        setAssetSets(await api.replaceListingAssetSet(id, kind, next, current.map((item) => item.id)));
      }
      flashNotice(successMsg);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        const refreshed = await api.getListingAssetSets(id).catch(() => null);
        if (refreshed) setAssetSets(refreshed);
      }
      throw error;
    } finally {
      writeLock.current = false;
      setSavingSet(false);
    }
  };

  const saveSet = async (...args: Parameters<typeof writeSet>) => {
    try {
      await writeSet(...args);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存素材组失败");
      return false;
    }
  };

  const currentSetItems = useMemo(() => assetSets?.sets[activeSetKind].items ?? [], [assetSets, activeSetKind]);

  const editSetItem = (
    kind: AssetSetKind,
    itemId: string,
    edit: (items: AssetSetItemRecord[], index: number) => SetItemInput[],
    message: string
  ) => saveSet(kind, (items) => {
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error("素材组已更新，请确认当前内容后重试");
    return edit(items, index);
  }, message);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || writeLock.current) return;
    void editSetItem(activeSetKind, String(active.id), (items, index) => {
      const destination = items.findIndex((item) => item.id === over.id);
      if (destination < 0) throw new Error("素材组已更新，请重新排序");
      return arrayMove(items, index, destination).map(setItemInput);
    }, "已更新素材组排序");
  };

  const handleRemoveSetItem = (kind: AssetSetKind, itemId: string) => {
    void editSetItem(kind, itemId, (items, index) => items.filter((_, i) => i !== index).map(setItemInput), "已从当前链接移除图片或视频引用");
  };

  const handleUpgradeSetItem = (kind: AssetSetKind, itemId: string) => {
    const version = assetSets?.sets[kind].items.find((item) => item.id === itemId)?.latestVersionId;
    if (!version) return;
    void editSetItem(kind, itemId, (items, index) => items.map((item, i) => ({
      ...setItemInput(item), assetVersionId: i === index ? version : item.assetVersionId
    })), "已升级该条目的固定素材版本");
  };

  const imageUploadKind = activeSetKind === "carousel" || activeSetKind === "detail" ? activeSetKind : null;
  const uploadDisabled = savingSet || savingSkus || !!upload;
  const beginUpload = (initialFiles?: File[]) => {
    if (!imageUploadKind || writeLock.current || uploadDisabled) return;
    setError(null);
    setUpload({ kind: imageUploadKind, initialFiles, batchVersions: new Set() });
  };
  const { draggingOver: draggingOverUpload, dropProps: uploadDropProps } = useFileDrop(
    beginUpload,
    uploadDisabled || !imageUploadKind
  );

  const bindUpload = async (versions: string[], mainVersion?: string) => {
    if (!upload) return;
    let addedVersions: string[] = [];
    await writeSet(upload.kind, (items) => {
      const existing = new Set(items.map((item) => item.assetVersionId));
      const next = mergeUploadBatch(items, versions, upload.batchVersions, mainVersion);
      addedVersions = next.map((item) => item.assetVersionId).filter((version) => !existing.has(version));
      return next;
    }, "已将上传的图片加入图组");
    setUpload({ ...upload, batchVersions: new Set([...upload.batchVersions, ...addedVersions]) });
  };

  const openPicker = (kind: AssetSetKind, skuTargets: string[] = [], replaceItem: AssetSetItemRecord | null = null, source: "product" | "sibling" = "product") => {
    if (writeLock.current) return;
    setPickerKind(kind);
    setPickerSkuTargets(skuTargets);
    setPickerReplaceItem(replaceItem);
    setPickerSourceTab(source);
    setPickerQuery("");
    setPickerPage(1);
    setPickerSelected([]);
    setPickerError(null);
    setPickerLoading(true);
    setPickerSiblingId(siblings.find((sibling) => sibling.id === pickerSiblingId && sibling.id !== id)?.id
      ?? siblings.find((sibling) => sibling.id !== id)?.id ?? "");
    setPickerOpen(true);
  };

  const pickerProductId = listing?.productId;
  useEffect(() => {
    if (!pickerOpen || !pickerProductId) return;
    let cancelled = false;
    setPickerLoading(true);
    setPickerError(null);
    setPickerSiblingSets(null);
    setPickerSibling(null);
    const load = async () => {
      try {
        if (pickerSourceTab === "sibling") {
          if (!pickerSiblingId) return;
          const [sets, sibling] = await Promise.all([
            api.getListingAssetSets(pickerSiblingId),
            api.getListing(pickerSiblingId)
          ]);
          if (!cancelled) {
            setPickerSiblingSets(sets);
            setPickerSibling(sibling);
          }
        } else {
          const result = await api.listAssets({
            productId: pickerSourceTab === "product" ? pickerProductId : undefined,
            q: pickerQuery.trim() || undefined,
            type: pickerKind === "video" ? "video" : "image",
            page: pickerPage,
            pageSize: PICKER_PAGE_SIZE
          });
          if (!cancelled) {
            setPickerAssets(result.items);
            setPickerTotal(result.total);
            if (pickerPage > 1 && (pickerPage - 1) * PICKER_PAGE_SIZE >= result.total) {
              setPickerPage(Math.max(1, Math.ceil(result.total / PICKER_PAGE_SIZE)));
            }
          }
        }
      } catch (error) {
        if (!cancelled) setPickerError(error instanceof Error ? error.message : "加载素材失败");
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [pickerOpen, pickerProductId, pickerSourceTab, pickerQuery, pickerKind, pickerSiblingId, pickerPage]);

  const togglePickerVersion = (id: string, name: string) => {
    setPickerSelected((current) => current.some((item) => item.id === id) ? current.filter((item) => item.id !== id)
      : pickerKind === "sku" || pickerReplaceItem ? [{ id, name }] : [...current, { id, name }]);
  };

  const finishPickerWrite = async (...args: Parameters<typeof writeSet>) => {
    if (writeLock.current) return;
    setPickerError(null);
    try {
      await writeSet(...args);
      setPickerOpen(false);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : "保存素材组失败");
    }
  };

  const applyPickerSelection = () => {
    const [first] = pickerSelected;
    if (!first) return;
    void finishPickerWrite(pickerKind, (current) => {
      if (pickerKind === "sku") {
        const targets = new Set(pickerSkuTargets);
        return [
          ...current.filter((item) => !item.listingSkuId || !targets.has(item.listingSkuId)).map(setItemInput),
          ...pickerSkuTargets.map((listingSkuId) => ({ assetVersionId: first.id, listingSkuId }))
        ];
      }
      if (pickerReplaceItem) {
        const target = findReplacementTarget(current, pickerReplaceItem);
        if (!target) throw new Error("无法在最新图组确认原条目，请重新选择替换位置");
        return current.map((item) => ({ ...setItemInput(item), assetVersionId: item.id === target.id ? first.id : item.assetVersionId }));
      }
      const existing = new Set(current.map((item) => item.assetVersionId));
      return [...current.map(setItemInput), ...pickerSelected.filter((item) => !existing.has(item.id))
        .map((item) => ({ assetVersionId: item.id, listingSkuId: null }))];
    }, pickerKind === "sku" ? `已为 ${pickerSkuTargets.length} 个 SKU 应用同一图片版本` : pickerReplaceItem ? "已在原位置替换素材" : "已加入已选素材版本");
  };

  const handleReuseGroup = (overwrite = false) => {
    if (!pickerSiblingSets || !pickerSibling || !listing || !assetSets || pickerSibling.productId !== listing.productId) return;
    const source = pickerSiblingSets.sets[pickerKind].items;
    const current = assetSets.sets[pickerKind].items;
    if (!source.length || pickerReplaceItem || (pickerKind === "sku" && pickerSkuTargets.length > 0)) return;
    const apply = (requireUnchanged: boolean) => finishPickerWrite(pickerKind, (latest) => {
      if (requireUnchanged && (latest.length !== current.length || latest.some((item, index) => item.id !== current[index]?.id))) {
        throw new Error("目标素材组在确认前已更新，请检查后重新确认");
      }
      if (pickerKind === "sku") {
        const reused = reuseSkuImages(pickerSibling.skus, source, listing.skus, latest, overwrite);
        if (reused.length === latest.length && reused.every((item, index) =>
          item.assetVersionId === latest[index]?.assetVersionId && item.listingSkuId === latest[index]?.listingSkuId
        )) {
          throw new Error(overwrite ? "没有需要更新图片的匹配 SKU" : "没有可补图的匹配 SKU");
        }
        return reused;
      }
      return source.map(setItemInput);
    }, pickerKind === "sku" ? "已按商品 SKU 匹配复用图片" : "已按原顺序复用整组固定版本");
    if (pickerKind === "sku" ? overwrite : current.length > 0) {
      setConfirmDialog({
        title: pickerKind === "sku" ? "覆盖匹配 SKU 的图片" : `替换当前${ASSET_GROUP_LABELS[pickerKind]}`,
        description: pickerKind === "sku" ? "按商品 SKU 匹配。已有图片的匹配项将换为来源链接的固定版本，未匹配项保留。"
          : `当前组的 ${current.length} 项引用将替换为来源链接的 ${source.length} 项，沿用来源顺序。`,
        confirmLabel: "确认覆盖",
        tone: "warning",
        onConfirm: async () => {
          setConfirmBusy(true);
          await apply(true);
          setConfirmBusy(false);
          setConfirmDialog(null);
        }
      });
    } else if (pickerKind === "sku") {
      void apply(false);
    } else {
      void apply(true);
    }
  };

  const handleSaveSkuBindings = () => {
    if (!id || !product || writeLock.current) return;
    const items = product.skus.flatMap((sku) => {
      const draft = skuDraft[sku.id];
      return draft?.selected ? [{
        skuId: sku.id,
        channelCode: draft.channelCode.trim(),
        displayName: draft.displayName.trim()
      }] : [];
    });
    const selected = new Set(items.map((item) => item.skuId));
    const unbinding = (currentListing: ListingDetail, sets: ListingAssetSetsResponse) => {
      const pictured = new Set(sets.sets.sku.items.map((item) => item.listingSkuId));
      return currentListing.skus.filter((sku) => !selected.has(sku.skuId) && pictured.has(sku.id));
    };
    const save = async (confirmed: string[] = []) => {
      if (writeLock.current) return;
      writeLock.current = true;
      setSavingSkus(true);
      setError(null);
      try {
        const [latestListing, latestSets] = await Promise.all([api.getListing(id), api.getListingAssetSets(id)]);
        const impacted = unbinding(latestListing, latestSets);
        if (impacted.some((sku) => !confirmed.includes(sku.id))) {
          setListing(latestListing);
          setAssetSets(latestSets);
          showConfirmation(impacted);
          return;
        }
        const updated = await api.syncListingSkus(id, items);
        setListing(updated);
        setAssetSets(await api.getListingAssetSets(id));
        setSelectedSkuIds((current) => current.filter((skuId) => updated.skus.some((sku) => sku.id === skuId)));
        setConfirmDialog(null);
        flashNotice(`已更新当前上架链接的 ${items.length} 个 SKU 映射`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存 SKU 映射失败");
      } finally {
        writeLock.current = false;
        setSavingSkus(false);
      }
    };
    const showConfirmation = (impacted: ListingDetail["skus"]) => setConfirmDialog({
      title: "确认移除有图的上架 SKU",
      description: `以下 ${impacted.length} 个 SKU 将从本链接移除，同时解除 SKU 图引用：${impacted.map((sku) => sku.skuCode).join("、")}。`,
      confirmLabel: "移除 SKU 并解除图片引用",
      tone: "warning",
      onConfirm: async () => {
        setConfirmBusy(true);
        await save(impacted.map((sku) => sku.id));
        setConfirmBusy(false);
      }
    });
    const impacted = listing && assetSets ? unbinding(listing, assetSets) : [];
    if (impacted.length) showConfirmation(impacted);
    else void save();
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

  const handleRestorePdpVersion = (ver: PdpVersionRecord) => {
    if (!id) return;
    setConfirmDialog({
      title: `恢复历史版本 V${ver.versionNo}`,
      description: `确认将历史版本 V${ver.versionNo} 恢复为新的当前草稿吗？原有历史版本保持只读不被覆盖。`,
      confirmLabel: "恢复为草稿",
      tone: "warning",
      onConfirm: async () => {
        setConfirmBusy(true);
        setError(null);
        try {
          const restored = await api.restoreListingPdpVersion(id, ver.id);
          setPdp(restored);
          setPdpLang(restored.draft.language);
          setPdpContent(restored.draft.content);
          setPreviewVersion(null);
          setConfirmDialog(null);
          flashNotice(`已将 V${ver.versionNo} 恢复为当前草稿（修订 #${restored.draft.revision}）`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "恢复 PDP 版本失败");
        } finally {
          setConfirmBusy(false);
        }
      }
    });
  };

  const handleImportProductSpecs = () => {
    if (!pdp || pdp.productSpecs.length === 0) return;
    const applySpecs = () => {
      setPdpContent({
        ...pdpContent,
        specs: pdp.productSpecs.map((s) => ({ ...s }))
      });
      flashNotice("已从商品公共规格导入到草稿，请确认后点击「保存草稿」");
    };
    if (pdpContent.specs.length > 0) {
      setConfirmDialog({
        title: "导入商品公共规格",
        description: "确认用商品当前公共规格覆盖草稿中的规格表吗？（未保存草稿前仍可放弃修改）",
        confirmLabel: "覆盖规格表",
        tone: "warning",
        onConfirm: () => {
          applySpecs();
          setConfirmDialog(null);
        }
      });
      return;
    }
    applySpecs();
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
  const isFixItem = (item: AssetSetItemRecord) => fixTarget?.kind === item.kind
    && !!fixTarget.assetVersionId && fixTarget.assetVersionId === item.assetVersionId;
  const skuItems = assetSets?.sets.sku.items ?? [];
  const picturedSkuIds = new Set(skuItems.filter(isUsableSkuImage).map((item) => item.listingSkuId));
  const coveredSkuCount = listing.skus.filter((sku) => picturedSkuIds.has(sku.id)).length;
  const visibleSkus = listing.skus.filter((sku) => !missingSkuOnly || !picturedSkuIds.has(sku.id));
  const visibleSkuIds = new Set(visibleSkus.map((sku) => sku.id));
  const allVisibleSkusSelected = visibleSkus.length > 0 && visibleSkus.every((sku) => selectedSkuIds.includes(sku.id));
  const isFixSku = (skuId: string) => fixTarget?.kind === "sku" && (fixTarget.listingSkuId
    ? skuId === fixTarget.listingSkuId
    : skuItems.some((item) => item.listingSkuId === skuId && isFixItem(item)));
  const hasFixItem = activeSetKind === "sku" ? visibleSkus.some((sku) => isFixSku(sku.id)) : currentSetItems.some(isFixItem);
  const highlightGroup = fixTarget?.kind === activeSetKind && !hasFixItem;
  const skuReuseOnly = pickerKind === "sku" && pickerSkuTargets.length === 0;
  const pickerPages = Math.max(1, Math.ceil(pickerTotal / PICKER_PAGE_SIZE));
  const siblingItems = pickerSiblingSets?.sets[pickerKind].items ?? [];
  const selectedVersions = new Set(pickerSelected.map((item) => item.id));
  const replacementItems = assetSets?.sets[pickerKind].items ?? [];
  const replacementTarget = pickerReplaceItem && findReplacementTarget(replacementItems, pickerReplaceItem);
  const needsReplacementTarget = !!pickerReplaceItem && !replacementTarget;

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
          onClick={() => handleTabChange("assets")}
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
          onClick={() => handleTabChange("skus")}
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
          onClick={() => handleTabChange("pdp")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium ${
            activeTab === "pdp"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <FileText className="h-4 w-4" />
          PDP 多语言文案 ({pdp?.versions.length ?? 0} 个历史版本)
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("release")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium ${
            activeTab === "release"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <PackageCheck className="h-4 w-4" />
          检查与发布
        </button>
      </div>

      {activeTab === "assets" && assetSets && (
        <div
          id={`workbench-group-${activeSetKind}`}
          tabIndex={-1}
          className={`space-y-4 scroll-mt-20 ${highlightGroup ? "rounded-xl ring-2 ring-amber-400 ring-offset-4" : ""}`}
        >
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
                  onClick={() => {
                    setActiveSetKind(tabItem.kind);
                    setFixTarget(null);
                  }}
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
                  <span className="text-xs text-blue-600">正在保存素材组...</span>
                )}
                {imageUploadKind && (
                  <button
                    {...uploadDropProps}
                    type="button"
                    aria-haspopup="dialog"
                    disabled={uploadDisabled}
                    onClick={() => beginUpload()}
                    className={`rounded-lg border border-dashed px-3 py-1.5 text-xs font-medium text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 ${
                      draggingOverUpload ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/40"
                    }`}
                  >
                    上传到{ASSET_GROUP_LABELS[imageUploadKind]}
                  </button>
                )}
                <button
                  type="button"
                  disabled={savingSet || savingSkus}
                  onClick={() => openPicker(activeSetKind)}
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
                          highlighted={isFixItem(item)}
                          onSetMain={() => void editSetItem("carousel", item.id, (items, index) => arrayMove(items, index, 0).map(setItemInput), "已设为主图")}
                          onReplace={() => openPicker("carousel", [], item)}
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
                            highlighted={isFixItem(item)}
                            previewSelected={detailPreviewId === item.id}
                            onPreview={() => jumpToDetailPreview(item.id)}
                            onReplace={() => openPicker("detail", [], item)}
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
                  <div ref={detailPreviewRef} tabIndex={-1} aria-label="详情图预览" className="max-h-[680px] overflow-y-auto rounded-xl border border-gray-200 bg-gray-100 p-3">
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
                          <div key={item.id} id={`workbench-preview-${item.id}`} className="relative">
                            <img
                              src={api.contentUrl(item.assetId, item.assetVersionId, true)}
                              alt={`详情图 #${idx + 1} ${item.assetName}`}
                              className="block h-auto w-full"
                              width={item.width ?? undefined}
                              height={item.height ?? undefined}
                              loading="lazy"
                            />
                            {detailPreviewId === item.id && <span aria-hidden="true" className="pointer-events-none absolute inset-0 ring-4 ring-inset ring-blue-500" />}
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
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 p-3 text-xs">
                <span className="font-medium">SKU 图覆盖率 {coveredSkuCount}/{listing.skus.length}（{listing.skus.length ? Math.round(100 * coveredSkuCount / listing.skus.length) : 0}%）</span>
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={missingSkuOnly} onChange={(event) => setMissingSkuOnly(event.target.checked)} />
                  只看缺图
                </label>
                <button
                  type="button"
                  disabled={!selectedSkuIds.length || savingSet || savingSkus}
                  onClick={() => openPicker("sku", selectedSkuIds)}
                  className="rounded-md border border-blue-200 px-2.5 py-1 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                >
                  批量选图（已选 {selectedSkuIds.length}）
                </button>
                {selectedSkuIds.length > 0 && <button type="button" onClick={() => setSelectedSkuIds([])} className="text-gray-600 hover:underline">清空已选 SKU</button>}
                <button
                  type="button"
                  disabled={!otherSiblings.length || !listing.skus.length || savingSet || savingSkus}
                  onClick={() => openPicker("sku", [], null, "sibling")}
                  className="rounded-md border border-blue-200 px-2.5 py-1 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                >
                  按商品 SKU 复用图片
                </button>
                <button
                  type="button"
                  disabled={savingSet || savingSkus}
                  onClick={() => handleTabChange("skus")}
                  className="ml-auto rounded-md px-2.5 py-1 text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  管理上架 SKU
                </button>
              </div>
              {listing.skus.length === 0 ? (
                <div className="p-10 text-center text-xs text-gray-500">
                  当前上架链接尚未绑定任何 SKU。请先切换到「SKU 绑定与渠道映射」勾选要上架的 SKU。
                </div>
              ) : visibleSkus.length === 0 ? (
                <div className="p-10 text-center text-xs text-gray-500">当前上架链接的 SKU 均已配图。</div>
              ) : (
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="border-b border-gray-200 bg-gray-50 text-gray-600">
                    <tr>
                      <th className="py-3 pl-4">
                        <input
                          type="checkbox"
                          aria-label="全选当前可见 SKU"
                          checked={allVisibleSkusSelected}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelectedSkuIds((current) => checked ? [...new Set([...current, ...visibleSkuIds])] : current.filter((skuId) => !visibleSkuIds.has(skuId)));
                          }}
                        />
                      </th>
                      <th className="px-4 py-3 font-medium">商品 SKU</th>
                      <th className="px-4 py-3 font-medium">渠道 SKU 编码 / 展示名</th>
                      <th className="px-4 py-3 font-medium">已绑定图片版本</th>
                      <th className="px-4 py-3 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibleSkus.map((lsku) => {
                      const matches = skuItems.filter((item) => item.listingSkuId === lsku.id);
                      const boundItem = matches.find(isFixItem) ?? matches.find(isUsableSkuImage) ?? matches[0];
                      const highlighted = isFixSku(lsku.id);
                      return (
                        <tr
                          key={lsku.id}
                          tabIndex={highlighted ? -1 : undefined}
                          data-workbench-target={highlighted || undefined}
                          className={highlighted ? "bg-amber-50 outline-2 -outline-offset-2 outline-amber-400" : "hover:bg-gray-50/60"}
                        >
                          <td className="pl-4">
                            <input
                              type="checkbox"
                              aria-label={`选择 SKU ${lsku.skuCode}`}
                              checked={selectedSkuIds.includes(lsku.id)}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setSelectedSkuIds((current) => checked ? [...current, lsku.id] : current.filter((skuId) => skuId !== lsku.id));
                              }}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-mono-tabular font-medium text-gray-900">
                              {lsku.skuCode}
                            </div>
                            <div className="text-[11px] text-gray-500">{lsku.skuName}</div>
                            <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-600">
                              {Object.entries(lsku.skuAttributes).map(([label, value]) => (
                                <span key={label}>{label} · {value}</span>
                              ))}
                            </div>
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
                                    {boundItem.assetDeleted && <span className="text-rose-700">素材已删除</span>}
                                    {boundItem.assetType !== "image" && <span className="text-rose-700">非图片素材</span>}
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
                                onClick={() => openPicker("sku", [lsku.id])}
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
                          highlighted={isFixItem(item)}
                          onReplace={() => openPicker("video", [], item)}
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

      {activeTab === "release" && <ListingReleasePanel listing={listing} onFixAsset={handleFixAsset} />}

      {upload && (
        <BatchAssetUpload
          dialogTitle={`上传到${ASSET_GROUP_LABELS[upload.kind]}`}
          initialFiles={upload.initialFiles}
          group={{ kind: upload.kind, productId: listing.productId, onBind: bindUpload }}
          onClose={() => setUpload(null)}
        />
      )}

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="workbench-picker-title" className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
              <div>
                <h2 id="workbench-picker-title" className="text-sm font-semibold text-gray-900">
                  {skuReuseOnly ? "按商品 SKU 复用图片"
                    : pickerSkuTargets.length > 1 ? `为 ${pickerSkuTargets.length} 个 SKU 选择同一图片版本`
                    : pickerSkuTargets.length ? "选择该 SKU 的专属图片版本"
                    : pickerReplaceItem ? `原位替换 ${pickerReplaceItem.assetName}`
                    : `添加 / 复用${ASSET_GROUP_LABELS[pickerKind]}素材版本`}
                </h2>
              </div>
              <button
                type="button"
                aria-label="关闭选图"
                disabled={savingSet}
                onClick={() => setPickerOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                {!skuReuseOnly && <>
                <button
                  type="button"
                  disabled={savingSet}
                  onClick={() => { setPickerPage(1); setPickerSourceTab("product"); }}
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
                  disabled={savingSet}
                  onClick={() => { setPickerPage(1); setPickerSourceTab("all"); }}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    pickerSourceTab === "all"
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  全部素材库
                </button>
                </>}
                {otherSiblings.length > 0 && (
                  <button
                    type="button"
                    disabled={savingSet}
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
                    disabled={savingSet}
                    aria-label="搜索素材名"
                    onChange={(e) => { setPickerPage(1); setPickerQuery(e.target.value); }}
                    placeholder="搜索素材名..."
                    className="w-full rounded-lg border border-gray-200 py-1 pr-2.5 pl-8 text-xs"
                  />
                </div>
              ) : (
                <select
                  value={pickerSiblingId}
                  aria-label="来源上架链接"
                  disabled={savingSet}
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
                  {siblingItems.length === 0 ? (
                    <div className="col-span-full py-10 text-center text-xs text-gray-400">
                      该链接的{ASSET_GROUP_LABELS[pickerKind]}为空
                    </div>
                  ) : (
                    siblingItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={savingSet || skuReuseOnly || item.assetDeleted || (pickerKind === "sku" && !isUsableSkuImage(item))}
                        aria-pressed={skuReuseOnly ? undefined : selectedVersions.has(item.assetVersionId)}
                        onClick={() => togglePickerVersion(item.assetVersionId, item.assetName)}
                        className={`flex flex-col overflow-hidden rounded-xl border bg-white text-left enabled:hover:border-blue-500 ${selectedVersions.has(item.assetVersionId) ? "border-blue-600 ring-2 ring-blue-400" : "border-gray-200"}`}
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
                            固定版本 V{item.versionNo}{item.skuCode ? ` · ${item.skuCode}` : ""}{item.assetDeleted ? " · 已删除" : ""}
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
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        disabled={savingSet}
                        aria-pressed={selectedVersions.has(asset.currentVersionId)}
                        onClick={() => togglePickerVersion(asset.currentVersionId, asset.name)}
                        className={`flex flex-col overflow-hidden rounded-xl border bg-white text-left enabled:hover:border-blue-500 ${selectedVersions.has(asset.currentVersionId) ? "border-blue-600 ring-2 ring-blue-400" : "border-gray-200"}`}
                      >
                        <div className="relative aspect-square bg-gray-100">
                          <img
                            src={api.thumbnailUrl(asset.id, asset.currentVersionId)}
                            alt={asset.name}
                            className="h-full w-full object-contain"
                          />
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
            {pickerSourceTab !== "sibling" && (
              <nav aria-label="选图分页" className="flex items-center justify-center gap-4 border-t border-gray-100 px-5 py-2 text-xs">
                <button type="button" disabled={pickerPage <= 1 || pickerLoading || savingSet} onClick={() => setPickerPage((page) => page - 1)} className="text-blue-700 disabled:opacity-40">上一页</button>
                <span>第 {pickerPage} / {pickerPages} 页 · 共 {pickerTotal} 项</span>
                <button type="button" disabled={pickerPage >= pickerPages || pickerLoading || savingSet} onClick={() => setPickerPage((page) => page + 1)} className="text-blue-700 disabled:opacity-40">下一页</button>
              </nav>
            )}
            <div className="space-y-2 border-t border-gray-100 px-5 py-3 text-xs">
              {pickerError && <p role="alert" className="text-rose-700">{pickerError}</p>}
              {needsReplacementTarget && (
                <label className="flex flex-wrap items-center gap-2">
                  重新选择替换位置
                  <select
                    value=""
                    disabled={savingSet || !replacementItems.length}
                    onChange={(event) => {
                      const target = replacementItems.find((item) => item.id === event.target.value);
                      if (target) {
                        setPickerReplaceItem(target);
                        setPickerError(null);
                      }
                    }}
                    className="rounded-md border border-gray-200 px-2 py-1"
                  >
                    <option value="" disabled>{replacementItems.length ? "请选择当前图组条目" : "当前图组已空"}</option>
                    {replacementItems.map((item, index) => <option key={item.id} value={item.id}>#{index + 1} · {item.assetName} · V{item.versionNo}</option>)}
                  </select>
                </label>
              )}
              {pickerSelected.length > 0 && (
                <ul aria-label="已选素材" className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                  {pickerSelected.map((item) => (
                    <li key={item.id}>
                      <button type="button" disabled={savingSet} onClick={() => togglePickerVersion(item.id, item.name)} aria-label={`取消选择 ${item.name}`} className="rounded bg-blue-50 px-2 py-1 text-blue-700">{item.name} ×</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" disabled={savingSet} onClick={() => setPickerOpen(false)} className="rounded-md border border-gray-200 px-3 py-1.5 disabled:opacity-50">取消</button>
                {!skuReuseOnly && (
                  <button type="button" disabled={savingSet || !pickerSelected.length || needsReplacementTarget} onClick={applyPickerSelection} className="rounded-md bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50">
                    {pickerReplaceItem ? "确认替换" : pickerSkuTargets.length ? "确认应用图片" : `确认添加（${pickerSelected.length}）`}
                  </button>
                )}
                {pickerSourceTab === "sibling" && !pickerReplaceItem && !pickerSkuTargets.length && (
                  <>
                    <button type="button" disabled={pickerLoading || savingSet || !siblingItems.length} onClick={() => handleReuseGroup()} className="rounded-md border border-blue-200 px-3 py-1.5 text-blue-700 disabled:opacity-50">
                      {skuReuseOnly ? "仅补齐缺图 SKU" : "复用整组"}
                    </button>
                    {skuReuseOnly && <button type="button" disabled={pickerLoading || savingSet || !siblingItems.length} onClick={() => handleReuseGroup(true)} className="rounded-md border border-amber-200 px-3 py-1.5 text-amber-800 disabled:opacity-50">覆盖匹配 SKU 的图片</button>}
                  </>
                )}
              </div>
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

      <ConfirmDialog
        dialog={confirmDialog}
        busy={confirmBusy}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}
