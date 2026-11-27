import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BookOpen,
  Clock,
  Compass,
  CornerDownLeft,
  FileArchive,
  FileText,
  Film,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Images,
  Inbox,
  Layers,
  LayoutDashboard,
  Loader2,
  Package,
  Plus,
  Search,
  Settings,
  Sliders,
  Star,
  Store,
  Trash2,
  Upload,
  X,
  type LucideIcon
} from "lucide-react";
import type {
  AssetListItem,
  AssetType,
  FolderRecord,
  ListingSummary,
  ProductSummary,
  StoreRecord
} from "../../shared/types";
import { api } from "../api/client";
import {
  buildFolderPathMap,
  clearRecentVisits,
  getContextualCommands,
  getHighlightRanges,
  isCommandKShortcut,
  isEditableElement,
  isMacPlatform,
  loadRecentVisits,
  parseCommandQuery,
  recordRecentVisit,
  scoreCommandMatch,
  type CommandScope,
  type RecentVisitKind,
  type RecentVisitRecord
} from "../utils/commandPalette";
import {
  formatBytes,
  LISTING_STATUS_META,
  PRODUCT_STATUS_META
} from "../utils/format";

export interface CommandPaletteProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  disableGlobalShortcuts?: boolean;
}

interface ScopeTabDef {
  scope: CommandScope;
  label: string;
  prefix?: string;
}

const SCOPE_TABS: ScopeTabDef[] = [
  { scope: "all", label: "全部" },
  { scope: "product", label: "商品", prefix: "p:" },
  { scope: "listing", label: "上架", prefix: "l:" },
  { scope: "asset", label: "素材", prefix: "a:" },
  { scope: "store", label: "店铺", prefix: "s:" },
  { scope: "nav", label: "页面与操作", prefix: ">" }
];

const SCOPE_LABELS: Record<CommandScope, string> = {
  all: "全部",
  product: "商品",
  listing: "上架",
  asset: "素材",
  store: "店铺",
  nav: "页面与操作"
};

interface StaticCommandDef {
  id: string;
  title: string;
  subtitle: string;
  to: string;
  icon: LucideIcon;
  keywords: string[];
  recordPageVisit?: boolean;
}

const QUICK_ACTIONS: StaticCommandDef[] = [
  {
    id: "action-new-product",
    title: "新建商品",
    subtitle: "创建新的商品主数据（SPU / 规格 / 成本）",
    to: "/products?action=new",
    icon: Plus,
    keywords: ["new", "create", "add", "product", "spu", "新建", "新增", "创建", "商品"]
  },
  {
    id: "action-new-listing",
    title: "新建上架链接",
    subtitle: "为商品和店铺创建新的 Listing 上架草稿",
    to: "/listings?action=new",
    icon: Layers,
    keywords: ["new", "create", "listing", "pdp", "新建", "上架", "链接", "草稿"]
  },
  {
    id: "action-upload-assets",
    title: "批量上传素材",
    subtitle: "打开素材库批量上传图片、视频或文档",
    to: "/assets?action=upload",
    icon: Upload,
    keywords: ["upload", "batch", "asset", "image", "video", "上传", "批量", "素材", "导入"]
  },
  {
    id: "action-new-store",
    title: "新建店铺",
    subtitle: "添加 Shopee / TikTok / Lazada 等销售店铺",
    to: "/stores?action=new",
    icon: Store,
    keywords: ["new", "create", "store", "shop", "新建", "店铺", "渠道"]
  },
  {
    id: "action-favorite-assets",
    title: "我的收藏素材",
    subtitle: "快速筛选所有已加星标的精选素材",
    to: "/assets?quickView=favorite",
    icon: Star,
    keywords: ["favorite", "star", "asset", "收藏", "星标", "精选", "素材"]
  },
  {
    id: "action-unfiled-assets",
    title: "待整理 / 未分类素材",
    subtitle: "查看尚未归档到文件夹的素材",
    to: "/assets?quickView=unfiled",
    icon: Inbox,
    keywords: ["unfiled", "inbox", "organize", "asset", "未分类", "待整理", "归档", "素材"]
  },
  {
    id: "action-channel-dictionaries",
    title: "渠道字典管理",
    subtitle: "维护平台、市场与语言字典项",
    to: "/stores?tab=dictionaries",
    icon: BookOpen,
    keywords: ["dictionary", "dict", "platform", "market", "language", "渠道", "字典", "平台", "市场", "语言"]
  },
  {
    id: "action-audit-activities",
    title: "系统审计日志",
    subtitle: "查看商品、素材、上架与系统操作审计记录",
    to: "/jobs?tab=activities",
    icon: Activity,
    keywords: ["audit", "activity", "log", "history", "审计", "日志", "操作记录"]
  }
];

