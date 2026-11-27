import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Archive,
  BookOpen,
  CheckCircle2,
  Edit3,
  Plus,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X
} from "lucide-react";
import type {
  DictionariesResponse,
  DictionaryCategory,
  DictionaryRecord,
  StoreRecord,
  StoreStatus
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { ConfirmDialog, type ConfirmDialogState } from "../components/ConfirmDialog";
import { formatDateTime } from "../utils/format";

type PageTab = "stores" | "dictionaries";

const DICT_CATEGORY_META: Record<DictionaryCategory, { title: string; placeholderCode: string; placeholderLabel: string }> = {
  platform: { title: "平台字典", placeholderCode: "如 amazon", placeholderLabel: "如 Amazon" },
  market: { title: "市场字典", placeholderCode: "如 US", placeholderLabel: "如 美国 (US)" },
  language: { title: "语言字典", placeholderCode: "如 ja", placeholderLabel: "如 日语 (JA)" }
};

export function StoresPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<PageTab>(() =>
    searchParams.get("tab") === "dictionaries" ? "dictionaries" : "stores"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [dictionaries, setDictionaries] = useState<DictionariesResponse | null>(null);

  // Store filters
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [platformFilter, setPlatformFilter] = useState("");
  const [marketFilter, setMarketFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | StoreStatus>("");

  // Store create/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<StoreRecord | null>(null);
  const [storeName, setStoreName] = useState("");
  const [storePlatform, setStorePlatform] = useState("shopee");
  const [storeMarket, setStoreMarket] = useState("PH");
  const [storeLanguage, setStoreLanguage] = useState("en");
  const [storeStatus, setStoreStatus] = useState<StoreStatus>("active");
  const [storeNotes, setStoreNotes] = useState("");
  const [savingStore, setSavingStore] = useState(false);

  // Dictionary add form
  const [dictCategory, setDictCategory] = useState<DictionaryCategory>("platform");
  const [dictCode, setDictCode] = useState("");
  const [dictLabel, setDictLabel] = useState("");
  const [savingDict, setSavingDict] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [storesRes, dictsRes] = await Promise.all([
        api.listStores({
          q: q.trim() || undefined,
          platform: platformFilter || undefined,
          market: marketFilter || undefined,
          status: statusFilter || undefined
        }),
        api.getDictionaries()
      ]);
      setStores(storesRes.items);
      setDictionaries(dictsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载店铺与字典数据失败");
    } finally {
      setLoading(false);
    }
  }, [q, platformFilter, marketFilter, statusFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const labelOf = (category: DictionaryCategory, code: string): string => {
    const list =
      category === "platform"
        ? dictionaries?.platforms
        : category === "market"
          ? dictionaries?.markets
          : dictionaries?.languages;
    const found = list?.find((item) => item.code === code);
    return found ? found.label : code;
  };

  const openCreateModal = useCallback(() => {
    setEditingStore(null);
    setStoreName("");
    setStorePlatform(dictionaries?.platforms.find((d) => d.isActive)?.code ?? "shopee");
    setStoreMarket(dictionaries?.markets.find((d) => d.isActive)?.code ?? "PH");
    setStoreLanguage(dictionaries?.languages.find((d) => d.isActive)?.code ?? "en");
    setStoreStatus("active");
    setStoreNotes("");
    setModalOpen(true);
  }, [dictionaries]);

  const handleTabChange = useCallback(
    (nextTab: PageTab) => {
      setTab(nextTab);
      const nextParams = new URLSearchParams(searchParams);
      if (nextTab === "dictionaries") {
        nextParams.set("tab", "dictionaries");
      } else {
        nextParams.delete("tab");
      }
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  useEffect(() => {
    const urlTab = searchParams.get("tab");
    setTab(urlTab === "dictionaries" ? "dictionaries" : "stores");

    if (searchParams.has("q")) {
      setQ(searchParams.get("q") ?? "");
    }

    if (searchParams.get("action") === "new") {
      setTab("stores");
      openCreateModal();
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("action");
      setSearchParams(nextParams, { replace: true });
    }
  }, [searchParams, setSearchParams, openCreateModal]);

  useEffect(() => {
    if (!modalOpen || savingStore) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen, savingStore]);

  const openEditModal = (store: StoreRecord) => {
    setEditingStore(store);
    setStoreName(store.name);
    setStorePlatform(store.platform);
    setStoreMarket(store.market);
    setStoreLanguage(store.defaultLanguage);
    setStoreStatus(store.status);
    setStoreNotes(store.notes);
    setModalOpen(true);
  };

  const handleSaveStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeName.trim()) {
      setError("店铺名称不能为空");
      return;
    }
    setSavingStore(true);
    setError(null);
    setNotice(null);
    try {
      if (editingStore) {
        await api.updateStore(editingStore.id, {
          name: storeName.trim(),
          platform: storePlatform,
          market: storeMarket,
          defaultLanguage: storeLanguage,
          status: storeStatus,
          notes: storeNotes.trim()
        });
        setNotice(`已更新店铺「${storeName.trim()}」`);
      } else {
        await api.createStore({
          name: storeName.trim(),
          platform: storePlatform,
          market: storeMarket,
          defaultLanguage: storeLanguage,
          status: storeStatus,
          notes: storeNotes.trim()
        });
        setNotice(`已创建店铺「${storeName.trim()}」`);
      }
      setModalOpen(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存店铺失败");
    } finally {
      setSavingStore(false);
    }
  };

  const handleToggleStoreArchive = async (store: StoreRecord) => {
    setError(null);
    setNotice(null);
    const nextStatus: StoreStatus = store.status === "active" ? "archived" : "active";
    try {
      await api.updateStore(store.id, { status: nextStatus });
      setNotice(
        nextStatus === "archived"
          ? `店铺「${store.name}」已归档`
          : `店铺「${store.name}」已重新启用`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新店铺状态失败");
    }
  };

  const handleDeleteStore = (store: StoreRecord) => {
    setConfirmDialog({
      title: "删除店铺",
      description: `确认删除店铺「${store.name}」吗？若店铺下已有上架链接，系统将阻止删除。`,
      confirmLabel: "删除店铺",
      tone: "danger",
      onConfirm: async () => {
        setConfirmBusy(true);
        setError(null);
        setNotice(null);
        try {
          await api.deleteStore(store.id);
          setConfirmDialog(null);
          setNotice(`已删除店铺「${store.name}」`);
          await loadData();
        } catch (err) {
          setConfirmDialog(null);
          if (err instanceof ApiClientError && err.status === 409) {
            setError(err.message);
          } else {
            setError(err instanceof Error ? err.message : "删除店铺失败");
          }
        } finally {
          setConfirmBusy(false);
        }
      }
    });
  };

  const handleAddDictionary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dictCode.trim() || !dictLabel.trim()) {
      setError("请填写字典编码和显示名称");
      return;
    }
    setSavingDict(true);
    setError(null);
    setNotice(null);
    try {
      await api.upsertDictionary({
        category: dictCategory,
        code: dictCode.trim(),
        label: dictLabel.trim(),
        isActive: true
      });
      setDictCode("");
      setDictLabel("");
      setNotice(`已添加${DICT_CATEGORY_META[dictCategory].title}项「${dictLabel.trim()}」`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存字典项失败");
    } finally {
      setSavingDict(false);
    }
  };

  const handleToggleDictionary = async (item: DictionaryRecord) => {
    setError(null);
    setNotice(null);
    try {
      await api.updateDictionary(item.category, item.code, { isActive: !item.isActive });
      setNotice(`已${item.isActive ? "停用" : "启用"}字典项「${item.label}」`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新字典项失败");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">店铺与渠道字典</h1>
          <p className="mt-1 text-xs text-gray-500">
            同一平台与市场支持维护多个独立店铺，平台、市场与语言字典支持自由扩展
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          {tab === "stores" && (
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              新建店铺
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-gray-200">
        <button
          type="button"
          onClick={() => handleTabChange("stores")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === "stores"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <Store className="h-4 w-4" />
          店铺管理 ({stores.length})
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("dictionaries")}
          className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === "dictionaries"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-600 hover:text-gray-900"
          }`}
        >
          <BookOpen className="h-4 w-4" />
          平台 / 市场 / 语言字典 ({dictionaries?.items.length ?? 0})
        </button>
      </div>

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

      {tab === "stores" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-gray-200 bg-white p-3">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索店铺名称或备注..."
                className="w-full rounded-lg border border-gray-200 py-1.5 pr-3 pl-8 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
            >
              <option value="">全部平台</option>
              {dictionaries?.platforms.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={marketFilter}
              onChange={(e) => setMarketFilter(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
            >
              <option value="">全部市场</option>
              {dictionaries?.markets.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | StoreStatus)}
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
            >
              <option value="">全部状态</option>
              <option value="active">启用中</option>
              <option value="archived">已归档</option>
            </select>
          </div>

          {loading ? (
            <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-xs text-gray-500">
              正在加载店铺列表...
            </div>
          ) : stores.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
              <Store className="mx-auto h-8 w-8 text-gray-400" />
              <p className="mt-2 text-sm font-medium text-gray-800">暂无店铺记录</p>
              <p className="mt-1 text-xs text-gray-500">
                先创建渠道店铺（如 PH Shopee 主店、PH TikTok 旗舰店、TH Shopee 店铺），再为商品建立上架链接
              </p>
              <button
                type="button"
                onClick={openCreateModal}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
                创建第一个店铺
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="border-b border-gray-200 bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-4 py-3 font-medium">店铺名称</th>
                    <th className="px-4 py-3 font-medium">平台 / 市场</th>
                    <th className="px-4 py-3 font-medium">默认语言</th>
                    <th className="px-4 py-3 font-medium">上架链接数</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">更新时间</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stores.map((store) => (
                    <tr key={store.id} className="hover:bg-gray-50/70">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{store.name}</div>
                        {store.notes && (
                          <div className="mt-0.5 line-clamp-1 text-[11px] text-gray-500">
                            {store.notes}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                            {labelOf("platform", store.platform)}
                          </span>
                          <span className="rounded-md border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
                            {labelOf("market", store.market)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {labelOf("language", store.defaultLanguage)}
                      </td>
                      <td className="px-4 py-3 font-mono-tabular">
                        <Link
                          to={`/listings?storeId=${encodeURIComponent(store.id)}`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {store.listingCount} 条
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {store.status === "active" ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" />
                            启用中
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            <Archive className="h-3 w-3" />
                            已归档
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono-tabular text-gray-500">
                        {formatDateTime(store.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditModal(store)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-100"
                          >
                            <Edit3 className="h-3 w-3" />
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleStoreArchive(store)}
                            className="rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-100"
                          >
                            {store.status === "active" ? "归档" : "启用"}
                          </button>
                          <button
                            type="button"
                            disabled={store.listingCount > 0}
                            title={
                              store.listingCount > 0
                                ? "该店铺下已有上架链接，禁止删除；请改为归档"
                                : "删除店铺"
                            }
                            onClick={() => void handleDeleteStore(store)}
                            className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Trash2 className="h-3 w-3" />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <form
            onSubmit={(e) => void handleAddDictionary(e)}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4"
          >
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-600">字典分类</label>
              <select
                value={dictCategory}
                onChange={(e) => setDictCategory(e.target.value as DictionaryCategory)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-800"
              >
                <option value="platform">平台 (platform)</option>
                <option value="market">市场 (market)</option>
                <option value="language">语言 (language)</option>
              </select>
            </div>
            <div className="min-w-[160px]">
              <label className="mb-1 block text-[11px] font-medium text-gray-600">编码 (code)</label>
              <input
                type="text"
                value={dictCode}
                onChange={(e) => setDictCode(e.target.value)}
                placeholder={DICT_CATEGORY_META[dictCategory].placeholderCode}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-[11px] font-medium text-gray-600">显示名称</label>
              <input
                type="text"
                value={dictLabel}
                onChange={(e) => setDictLabel(e.target.value)}
                placeholder={DICT_CATEGORY_META[dictCategory].placeholderLabel}
                className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={savingDict}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {savingDict ? "保存中..." : "新增 / 更新字典项"}
            </button>
          </form>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {(["platform", "market", "language"] as DictionaryCategory[]).map((category) => {
              const list =
                category === "platform"
                  ? dictionaries?.platforms ?? []
                  : category === "market"
                    ? dictionaries?.markets ?? []
                    : dictionaries?.languages ?? [];
              return (
                <div
                  key={category}
                  className="rounded-xl border border-gray-200 bg-white p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-900">
                      {DICT_CATEGORY_META[category].title}
                    </h2>
                    <span className="font-mono-tabular text-[11px] text-gray-500">
                      {list.length} 项
                    </span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {list.map((item) => (
                      <div
                        key={`${item.category}:${item.code}`}
                        className="flex items-center justify-between py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900">{item.label}</div>
                          <div className="font-mono-tabular text-[11px] text-gray-500">
                            {item.code}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleToggleDictionary(item)}
                          className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                            item.isActive
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              : "border-gray-200 bg-gray-100 text-gray-600 hover:bg-gray-200"
                          }`}
                        >
                          {item.isActive ? "已启用" : "已停用"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editingStore ? "编辑店铺" : "新建店铺"}
            className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">
                {editingStore ? "编辑店铺" : "新建店铺"}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveStore(e)} className="space-y-3.5 text-xs">
              <div>
                <label className="mb-1 block font-medium text-gray-700">店铺名称 *</label>
                <input
                  type="text"
                  required
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder="例如：PH Shopee 旗舰店"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="mb-1 block font-medium text-gray-700">平台 *</label>
                  <select
                    value={storePlatform}
                    onChange={(e) => setStorePlatform(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2"
                  >
                    {dictionaries?.platforms.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">市场 *</label>
                  <select
                    value={storeMarket}
                    onChange={(e) => setStoreMarket(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2"
                  >
                    {dictionaries?.markets.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-gray-700">默认语言 *</label>
                  <select
                    value={storeLanguage}
                    onChange={(e) => setStoreLanguage(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2"
                  >
                    {dictionaries?.languages.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">状态</label>
                <select
                  value={storeStatus}
                  onChange={(e) => setStoreStatus(e.target.value as StoreStatus)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2"
                >
                  <option value="active">启用中</option>
                  <option value="archived">已归档</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">备注</label>
                <textarea
                  rows={3}
                  value={storeNotes}
                  onChange={(e) => setStoreNotes(e.target.value)}
                  placeholder="记录店铺运营主体、账号别名等信息"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-gray-200 px-3.5 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingStore}
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingStore ? "保存中..." : "保存"}
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
