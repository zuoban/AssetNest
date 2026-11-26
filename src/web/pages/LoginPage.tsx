import { useState, type FormEvent } from "react";
import { AlertCircle, Box, Eye, EyeOff, KeyRound } from "lucide-react";
import { api, ApiClientError } from "../api/client";

interface LoginPageProps {
  onLoggedIn: () => Promise<void>;
}

export function LoginPage({ onLoggedIn }: LoginPageProps) {
  const [accessCode, setAccessCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.login({ accessCode });
      await onLoggedIn();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("登录请求失败，请检查网络连接");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8F9FA] p-4">
      <div className="w-full max-w-[420px] rounded-xl border border-gray-200 bg-white p-6 shadow-xs">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Box className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">登录 AssetNest</h1>
            <p className="text-xs text-gray-500">请输入访问码进入系统</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label
              className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-700"
              htmlFor="login-access-code"
            >
              <KeyRound className="h-3.5 w-3.5 text-gray-500" />
              <span>访问码</span>
            </label>
            <div className="relative">
              <input
                id="login-access-code"
                type={showCode ? "text" : "password"}
                required
                autoFocus
                autoComplete="current-password"
                placeholder="请输入访问码"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white py-2 pr-10 pl-3 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowCode((v) => !v)}
                aria-label={showCode ? "隐藏访问码" : "显示访问码"}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600"
              >
                {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "正在验证..." : "登录"}
          </button>
        </form>

        <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[11px] leading-relaxed text-gray-600">
          访问码由环境变量 <code className="font-mono-tabular text-gray-800">ASSETNEST_ACCESS_CODE</code>{" "}
          控制；如需修改访问码或取消登录，请调整该环境变量后重启服务。
        </div>
      </div>
    </div>
  );
}