const PAGE_COMMANDS: StaticCommandDef[] = [
  {
    id: "page-dashboard",
    title: "工作台",
    subtitle: "查看系统概览、存储健康度、任务进度与最近动态",
    to: "/",
    icon: LayoutDashboard,
    keywords: ["dashboard", "home", "overview", "工作台", "首页", "总览", "概览"],
    recordPageVisit: true
  },
  {
    id: "page-products",
    title: "商品中心",
    subtitle: "管理 SPU 主数据、规格参数、成本核算与 SKU 变体",
    to: "/products",
    icon: Package,
    keywords: ["products", "product", "spu", "sku", "catalog", "商品", "商品中心", "主数据"],
    recordPageVisit: true
  },
  {
    id: "page-listings",
    title: "上架工作台",
    subtitle: "管理多店铺 Listing、素材编排、PDP 文案与发布快照",
    to: "/listings",
    icon: Layers,
    keywords: ["listings", "listing", "workbench", "pdp", "release", "上架", "链接", "上架工作台"],
    recordPageVisit: true
  },
  {
    id: "page-templates",
    title: "导出模板",
    subtitle: "配置不同平台与站点的校验规范与 ZIP 导出结构",
    to: "/templates",
    icon: Sliders,
    keywords: ["templates", "template", "export", "rules", "导出模板", "模板", "规则", "规范"],
    recordPageVisit: true
  },
  {
    id: "page-assets",
    title: "全部素材",
    subtitle: "三栏素材工作台：目录树、虚拟化素材库与版本检查器",
    to: "/assets",
    icon: Images,
    keywords: ["assets", "asset", "images", "videos", "media", "library", "素材", "全部素材", "图库"],
    recordPageVisit: true
  },
  {
    id: "page-stores",
    title: "店铺与字典",
    subtitle: "管理各平台店铺配置及平台/市场/语言字典",
    to: "/stores",
    icon: Store,
    keywords: ["stores", "store", "shop", "dictionaries", "channel", "店铺", "字典", "渠道"],
    recordPageVisit: true
  },
  {
    id: "page-trash",
    title: "回收站",
    subtitle: "恢复误删的商品、素材、上架链接或执行安全 GC",
    to: "/trash",
    icon: Trash2,
    keywords: ["trash", "recycle", "gc", "deleted", "restore", "回收站", "清理", "恢复"],
    recordPageVisit: true
  },
  {
    id: "page-storage",
    title: "存储管理",
    subtitle: "管理本地 / S3 / WebDAV 存储与跨存储安全迁移",
    to: "/storage",
    icon: HardDrive,
    keywords: ["storage", "s3", "webdav", "local", "migrate", "provider", "存储", "存储管理", "迁移"],
    recordPageVisit: true
  },
  {
    id: "page-jobs",
    title: "任务与审计",
    subtitle: "监控后台队列任务状态与脱敏系统审计日志",
    to: "/jobs",
    icon: Activity,
    keywords: ["jobs", "job", "queue", "activities", "audit", "logs", "任务", "审计", "队列", "日志"],
    recordPageVisit: true
  },
  {
    id: "page-settings",
    title: "通用设置",
    subtitle: "配置默认存储、时区、保留策略与一致性系统备份",
    to: "/settings",
    icon: Settings,
    keywords: ["settings", "config", "backup", "timezone", "preferences", "设置", "通用设置", "备份"],
    recordPageVisit: true
  }
];

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  image: "图片",
  video: "视频",
  document: "文档",
  archive: "压缩包",
  other: "其他"
};

interface PaletteItem {
  id: string;
  sectionId: string;
  sectionTitle: string;
  title: string;
  subtitle?: string;
  to: string;
  icon?: LucideIcon;
  iconToneClass?: string;
  thumbUrl?: string;
  fallbackIcon?: LucideIcon;
  badge?: { label: string; className: string };
  metaRight?: string;
  recentEntry?: Omit<RecentVisitRecord, "visitedAt">;
}

