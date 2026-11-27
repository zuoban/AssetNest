import type { FolderRecord } from "../../shared/types";

export type CommandScope = "all" | "product" | "listing" | "asset" | "store" | "nav";

export type RecentVisitKind = "product" | "listing" | "asset" | "store" | "folder" | "page";

export interface RecentVisitRecord {
  kind: RecentVisitKind;
  title: string;
  subtitle?: string;
  to: string;
  visitedAt: number;
}

export interface ParsedCommandQuery {
  scope: CommandScope;
  term: string;
  prefixApplied: boolean;
}

export interface ContextualCommandDef {
  id: string;
  title: string;
  subtitle: string;
  to: string;
  keywords: string[];
}

const RECENT_STORAGE_KEY = "assetnest:recent-visits:v1";
const MAX_RECENT_VISITS = 8;

const SCOPE_PREFIXES: Array<{ prefix: string; scope: CommandScope }> = [
  { prefix: ">", scope: "nav" },
  { prefix: "p:", scope: "product" },
  { prefix: "P:", scope: "product" },
  { prefix: "#", scope: "product" },
  { prefix: "l:", scope: "listing" },
  { prefix: "L:", scope: "listing" },
  { prefix: "a:", scope: "asset" },
  { prefix: "A:", scope: "asset" },
  { prefix: "s:", scope: "store" },
  { prefix: "S:", scope: "store" }
];

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown };
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (el.isContentEditable) {
    return true;
  }
  if (typeof el.closest === "function" && el.closest('[contenteditable="true"]')) {
    return true;
  }
  return false;
}

export function isCommandKShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey;
}

export function parseCommandQuery(
  raw: string,
  explicitScope: CommandScope = "all"
): ParsedCommandQuery {
  const trimmedStart = raw.trimStart();

  if (explicitScope !== "all") {
    return {
      scope: explicitScope,
      term: raw.trim(),
      prefixApplied: false
    };
  }

  for (const entry of SCOPE_PREFIXES) {
    if (trimmedStart.startsWith(entry.prefix)) {
      return {
        scope: entry.scope,
        term: trimmedStart.slice(entry.prefix.length).trim(),
        prefixApplied: true
      };
    }
  }

  return {
    scope: "all",
    term: raw.trim(),
    prefixApplied: false
  };
}

function isBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  return /[\s\-_/\\·.,:;()[\]{}]/.test(ch);
}

function scoreTokenAgainstField(token: string, rawField: string): number {
  const field = rawField.trim().toLowerCase();
  if (!field || !token) return 0;

  if (field === token) return 120;
  if (field.startsWith(token)) return 96;

  const idx = field.indexOf(token);
  if (idx > 0) {
    if (isBoundaryChar(field[idx - 1])) return 82;
    return 62;
  }

  // Fuzzy subsequence match for ASCII/mixed tokens (minimum 2 chars to avoid noisy single-char hits)
  if (token.length < 2) return 0;

  let fi = 0;
  let firstHit = -1;
  let lastHit = -1;
  let consecutiveBonus = 0;
  let prevHit = -2;

  for (let ti = 0; ti < token.length; ti += 1) {
    const target = token[ti];
    if (target === undefined) return 0;
    const found = field.indexOf(target, fi);
    if (found === -1) return 0;
    if (firstHit === -1) firstHit = found;
    if (found === prevHit + 1) consecutiveBonus += 4;
    if (isBoundaryChar(field[found - 1])) consecutiveBonus += 3;
    prevHit = found;
    lastHit = found;
    fi = found + 1;
  }

  const span = Math.max(1, lastHit - firstHit + 1);
  const density = token.length / span;
  return Math.round(22 + density * 20 + Math.min(18, consecutiveBonus));
}

export function scoreCommandMatch(
  query: string,
  fields: Array<{ text: string | null | undefined; weight?: number }>
): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  let total = 0;
  for (const token of tokens) {
    let bestForToken = 0;
    for (const field of fields) {
      if (!field.text) continue;
      const base = scoreTokenAgainstField(token, field.text);
      if (base > 0) {
        const weighted = base * (field.weight ?? 1);
        if (weighted > bestForToken) {
          bestForToken = weighted;
        }
      }
    }
    if (bestForToken === 0) {
      return 0;
    }
    total += bestForToken;
  }

  return Math.round(total / tokens.length);
}

