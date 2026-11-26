import { useState, type FormEvent } from "react";
import { AlertCircle, Box, ShieldCheck } from "lucide-react";
import type { SetupStatusResponse } from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { StorageStatusBadge } from "../components/StatusBadge";

interface SetupPageProps {
  setupStatus: SetupStatusResponse;
  onCompleted: () => Promise<void>;
}

export function SetupPage({ setupStatus, onCompleted }: SetupPageProps) {
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("系统管理员");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("管理员密码至少需要 8 个字符");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setSubmitting(true);
    try {
      await api.initAdmin({ username, displayName, password });
      await onCompleted();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("初始化失败，请检查服务日志");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8F9FA] p-4">
      <div className="w-full max-w-[460px] rounded-xl border border-gray-200 bg-white p-6 shadow-xs">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Box className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">初始化 AssetNest</h1>
            <p className="text-xs text-gray-500">
              创建本地唯一管理员账号；完成后初始化入口将永久锁定
            </p>
          </div>
        </div>

        <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-700">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <span>本地 SQLite 与存储配置已就绪</span>
          </div>
          <div className="space-y-1.5">
            {setupStatus.providersSummary.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between text-xs text-gray-600"
              >
                <span className="font-mono-tabular">
                  {provider.name} ({provider.id} · {provider.type.toUpperCase()})
                  {provider.isDefault ? " · 默认" : ""}
                </span>
                <StorageStatusBadge status={provider.status} />
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="setup-user">
              管理员用户名
            </label>
            <input
              id="setup-user"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="setup-name">
              显示名称
            </label>
            <input
              id="setup-name"
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="setup-pass">
              登录密码（至少 8 位）
            </label>
            <input
              id="setup-pass"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label
              className="mb-1 block text-xs font-medium text-gray-700"
              htmlFor="setup-confirm"
            >
              确认密码
            </label>
            <input
              id="setup-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "正在初始化..." : "完成初始化并进入系统"}
          </button>
        </form>
      </div>
    </div>
  );
}
