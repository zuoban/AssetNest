import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Box,
  Clock,
  HardDrive,
  Images,
  LayoutDashboard,
  Layers,
  Lock,
  LogOut,
  Menu,
  Package,
  Settings,
  ShieldCheck,
  Sliders,
  Store,
  Trash2,
  X
} from "lucide-react";
import type { AuthMeResponse, StorageProviderSummary } from "../../shared/types";
import { api } from "../api/client";

interface LayoutProps {
  auth: AuthMeResponse;
  onLogout: () => Promise<void>;
  children: ReactNode;
}

const NAV_ITEMS = [
  { to: "/", label: "工作台", icon: LayoutDashboard, end: true },
  { to: "/products", label: "商品中心", icon: Package, end: false },
  { to: "/listings", label: "上架工作台", icon: Layers, end: false },
  { to: "/templates", label: "导出模板", icon: Sliders, end: false },
  { to: "/assets", label: "全部素材", icon: Images, end: false },
  { to: "/stores", label: "店铺与字典", icon: Store, end: false },
  { to: "/trash", label: "回收站", icon: Trash2, end: false },
  { to: "/storage", label: "存储管理", icon: HardDrive, end: false },
  { to: "/jobs", label: "任务与审计", icon: Activity, end: false },
  { to: "/settings", label: "通用设置", icon: Settings, end: false }
];

function resolvePageSection(pathname: string): { title: string; wide: boolean } {
  if (pathname === "/") return { title: "工作台", wide: false };
  if (pathname.startsWith("/products/")) return { title: "商品中心 · 商品详情", wide: false };
  if (pathname.startsWith("/products")) return { title: "商品中心", wide: false };
  if (pathname.startsWith("/listings/")) return { title: "上架工作台 · 链接编排", wide: true };
  if (pathname.startsWith("/listings")) return { title: "上架工作台", wide: false };
  if (pathname.startsWith("/templates")) return { title: "导出模板规则", wide: false };
  if (pathname.startsWith("/assets")) return { title: "全部素材 · 三栏工作台", wide: true };
  if (pathname.startsWith("/stores")) return { title: "店铺与渠道字典", wide: false };
  if (pathname.startsWith("/trash")) return { title: "回收站与安全 GC", wide: false };
  if (pathname.startsWith("/storage")) return { title: "存储管理", wide: false };
  if (pathname.startsWith("/jobs")) return { title: "任务与审计日志", wide: false };
  if (pathname.startsWith("/settings")) return { title: "通用设置与备份", wide: false };
  return { title: "AssetNest", wide: false };
}

export function Layout({ auth, onLogout, children }: LayoutProps) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [offlineStorages, setOfflineStorages] = useState<StorageProviderSummary[]>([]);
  const [runningJobs, setRunningJobs] = useState(0);
  const [failedJobs, setFailedJobs] = useState(0);

  const refreshSystemSignals = useCallback(async () => {
    try {
      const dash = await api.getDashboard();
      setRunningJobs(dash.counts.runningJobs);
      setFailedJobs(dash.counts.failedJobs);
      setOfflineStorages(
        dash.storageSummary.filter(
          (st) => st.status === "offline" || st.status === "missing_config" || st.status === "degraded"
        )
      );
    } catch {
      // Keep layout non-blocking if transient poll fails
    }
  }, []);

  useEffect(() => {
    void refreshSystemSignals();
  }, [location.pathname, refreshSystemSignals]);

  const pageMeta = resolvePageSection(location.pathname);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  const navContent = (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-14 items-center gap-2.5 border-b border-gray-200 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
          <Box className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-gray-900">
            {auth.appName}
          </div>
          <div className="font-mono-tabular text-[11px] text-gray-500">v{auth.version}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setDrawerOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-gray-200 p-3">
        {auth.authEnabled ? (
          <>
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
              <Lock className="h-3.5 w-3.5 shrink-0 text-blue-600" />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-gray-900">访问码保护</div>
                <div className="truncate text-[11px] text-gray-500">已验证当前会话</div>
              </div>
            </div>
            <button
              type="button"
              disabled={loggingOut}
              onClick={() => void handleLogout()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{loggingOut ? "正在退出..." : "退出登录"}</span>
            </button>
          </>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-gray-900">免登录模式</div>
              <div className="truncate text-[11px] text-gray-500">未配置访问码</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#F8F9FA] text-gray-900">
      <aside className="hidden w-[224px] shrink-0 border-r border-gray-200 lg:block">
        <div className="sticky top-0 h-screen">{navContent}</div>
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-gray-900/30"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="relative z-10 w-[240px] border-r border-gray-200 bg-white shadow-lg">
            <button
              type="button"
              aria-label="关闭导航"
              onClick={() => setDrawerOpen(false)}
              className="absolute top-3 right-3 rounded-md p-1 text-gray-500 hover:bg-gray-100"
            >
              <X className="h-4 w-4" />
            </button>
            {navContent}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-13 items-center justify-between gap-3 border-b border-gray-200 bg-white/95 px-4 backdrop-blur-sm lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="打开导航"
              onClick={() => setDrawerOpen(true)}
              className="rounded-md border border-gray-200 p-1.5 text-gray-600 hover:bg-gray-50 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <span className="truncate text-sm font-medium text-gray-800">{pageMeta.title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {offlineStorages.length > 0 && (
              <Link
                to="/storage"
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>{offlineStorages.length} 个存储异常</span>
              </Link>
            )}
            {runningJobs > 0 && (
              <Link
                to="/jobs"
                className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-100"
              >
                <Clock className="h-3.5 w-3.5 shrink-0 animate-pulse" />
                <span className="font-mono-tabular">{runningJobs} 个任务运行中</span>
              </Link>
            )}
            {failedJobs > 0 && (
              <Link
                to="/jobs"
                className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 transition-colors hover:bg-rose-100"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono-tabular">{failedJobs} 个失败任务</span>
              </Link>
            )}
            <div className="font-mono-tabular hidden text-xs text-gray-500 sm:block">
              时区：{auth.timezone}
            </div>
          </div>
        </header>

        <main
          className={`mx-auto w-full flex-1 p-4 lg:p-5 ${
            pageMeta.wide ? "max-w-[1680px]" : "max-w-[1400px]"
          }`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
