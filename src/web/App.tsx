import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { AuthMeResponse, SetupStatusResponse } from "../shared/types";
import { api, ApiClientError } from "./api/client";
import { Layout } from "./components/Layout";
import { AssetsPage } from "./pages/AssetsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { LoginPage } from "./pages/LoginPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
import { ProductsPage } from "./pages/ProductsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { StoragePage } from "./pages/StoragePage";
import { TrashPage } from "./pages/TrashPage";

export function App() {
  const [loading, setLoading] = useState(true);
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [auth, setAuth] = useState<AuthMeResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshAuthState = useCallback(async () => {
    setBootError(null);
    try {
      const status = await api.getSetupStatus();
      setSetupStatus(status);
      if (!status.initialized) {
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

  if (setupStatus && !setupStatus.initialized) {
    return <SetupPage setupStatus={setupStatus} onCompleted={refreshAuthState} />;
  }

  if (!auth) {
    return <LoginPage onLoggedIn={refreshAuthState} />;
  }

  return (
    <BrowserRouter>
      <Layout auth={auth} onLogout={handleLogout}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route
            path="/settings"
            element={<SettingsPage onTimezoneChanged={refreshAuthState} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