export function getHighlightRanges(text: string, query: string): Array<[number, number]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized || !text) return [];

  const lower = text.toLowerCase();
  const tokens = Array.from(new Set(normalized.split(/\s+/).filter((t) => t.length >= 1))).sort(
    (a, b) => b.length - a.length
  );

  const rawRanges: Array<[number, number]> = [];
  for (const token of tokens) {
    let start = 0;
    while (start < lower.length) {
      const idx = lower.indexOf(token, start);
      if (idx === -1) break;
      rawRanges.push([idx, idx + token.length]);
      start = idx + token.length;
    }
  }

  if (rawRanges.length === 0) return [];

  rawRanges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const firstRange = rawRanges[0];
  if (!firstRange) return [];
  const merged: Array<[number, number]> = [[firstRange[0], firstRange[1]]];
  for (let i = 1; i < rawRanges.length; i += 1) {
    const range = rawRanges[i];
    const last = merged[merged.length - 1];
    if (!range || !last) continue;
    const [start, end] = range;
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function buildFolderPathMap(folders: FolderRecord[]): Map<string, string> {
  const byId = new Map<string, FolderRecord>();
  for (const folder of folders) {
    byId.set(folder.id, folder);
  }

  const paths = new Map<string, string>();
  for (const folder of folders) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: FolderRecord | undefined = folder;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    paths.set(folder.id, chain.join(" / "));
  }
  return paths;
}

