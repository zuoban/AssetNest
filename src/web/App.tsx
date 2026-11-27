import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { AuthMeResponse } from "../shared/types";
import { api, ApiClientError } from "./api/client";
import { Layout } from "./components/Layout";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";

const AssetsPage = lazy(() =>
  import("./pages/AssetsPage").then((m) => ({ default: m.AssetsPage }))
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage }))
);
const JobsPage = lazy(() =>
  import("./pages/JobsPage").then((m) => ({ default: m.JobsPage }))
);
const ListingsPage = lazy(() =>
  import("./pages/ListingsPage").then((m) => ({ default: m.ListingsPage }))
);
const ListingWorkbenchPage = lazy(() =>
  import("./pages/ListingWorkbenchPage").then((m) => ({ default: m.ListingWorkbenchPage }))
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage }))
);
const ProductDetailPage = lazy(() =>
  import("./pages/ProductDetailPage").then((m) => ({ default: m.ProductDetailPage }))
);
const ProductsPage = lazy(() =>
  import("./pages/ProductsPage").then((m) => ({ default: m.ProductsPage }))
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const StoragePage = lazy(() =>
  import("./pages/StoragePage").then((m) => ({ default: m.StoragePage }))
);
const StoresPage = lazy(() =>
  import("./pages/StoresPage").then((m) => ({ default: m.StoresPage }))
);
const TemplatesPage = lazy(() =>
  import("./pages/TemplatesPage").then((m) => ({ default: m.TemplatesPage }))
);
const TrashPage = lazy(() =>
  import("./pages/TrashPage").then((m) => ({ default: m.TrashPage }))
);

function RouteLoadingFallback() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-xs text-gray-500">
      正在加载页面...
    </div>
  );
}

function AppRoutes({ onTimezoneChanged }: { onTimezoneChanged: () => Promise<void> }) {
  const location = useLocation();
  return (
    <RouteErrorBoundary resetKey={`${location.pathname}${location.search}`}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/listings" element={<ListingsPage />} />
          <Route path="/listings/:id" element={<ListingWorkbenchPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/stores" element={<StoresPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route
            path="/settings"
            element={<SettingsPage onTimezoneChanged={onTimezoneChanged} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  );
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState<AuthMeResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshAuthState = useCallback(async () => {
    setBootError(null);
    try {
      const status = await api.getAuthStatus();
      if (status.authEnabled && !status.authenticated) {
        setAuth(null);
        return;
      }
      try {
        const me = await api.getMe();
        setAuth(me);
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) {
          setAuth(null);
        } else {
          throw err;
        }
      }
    } catch (err) {
      setBootError(err instanceof Error ? err.message : "无法连接到 AssetNest 服务");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuthState();
  }, [refreshAuthState]);

  const handleLogout = async () => {
    await api.logout();
    setAuth(null);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F9FA] text-sm text-gray-500">
        正在检查 AssetNest 运行状态...
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F9FA] p-4">
        <div className="max-w-md rounded-xl border border-rose-200 bg-white p-6 text-center">
          <h1 className="text-base font-semibold text-gray-900">服务连接异常</h1>
          <p className="mt-2 text-xs text-rose-600">{bootError}</p>
          <button
            type="button"
            onClick={() => void refreshAuthState()}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
          >
            重新连接
          </button>
        </div>
      </div>
    );
  }

  if (!auth) {
    return (
      <RouteErrorBoundary>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center bg-[#F8F9FA] text-sm text-gray-500">
              正在加载登录页面...
            </div>
          }
        >
          <LoginPage onLoggedIn={refreshAuthState} />
        </Suspense>
      </RouteErrorBoundary>
    );
  }

  return (
    <BrowserRouter>
      <Layout auth={auth} onLogout={handleLogout}>
        <AppRoutes onTimezoneChanged={refreshAuthState} />
      </Layout>
    </BrowserRouter>
  );
}