interface PaletteSection {
  id: string;
  title: string;
  items: PaletteItem[];
  clearableRecent?: boolean;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const ranges = getHighlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    if (!range) continue;
    const [start, end] = range;
    if (start > cursor) {
      parts.push(<span key={`t-${i}`}>{text.slice(cursor, start)}</span>);
    }
    parts.push(
      <mark
        key={`m-${i}`}
        className="rounded-xs bg-blue-100 px-0.5 font-medium text-blue-900"
      >
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(<span key="t-end">{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

function PaletteThumbnail({
  src,
  fallbackIcon: FallbackIcon,
  toneClass
}: {
  src?: string;
  fallbackIcon: LucideIcon;
  toneClass: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return (
      <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${toneClass}`}
    >
      <FallbackIcon className="h-4 w-4" />
    </div>
  );
}

function getAssetFallbackIcon(assetType: AssetType): LucideIcon {
  switch (assetType) {
    case "video":
      return Film;
    case "document":
      return FileText;
    case "archive":
      return FileArchive;
    default:
      return ImageIcon;
  }
}

function getRecentIcon(kind: RecentVisitKind): LucideIcon {
  switch (kind) {
    case "product":
      return Package;
    case "listing":
      return Layers;
    case "asset":
      return ImageIcon;
    case "store":
      return Store;
    case "folder":
      return Folder;
    default:
      return Clock;
  }
}

function recentKindMatchesScope(kind: RecentVisitKind, scope: CommandScope): boolean {
  if (scope === "all") return true;
  if (scope === "product") return kind === "product";
  if (scope === "listing") return kind === "listing";
  if (scope === "asset") return kind === "asset" || kind === "folder";
  if (scope === "store") return kind === "store";
  if (scope === "nav") return kind === "page";
  return false;
}

export function CommandPalette({
  open,
  onOpen,
  onClose,
  disableGlobalShortcuts = false
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMac = useMemo(() => isMacPlatform(), []);

  const [rawQuery, setRawQuery] = useState("");
  const [explicitScope, setExplicitScope] = useState<CommandScope>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentVisits, setRecentVisits] = useState<RecentVisitRecord[]>([]);

  // Session preload data
  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [initialProducts, setInitialProducts] = useState<ProductSummary[]>([]);
  const [initialListings, setInitialListings] = useState<ListingSummary[]>([]);
  const [initialAssets, setInitialAssets] = useState<AssetListItem[]>([]);

  // Remote query results
  const [remoteProducts, setRemoteProducts] = useState<ProductSummary[]>([]);
  const [remoteListings, setRemoteListings] = useState<ListingSummary[]>([]);
  const [remoteAssets, setRemoteAssets] = useState<AssetListItem[]>([]);
  const [searching, setSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastNavSourceRef = useRef<"keyboard" | "mouse">("keyboard");
  const reqSeqRef = useRef(0);

  const parsed = useMemo(
    () => parseCommandQuery(rawQuery, explicitScope),
    [rawQuery, explicitScope]
  );

  // Global keyboard shortcuts: Cmd/Ctrl+K, `/`, and capture-phase Escape when open
  useEffect(() => {
    if (disableGlobalShortcuts) return;
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isCommandKShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (open) {
          onClose();
        } else {
          onOpen();
        }
        return;
      }

      if (open && event.key === "Escape") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }

      if (
        !open &&
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !isEditableElement(event.target) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        onOpen();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [open, onOpen, onClose, disableGlobalShortcuts]);

  // Reset state, focus input, and preload session cache when opening
  useEffect(() => {
    if (!open) {
      reqSeqRef.current += 1;
      setSearching(false);
      return;
    }

    setRawQuery("");
    setExplicitScope("all");
    setActiveIndex(0);
    setRemoteProducts([]);
    setRemoteListings([]);
    setRemoteAssets([]);
    setRecentVisits(loadRecentVisits());

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    let cancelled = false;
    void Promise.allSettled([
      api.listStores(),
      api.listFolders(),
      api.listProducts({ page: 1, pageSize: 8 }),
      api.listListings({ page: 1, pageSize: 8 }),
      api.listAssets({ page: 1, pageSize: 8, sort: "newest" })
    ]).then(([storesRes, foldersRes, productsRes, listingsRes, assetsRes]) => {
      if (cancelled) return;
      if (storesRes.status === "fulfilled") setStores(storesRes.value.items);
      if (foldersRes.status === "fulfilled") setFolders(foldersRes.value.items);
      if (productsRes.status === "fulfilled") setInitialProducts(productsRes.value.items);
      if (listingsRes.status === "fulfilled") setInitialListings(listingsRes.value.items);
      if (assetsRes.status === "fulfilled") setInitialAssets(assetsRes.value.items);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  // Debounced remote search based on active scope and query term
  useEffect(() => {
    if (!open) return;

    const term = parsed.term;
    if (!term) {
      reqSeqRef.current += 1;
      setRemoteProducts([]);
      setRemoteListings([]);
      setRemoteAssets([]);
      setSearching(false);
      return;
    }

    const needProducts = parsed.scope === "all" || parsed.scope === "product";
    const needListings = parsed.scope === "all" || parsed.scope === "listing";
    const needAssets = parsed.scope === "all" || parsed.scope === "asset";

    if (!needProducts && !needListings && !needAssets) {
      reqSeqRef.current += 1;
      setRemoteProducts([]);
      setRemoteListings([]);
      setRemoteAssets([]);
      setSearching(false);
      return;
    }

    const pageSize = parsed.scope === "all" ? 6 : 12;
    const seq = ++reqSeqRef.current;
    setSearching(true);

    const timer = window.setTimeout(() => {
      const promises: [
        Promise<ProductSummary[]>,
        Promise<ListingSummary[]>,
        Promise<AssetListItem[]>
      ] = [
        needProducts
          ? api.listProducts({ q: term, page: 1, pageSize }).then((res) => res.items)
          : Promise.resolve([]),
        needListings
          ? api.listListings({ q: term, page: 1, pageSize }).then((res) => res.items)
          : Promise.resolve([]),
        needAssets
          ? api.listAssets({ q: term, page: 1, pageSize, sort: "newest" }).then((res) => res.items)
          : Promise.resolve([])
      ];

      void Promise.allSettled(promises).then(([prodRes, listRes, assetRes]) => {
        if (reqSeqRef.current !== seq) return;
        setRemoteProducts(prodRes.status === "fulfilled" ? prodRes.value : []);
        setRemoteListings(listRes.status === "fulfilled" ? listRes.value : []);
        setRemoteAssets(assetRes.status === "fulfilled" ? assetRes.value : []);
        setSearching(false);
      });
    }, 150);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open, parsed.term, parsed.scope]);

  const folderPathMap = useMemo(() => buildFolderPathMap(folders), [folders]);
  const contextualCommands = useMemo(
    () => getContextualCommands(location.pathname),
    [location.pathname]
  );

  // Build grouped result sections
  const sections = useMemo<PaletteSection[]>(() => {
    const scope = parsed.scope;
    const term = parsed.term;
    const isSearching = term.length > 0;
    const result: PaletteSection[] = [];

    const mapProductItem = (p: ProductSummary): PaletteItem => {
      const statusMeta = PRODUCT_STATUS_META[p.status];
      const subtitleParts = [p.spu];
      if (p.nameEn) subtitleParts.push(p.nameEn);
      else if (p.category) subtitleParts.push(p.category);
      return {
        id: `product-${p.id}`,
        sectionId: "products",
        sectionTitle: "商品",
        title: p.nameZh,
        subtitle: subtitleParts.join(" · "),
        to: `/products/${p.id}`,
        thumbUrl:
          p.coverAssetId && p.coverVersionId
            ? api.thumbnailUrl(p.coverAssetId, p.coverVersionId)
            : undefined,
        fallbackIcon: Package,
        iconToneClass: "border-blue-100 bg-blue-50 text-blue-600",
        badge: statusMeta,
        metaRight: `${p.skuCount} SKU`,
        recentEntry: {
          kind: "product",
          title: p.nameZh,
          subtitle: p.spu,
          to: `/products/${p.id}`
        }
      };
    };

    const mapListingItem = (l: ListingSummary): PaletteItem => {
      const statusMeta = LISTING_STATUS_META[l.status];
      return {
        id: `listing-${l.id}`,
        sectionId: "listings",
        sectionTitle: "上架链接",
        title: l.displayName,
        subtitle: `${l.storeName} · ${l.platform}/${l.market} · ${l.productSpu}`,
        to: `/listings/${l.id}`,
        icon: Layers,
        iconToneClass: "border-indigo-100 bg-indigo-50 text-indigo-600",
        badge: statusMeta,
        recentEntry: {
          kind: "listing",
          title: l.displayName,
          subtitle: `${l.storeName} · ${l.productSpu}`,
          to: `/listings/${l.id}`
        }
      };
    };

    const mapStoreItem = (s: StoreRecord): PaletteItem => ({
      id: `store-${s.id}`,
      sectionId: "stores",
      sectionTitle: "店铺",
      title: s.name,
      subtitle: `${s.platform} / ${s.market} · ${s.defaultLanguage}`,
      to: `/listings?storeId=${encodeURIComponent(s.id)}`,
      icon: Store,
      iconToneClass: "border-emerald-100 bg-emerald-50 text-emerald-600",
      metaRight: `${s.listingCount} 条链接`,
      recentEntry: {
        kind: "store",
        title: s.name,
        subtitle: `${s.platform} / ${s.market}`,
        to: `/listings?storeId=${encodeURIComponent(s.id)}`
      }
    });

    const mapFolderItem = (f: FolderRecord): PaletteItem => {
      const fullPath = folderPathMap.get(f.id) || f.name;
      return {
        id: `folder-${f.id}`,
        sectionId: "folders",
        sectionTitle: "文件夹",
        title: f.name,
        subtitle: fullPath,
        to: `/assets?folderId=${encodeURIComponent(f.id)}`,
        icon: Folder,
        iconToneClass: "border-amber-100 bg-amber-50 text-amber-600",
        metaRight: `${f.assetCount} 个素材`,
        recentEntry: {
          kind: "folder",
          title: f.name,
          subtitle: fullPath,
          to: `/assets?folderId=${encodeURIComponent(f.id)}`
        }
      };
    };

    const mapAssetItem = (a: AssetListItem): PaletteItem => {
      const subtitleParts = [
        formatBytes(a.sizeBytes),
        ASSET_TYPE_LABELS[a.assetType] || a.assetType
      ];
      if (a.folderName) subtitleParts.push(a.folderName);
      return {
        id: `asset-${a.id}`,
        sectionId: "assets",
        sectionTitle: "素材",
        title: a.name,
        subtitle: subtitleParts.join(" · "),
        to: `/assets?assetId=${encodeURIComponent(a.id)}`,
        thumbUrl:
          a.thumbStatus === "ready" || a.assetType === "image"
            ? api.thumbnailUrl(a.id, a.currentVersionId)
            : undefined,
        fallbackIcon: getAssetFallbackIcon(a.assetType),
        iconToneClass: "border-gray-200 bg-gray-50 text-gray-600",
        metaRight: a.ext ? a.ext.replace(/^\./, "").toUpperCase() : undefined,
        recentEntry: {
          kind: "asset",
          title: a.name,
          subtitle: subtitleParts.join(" · "),
          to: `/assets?assetId=${encodeURIComponent(a.id)}`
        }
      };
    };

    // 1. Contextual commands
    if (scope === "all" || scope === "nav") {
      const matchedContextual = contextualCommands
        .map((cmd) => ({
          cmd,
          score: isSearching
            ? scoreCommandMatch(term, [
                { text: cmd.title, weight: 1.3 },
                { text: cmd.subtitle, weight: 0.9 },
                { text: cmd.keywords.join(" "), weight: 0.85 }
              ])
            : 1
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      if (matchedContextual.length > 0) {
        result.push({
          id: "contextual",
          title: "当前页面快捷跳转",
          items: matchedContextual.map(({ cmd }) => ({
            id: cmd.id,
            sectionId: "contextual",
            sectionTitle: "当前页面快捷跳转",
            title: cmd.title,
            subtitle: cmd.subtitle,
            to: cmd.to,
            icon: Compass,
            iconToneClass: "border-blue-100 bg-blue-50 text-blue-600"
          }))
        });
      }
    }

    // 2. Recent visits
    const scopedRecents = recentVisits.filter((item) => recentKindMatchesScope(item.kind, scope));
    const matchedRecents = scopedRecents
      .map((item) => ({
        item,
        score: isSearching
          ? scoreCommandMatch(term, [
              { text: item.title, weight: 1.2 },
              { text: item.subtitle, weight: 0.9 },
              { text: item.to, weight: 0.5 }
            ])
          : 1
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, isSearching ? 4 : 6);

    if (matchedRecents.length > 0) {
      result.push({
        id: "recent",
        title: "最近访问",
        clearableRecent: true,
        items: matchedRecents.map(({ item }) => ({
          id: `recent-${item.to}`,
          sectionId: "recent",
          sectionTitle: "最近访问",
          title: item.title,
          subtitle: item.subtitle,
          to: item.to,
          icon: getRecentIcon(item.kind),
          iconToneClass: "border-gray-200 bg-gray-50 text-gray-600",
          recentEntry: {
            kind: item.kind,
            title: item.title,
            subtitle: item.subtitle,
            to: item.to
          }
        }))
      });
    }

    // 3. Quick actions
    if (scope === "all" || scope === "nav") {
      const matchedActions = QUICK_ACTIONS.map((cmd) => ({
        cmd,
        score: isSearching
          ? scoreCommandMatch(term, [
              { text: cmd.title, weight: 1.3 },
              { text: cmd.subtitle, weight: 0.85 },
              { text: cmd.keywords.join(" "), weight: 0.9 }
            ])
          : 1
      }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, !isSearching && scope === "all" ? 6 : 8);

      if (matchedActions.length > 0) {
        result.push({
          id: "actions",
          title: "快捷操作",
          items: matchedActions.map(({ cmd }) => ({
            id: cmd.id,
            sectionId: "actions",
            sectionTitle: "快捷操作",
            title: cmd.title,
            subtitle: cmd.subtitle,
            to: cmd.to,
            icon: cmd.icon,
            iconToneClass: "border-blue-100 bg-blue-50/80 text-blue-600"
          }))
        });
      }
    }

    // 4. Pages (when searching, show pages right after quick actions; on empty all-scope, place after entities or in nav)
    const buildPagesSection = (): PaletteSection | null => {
      if (scope !== "all" && scope !== "nav") return null;
      const matchedPages = PAGE_COMMANDS.map((cmd) => ({
        cmd,
        score: isSearching
          ? scoreCommandMatch(term, [
              { text: cmd.title, weight: 1.3 },
              { text: cmd.subtitle, weight: 0.8 },
              { text: cmd.keywords.join(" "), weight: 0.95 },
              { text: cmd.to, weight: 0.6 }
            ])
          : 1
      }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      if (matchedPages.length === 0) return null;
      return {
        id: "pages",
        title: "页面导航",
        items: matchedPages.map(({ cmd }) => ({
          id: cmd.id,
          sectionId: "pages",
          sectionTitle: "页面导航",
          title: cmd.title,
          subtitle: cmd.subtitle,
          to: cmd.to,
          icon: cmd.icon,
          iconToneClass: "border-gray-200 bg-gray-50 text-gray-700",
          recentEntry: cmd.recordPageVisit
            ? {
                kind: "page",
                title: cmd.title,
                subtitle: cmd.subtitle,
                to: cmd.to
              }
            : undefined
        }))
      };
    };

    const pagesSection = buildPagesSection();
    if (pagesSection && (isSearching || scope === "nav")) {
      result.push(pagesSection);
    }

    // 5. Products
    if (scope === "all" || scope === "product") {
      const limit = scope === "product" ? 12 : isSearching ? 6 : 4;
      let productsToShow: ProductSummary[];
      if (!isSearching) {
        productsToShow = initialProducts.slice(0, limit);
      } else {
        const merged = new Map<string, { item: ProductSummary; fromRemote: boolean }>();
        for (const p of initialProducts) merged.set(p.id, { item: p, fromRemote: false });
        for (const p of remoteProducts) merged.set(p.id, { item: p, fromRemote: true });

        productsToShow = Array.from(merged.values())
          .map(({ item, fromRemote }) => {
            const clientScore = scoreCommandMatch(term, [
              { text: item.nameZh, weight: 1.3 },
              { text: item.spu, weight: 1.25 },
              { text: item.nameEn, weight: 1.0 },
              { text: item.category, weight: 0.8 },
              { text: item.brandModel, weight: 0.8 },
              { text: item.supplierName, weight: 0.7 }
            ]);
            const score = clientScore > 0 ? clientScore : fromRemote ? 20 : 0;
            return { item, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((entry) => entry.item);
      }

      if (productsToShow.length > 0) {
        result.push({
          id: "products",
          title: "商品",
          items: productsToShow.map(mapProductItem)
        });
      }
    }

    // 6. Listings
    if (scope === "all" || scope === "listing") {
      const limit = scope === "listing" ? 12 : isSearching ? 6 : 4;
      let listingsToShow: ListingSummary[];
      if (!isSearching) {
        listingsToShow = initialListings.slice(0, limit);
      } else {
        const merged = new Map<string, { item: ListingSummary; fromRemote: boolean }>();
        for (const l of initialListings) merged.set(l.id, { item: l, fromRemote: false });
        for (const l of remoteListings) merged.set(l.id, { item: l, fromRemote: true });

        listingsToShow = Array.from(merged.values())
          .map(({ item, fromRemote }) => {
            const clientScore = scoreCommandMatch(term, [
              { text: item.displayName, weight: 1.3 },
              { text: item.productSpu, weight: 1.15 },
              { text: item.productNameZh, weight: 1.0 },
              { text: item.storeName, weight: 0.95 },
              { text: `${item.platform} ${item.market}`, weight: 0.85 },
              { text: item.pdpTitle, weight: 0.75 },
              { text: item.externalId, weight: 0.9 }
            ]);
            const score = clientScore > 0 ? clientScore : fromRemote ? 20 : 0;
            return { item, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((entry) => entry.item);
      }

      if (listingsToShow.length > 0) {
        result.push({
          id: "listings",
          title: "上架链接",
          items: listingsToShow.map(mapListingItem)
        });
      }
    }

    // 7. Stores
    if (scope === "all" || scope === "store") {
      const limit = scope === "store" ? 12 : isSearching ? 6 : 4;
      const storesToShow = isSearching
        ? stores
            .map((s) => ({
              item: s,
              score: scoreCommandMatch(term, [
                { text: s.name, weight: 1.3 },
                { text: s.platform, weight: 0.95 },
                { text: s.market, weight: 0.95 },
                { text: s.defaultLanguage, weight: 0.75 },
                { text: s.notes, weight: 0.6 }
              ])
            }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((entry) => entry.item)
        : stores.slice(0, limit);

      if (storesToShow.length > 0) {
        result.push({
          id: "stores",
          title: "店铺",
          items: storesToShow.map(mapStoreItem)
        });
      }
    }

    // 8. Folders
    if (scope === "all" || scope === "asset") {
      const limit = scope === "asset" ? 8 : 5;
      const foldersToShow = isSearching
        ? folders
            .map((f) => ({
              item: f,
              score: scoreCommandMatch(term, [
                { text: f.name, weight: 1.3 },
                { text: folderPathMap.get(f.id), weight: 1.0 }
              ])
            }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((entry) => entry.item)
        : scope === "asset"
          ? folders.slice(0, limit)
          : [];

      if (foldersToShow.length > 0) {
        result.push({
          id: "folders",
          title: "文件夹",
          items: foldersToShow.map(mapFolderItem)
        });
      }
    }

    // 9. Assets
    if (scope === "all" || scope === "asset") {
      const limit = scope === "asset" ? 12 : 6;
      let assetsToShow: AssetListItem[] = [];
      if (!isSearching) {
        assetsToShow = scope === "asset" ? initialAssets.slice(0, limit) : [];
      } else {
        const merged = new Map<string, { item: AssetListItem; fromRemote: boolean }>();
        for (const a of initialAssets) merged.set(a.id, { item: a, fromRemote: false });
        for (const a of remoteAssets) merged.set(a.id, { item: a, fromRemote: true });

        assetsToShow = Array.from(merged.values())
          .map(({ item, fromRemote }) => {
            const clientScore = scoreCommandMatch(term, [
              { text: item.name, weight: 1.3 },
              { text: item.originalFilename, weight: 1.1 },
              { text: item.folderName, weight: 0.85 },
              { text: item.purpose, weight: 0.7 },
              { text: item.tags.map((t) => t.name).join(" "), weight: 0.9 },
              { text: item.products.map((p) => `${p.spu} ${p.nameZh}`).join(" "), weight: 0.85 }
            ]);
            const score = clientScore > 0 ? clientScore : fromRemote ? 20 : 0;
            return { item, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((entry) => entry.item);
      }

      if (assetsToShow.length > 0) {
        result.push({
          id: "assets",
          title: "素材",
          items: assetsToShow.map(mapAssetItem)
        });
      }
    }

    // On empty query with "all" scope, append pages section at the bottom for easy discovery
    if (pagesSection && !isSearching && scope === "all") {
      result.push(pagesSection);
    }

    return result;
  }, [
    parsed.scope,
    parsed.term,
    contextualCommands,
    recentVisits,
    initialProducts,
    remoteProducts,
    initialListings,
    remoteListings,
    stores,
    folders,
    folderPathMap,
    initialAssets,
    remoteAssets
  ]);

  const flatItems = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  );

  // Reset active index when query or scope changes
  useEffect(() => {
    lastNavSourceRef.current = "keyboard";
    setActiveIndex(0);
  }, [rawQuery, explicitScope]);

  // Clamp active index if flatItems shrinks
  useEffect(() => {
    if (flatItems.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
    } else if (activeIndex >= flatItems.length) {
      setActiveIndex(flatItems.length - 1);
    }
  }, [flatItems.length, activeIndex]);

  // Scroll active item into view on keyboard navigation
  useEffect(() => {
    if (!open || lastNavSourceRef.current !== "keyboard") return;
    const node = itemRefs.current[activeIndex];
    if (node) {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex, flatItems.length]);

  const selectItem = useCallback(
    (item: PaletteItem, openInNewTab = false) => {
      if (item.recentEntry) {
        const nextRecents = recordRecentVisit(item.recentEntry);
        setRecentVisits(nextRecents);
      }
      onClose();
      if (openInNewTab) {
        window.open(item.to, "_blank", "noopener,noreferrer");
      } else {
        navigate(item.to);
      }
    },
    [navigate, onClose]
  );

  const handleClearRecents = (event: ReactMouseEvent) => {
    event.stopPropagation();
    clearRecentVisits();
    setRecentVisits([]);
  };

  const handleResetScope = () => {
    if (explicitScope !== "all") {
      setExplicitScope("all");
    } else if (parsed.prefixApplied) {
      setRawQuery(parsed.term);
    }
    inputRef.current?.focus();
  };

  const handleSelectScopeTab = (nextScope: CommandScope) => {
    if (parsed.prefixApplied) {
      setRawQuery(parsed.term);
    }
    setExplicitScope(nextScope);
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (
      event.key === "ArrowDown" ||
      (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "n")
    ) {
      event.preventDefault();
      if (flatItems.length === 0) return;
      lastNavSourceRef.current = "keyboard";
      setActiveIndex((prev) => (prev + 1) % flatItems.length);
      return;
    }

    if (
      event.key === "ArrowUp" ||
      (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "p")
    ) {
      event.preventDefault();
      if (flatItems.length === 0) return;
      lastNavSourceRef.current = "keyboard";
      setActiveIndex((prev) => (prev - 1 + flatItems.length) % flatItems.length);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const currentScope = parsed.scope;
      const idx = SCOPE_TABS.findIndex((t) => t.scope === currentScope);
      const step = event.shiftKey ? -1 : 1;
      const next = SCOPE_TABS[(idx + step + SCOPE_TABS.length) % SCOPE_TABS.length];
      if (!next) return;
      if (parsed.prefixApplied) {
        setRawQuery(parsed.term);
      }
      setExplicitScope(next.scope);
      return;
    }

    if (event.key === "Backspace" && rawQuery === "" && explicitScope !== "all") {
      event.preventDefault();
      setExplicitScope("all");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const target = flatItems[activeIndex];
      if (!target) return;
      selectItem(target, event.metaKey || event.ctrlKey);
    }
  };

  if (!open) return null;

  const showScopeChip = explicitScope !== "all" || parsed.prefixApplied;
  let runningIndex = 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-gray-900/40 px-4 pt-[10vh] backdrop-blur-[2px] sm:pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转命令面板"
        className="animate-command-palette-in flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl shadow-gray-900/15"
      >
        {/* Top search bar */}
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-gray-400" />
          {showScopeChip && (
            <button
              type="button"
              onClick={handleResetScope}
              title="清除范围筛选"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
            >
              <span>{SCOPE_LABELS[parsed.scope]}</span>
              <X className="h-3 w-3" />
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索商品、上架链接、素材、店铺、文件夹或命令..."
            aria-label="搜索命令与跳转目标"
            className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
          />
          {searching && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" aria-hidden="true" />
          )}
          {rawQuery && (
            <button
              type="button"
              onClick={() => {
                setRawQuery("");
                inputRef.current?.focus();
              }}
              aria-label="清空搜索"
              className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd className="font-mono-tabular hidden shrink-0 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 sm:inline-block">
            ESC
          </kbd>
        </div>

        {/* Scope filter bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-gray-100 bg-gray-50/70 px-4 py-2">
          {SCOPE_TABS.map((tab) => {
            const active = parsed.scope === tab.scope;
            return (
              <button
                key={tab.scope}
                type="button"
                onClick={() => handleSelectScopeTab(tab.scope)}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "bg-blue-600 text-white shadow-xs"
                    : "border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900"
                }`}
              >
                <span>{tab.label}</span>
                {tab.prefix && (
                  <span
                    className={`font-mono-tabular text-[10px] ${
                      active ? "text-blue-100" : "text-gray-400"
                    }`}
                  >
                    {tab.prefix}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Results list */}
        <div className="min-h-[180px] flex-1 overflow-y-auto px-2 py-2">
          {sections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Search className="h-7 w-7 text-gray-300" />
              <p className="mt-2.5 text-sm font-medium text-gray-700">
                {searching ? "正在搜索..." : "未找到匹配的结果"}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                可尝试更换关键词，或按{" "}
                <kbd className="font-mono-tabular rounded border border-gray-200 bg-gray-50 px-1 py-0.5 text-[10px] text-gray-600">
                  Tab
                </kbd>{" "}
                切换搜索范围
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {sections.map((section) => (
                <div key={section.id}>
                  <div className="flex items-center justify-between px-2.5 pb-1 text-[11px] font-medium text-gray-400">
                    <span>{section.title}</span>
                    {section.clearableRecent && (
                      <button
                        type="button"
                        onClick={handleClearRecents}
                        className="rounded px-1.5 py-0.5 text-[11px] font-normal text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                      >
                        清空
                      </button>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {section.items.map((item) => {
                      const itemIndex = runningIndex;
                      runningIndex += 1;
                      const isActive = itemIndex === activeIndex;
                      const Icon = item.icon ?? item.fallbackIcon ?? Compass;

                      return (
                        <button
                          key={item.id}
                          ref={(el) => {
                            itemRefs.current[itemIndex] = el;
                          }}
                          type="button"
                          onMouseEnter={() => {
                            lastNavSourceRef.current = "mouse";
                            setActiveIndex(itemIndex);
                          }}
                          onClick={(event) => {
                            selectItem(item, event.metaKey || event.ctrlKey);
                          }}
                          className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                            isActive
                              ? "bg-blue-50/90 text-gray-900"
                              : "text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          {item.thumbUrl !== undefined || item.fallbackIcon ? (
                            <PaletteThumbnail
                              src={item.thumbUrl}
                              fallbackIcon={item.fallbackIcon ?? Icon}
                              toneClass={
                                item.iconToneClass ?? "border-gray-200 bg-gray-50 text-gray-600"
                              }
                            />
                          ) : (
                            <div
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                                item.iconToneClass ?? "border-gray-200 bg-gray-50 text-gray-600"
                              }`}
                            >
                              <Icon className="h-4 w-4" />
                            </div>
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-gray-900">
                                <HighlightedText text={item.title} query={parsed.term} />
                              </span>
                              {item.badge && (
                                <span
                                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${item.badge.className}`}
                                >
                                  {item.badge.label}
                                </span>
                              )}
                            </div>
                            {item.subtitle && (
                              <div className="truncate text-xs text-gray-500">
                                <HighlightedText text={item.subtitle} query={parsed.term} />
                              </div>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            {item.metaRight && (
                              <span className="font-mono-tabular hidden text-[11px] text-gray-400 sm:inline">
                                {item.metaRight}
                              </span>
                            )}
                            {isActive && (
                              <CornerDownLeft className="h-3.5 w-3.5 text-blue-600" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer legend */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/80 px-4 py-2 text-[11px] text-gray-500">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span>↑↓ 选择</span>
            <span>·</span>
            <span>↵ 跳转</span>
            <span>·</span>
            <span>{isMac ? "⌘↵" : "Ctrl↵"} 新标签页</span>
            <span>·</span>
            <span>Tab 切换范围</span>
            <span>·</span>
            <span>Esc 关闭</span>
          </div>
          <div className="font-mono-tabular hidden items-center gap-2 text-[10px] text-gray-400 md:flex">
            <span>p: 商品</span>
            <span>l: 上架</span>
            <span>a: 素材</span>
            <span>s: 店铺</span>
            <span>&gt; 导航</span>
          </div>
        </div>
      </div>
    </div>
  );
}