export function getContextualCommands(pathname: string): ContextualCommandDef[] {
  const productMatch = pathname.match(/^\/products\/([^/]+)$/);
  if (productMatch) {
    const id = productMatch[1];
    return [
      {
        id: "ctx-product-overview",
        title: "当前商品 · 概览与基础信息",
        subtitle: "切换到商品基础档案、成本核算与规格参数",
        to: `/products/${id}?tab=overview`,
        keywords: ["overview", "info", "cost", "spec", "概览", "基础信息", "成本"]
      },
      {
        id: "ctx-product-skus",
        title: "当前商品 · SKU 变体管理",
        subtitle: "查看或新增该商品的 SKU 变体",
        to: `/products/${id}?tab=skus`,
        keywords: ["sku", "variant", "变体", "规格"]
      },
      {
        id: "ctx-product-assets",
        title: "当前商品 · 关联素材与主图锁",
        subtitle: "查看当前商品素材、锁定参考主图或批量上传",
        to: `/products/${id}?tab=assets`,
        keywords: ["asset", "image", "master", "upload", "素材", "主图"]
      },
      {
        id: "ctx-product-listings",
        title: "当前商品 · 关联上架链接",
        subtitle: "查看该商品在各店铺的 Listing 链接",
        to: `/products/${id}?tab=listings`,
        keywords: ["listing", "store", "上架", "链接", "店铺"]
      }
    ];
  }

  const listingMatch = pathname.match(/^\/listings\/([^/]+)$/);
  if (listingMatch) {
    const id = listingMatch[1];
    return [
      {
        id: "ctx-listing-carousel",
        title: "当前上架 · 轮播图组",
        subtitle: "编排主图与轮播图顺序",
        to: `/listings/${id}?tab=assets&assetGroup=carousel`,
        keywords: ["carousel", "main", "轮播", "主图", "素材"]
      },
      {
        id: "ctx-listing-detail",
        title: "当前上架 · 详情图组",
        subtitle: "编排详情长图与移动端预览",
        to: `/listings/${id}?tab=assets&assetGroup=detail`,
        keywords: ["detail", "详情图", "长图"]
      },
      {
        id: "ctx-listing-sku-images",
        title: "当前上架 · SKU 图组",
        subtitle: "为已绑定 SKU 分配对应变体图",
        to: `/listings/${id}?tab=assets&assetGroup=sku`,
        keywords: ["sku", "变体图", "sku图"]
      },
      {
        id: "ctx-listing-video",
        title: "当前上架 · 视频组",
        subtitle: "配置主图视频与商品展示视频",
        to: `/listings/${id}?tab=assets&assetGroup=video`,
        keywords: ["video", "mp4", "视频"]
      },
      {
        id: "ctx-listing-skus",
        title: "当前上架 · SKU 绑定配置",
        subtitle: "选择上架 SKU 与渠道编码映射",
        to: `/listings/${id}?tab=skus`,
        keywords: ["sku", "bind", "channel", "绑定", "渠道码"]
      },
      {
        id: "ctx-listing-pdp",
        title: "当前上架 · PDP 文案编辑",
        subtitle: "编辑标题、卖点、描述与规格文案",
        to: `/listings/${id}?tab=pdp`,
        keywords: ["pdp", "copy", "title", "description", "文案", "标题", "卖点"]
      },
      {
        id: "ctx-listing-release",
        title: "当前上架 · 校验与发布导出",
        subtitle: "执行上架前校验、生成不可变 Release 与导出包",
        to: `/listings/${id}?tab=release`,
        keywords: ["release", "export", "validate", "preflight", "发布", "校验", "导出"]
      }
    ];
  }

  if (pathname === "/stores") {
    return [
      {
        id: "ctx-stores-list",
        title: "店铺与字典 · 切换到店铺列表",
        subtitle: "管理 Shopee / TikTok / Lazada 等店铺",
        to: "/stores?tab=stores",
        keywords: ["store", "shop", "店铺"]
      },
      {
        id: "ctx-stores-dicts",
        title: "店铺与字典 · 切换到渠道字典",
        subtitle: "管理平台、市场、语言字典项",
        to: "/stores?tab=dictionaries",
        keywords: ["dict", "dictionary", "platform", "market", "language", "字典", "平台", "市场"]
      }
    ];
  }

  if (pathname === "/jobs") {
    return [
      {
        id: "ctx-jobs-queue",
        title: "任务与审计 · 切换到后台任务队列",
        subtitle: "查看排队中、运行中与失败重试任务",
        to: "/jobs?tab=jobs",
        keywords: ["job", "queue", "task", "任务", "队列"]
      },
      {
        id: "ctx-jobs-activities",
        title: "任务与审计 · 切换到系统审计日志",
        subtitle: "查看商品、素材、上架与系统操作记录",
        to: "/jobs?tab=activities",
        keywords: ["activity", "audit", "log", "审计", "日志"]
      }
    ];
  }

  if (pathname === "/assets") {
    return [
      {
        id: "ctx-assets-all",
        title: "素材工作台 · 查看全部素材",
        subtitle: "重置快捷视图并显示所有素材",
        to: "/assets?quickView=all",
        keywords: ["all", "reset", "全部", "重置"]
      },
      {
        id: "ctx-assets-favorite",
        title: "素材工作台 · 只看我的收藏",
        subtitle: "快速筛选已加星标的精选素材",
        to: "/assets?quickView=favorite",
        keywords: ["favorite", "star", "收藏", "星标"]
      },
      {
        id: "ctx-assets-unfiled",
        title: "素材工作台 · 只看未分类素材",
        subtitle: "清理尚未归档到文件夹的素材",
        to: "/assets?quickView=unfiled",
        keywords: ["unfiled", "inbox", "未分类", "待整理"]
      }
    ];
  }

  return [];
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore storage access restrictions
  }
  return null;
}

export function loadRecentVisits(storageOverride?: Storage | null): RecentVisitRecord[] {
  const storage = storageOverride === undefined ? getStorage() : storageOverride;
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentVisitRecord =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as RecentVisitRecord).to === "string" &&
          typeof (item as RecentVisitRecord).title === "string" &&
          typeof (item as RecentVisitRecord).kind === "string"
      )
      .slice(0, MAX_RECENT_VISITS);
  } catch {
    return [];
  }
}

export function recordRecentVisit(
  entry: Omit<RecentVisitRecord, "visitedAt">,
  storageOverride?: Storage | null
): RecentVisitRecord[] {
  const storage = storageOverride === undefined ? getStorage() : storageOverride;
  const normalizedTo = entry.to.trim();
  if (!normalizedTo) return loadRecentVisits(storage);

  const current = loadRecentVisits(storage).filter((item) => item.to !== normalizedTo);
  const next: RecentVisitRecord[] = [
    {
      ...entry,
      to: normalizedTo,
      visitedAt: Date.now()
    },
    ...current
  ].slice(0, MAX_RECENT_VISITS);

  if (storage) {
    try {
      storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  }

  return next;
}

export function clearRecentVisits(storageOverride?: Storage | null): void {
  const storage = storageOverride === undefined ? getStorage() : storageOverride;
  if (!storage) return;
  try {
    storage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
