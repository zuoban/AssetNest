import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileCheck2,
  Info,
  Plus,
  RefreshCw,
  Save,
  Sliders
} from "lucide-react";
import type {
  DictionariesResponse,
  ExportTemplateRecord,
  ExportTemplateRules,
  PdpRequiredField
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { formatDateTime } from "../utils/format";

const DEFAULT_RULES: ExportTemplateRules = {
  folders: {
    carousel: "01_Carousel",
    sku: "02_SKU",
    detail: "03_Detail",
    video: "04_Video",
    pdp: "05_PDP"
  },
  carousel: {
    minCount: 1,
    targetCount: 9,
    maxCount: 9,
    aspectRatio: "1:1",
    aspectTolerance: 0.05,
    minWidth: 800,
    minHeight: 800,
    maxFileSizeMB: 10,
    allowedExts: ["jpg", "jpeg", "png", "webp"]
  },
  detail: {
    minCount: 0,
    maxCount: 20,
    aspectRatio: "9:16",
    aspectTolerance: 0.15,
    minWidth: 750,
    minHeight: 800,
    maxFileSizeMB: 10,
    allowedExts: ["jpg", "jpeg", "png", "webp"]
  },
  sku: {
    required: true,
    minWidth: 600,
    minHeight: 600,
    maxFileSizeMB: 10,
    allowedExts: ["jpg", "jpeg", "png", "webp"]
  },
  video: {
    maxCount: 2,
    maxFileSizeMB: 100,
    allowedExts: ["mp4", "mov", "webm"]
  },
  pdp: {
    maxTitleCodePoints: 120,
    requiredFields: ["title", "description"]
  },
  naming: {
    carouselPrefix: "Carousel",
    mainImageName: "01_Main",
    detailPrefix: "Detail",
    videoPrefix: "Video"
  }
};

const PDP_FIELD_OPTIONS: Array<{ value: PdpRequiredField; label: string }> = [
  { value: "title", label: "商品标题" },
  { value: "description", label: "完整描述" },
  { value: "shortDescription", label: "短描述" },
  { value: "bullets", label: "核心卖点" },
  { value: "specs", label: "规格参数表" },
  { value: "packageList", label: "包装清单" },
  { value: "usageInstructions", label: "使用说明" }
];

export function TemplatesPage() {
  const [templates, setTemplates] = useState<ExportTemplateRecord[]>([]);
  const [dictionaries, setDictionaries] = useState<DictionariesResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("shopee");
  const [market, setMarket] = useState("PH");
  const [isDefault, setIsDefault] = useState(false);
  const [rules, setRules] = useState<ExportTemplateRules>(DEFAULT_RULES);
  const [carouselExtsText, setCarouselExtsText] = useState("jpg, jpeg, png, webp");
  const [detailExtsText, setDetailExtsText] = useState("jpg, jpeg, png, webp");
  const [skuExtsText, setSkuExtsText] = useState("jpg, jpeg, png, webp");
  const [videoExtsText, setVideoExtsText] = useState("mp4, mov, webm");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  const isCreatingRef = useRef(false);
  const loadReqSeqRef = useRef(0);

  const hydrateForm = useCallback((tpl: ExportTemplateRecord) => {
    selectedIdRef.current = tpl.id;
    isCreatingRef.current = false;
    setSelectedId(tpl.id);
    setIsCreating(false);
    setName(tpl.name);
    setPlatform(tpl.platform);
    setMarket(tpl.market);
    setIsDefault(tpl.isDefault);
    setRules(structuredClone(tpl.rules));
    setCarouselExtsText(tpl.rules.carousel.allowedExts.join(", "));
    setDetailExtsText(tpl.rules.detail.allowedExts.join(", "));
    setSkuExtsText(tpl.rules.sku.allowedExts.join(", "));
    setVideoExtsText(tpl.rules.video.allowedExts.join(", "));
  }, []);

  const load = useCallback(async () => {
    const reqSeq = ++loadReqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [tplRes, dictRes] = await Promise.all([
        api.listExportTemplates(),
        api.getDictionaries()
      ]);
      if (reqSeq !== loadReqSeqRef.current) return;
      setTemplates(tplRes.items);
      setDictionaries(dictRes);
      const currentSelectedId = selectedIdRef.current;
      const currentlyCreating = isCreatingRef.current;
      if (tplRes.items.length > 0 && !currentSelectedId && !currentlyCreating) {
        hydrateForm(tplRes.items[0]!);
      } else if (currentSelectedId) {
        const current = tplRes.items.find((item) => item.id === currentSelectedId);
        if (current) {
          hydrateForm(current);
        } else if (tplRes.items.length > 0) {
          hydrateForm(tplRes.items[0]!);
        } else {
          selectedIdRef.current = null;
          setSelectedId(null);
        }
      }
    } catch (err) {
      if (reqSeq !== loadReqSeqRef.current) return;
      setError(err instanceof ApiClientError ? err.message : "加载导出模板失败");
    } finally {
      if (reqSeq === loadReqSeqRef.current) {
        setLoading(false);
      }
    }
  }, [hydrateForm]);

  useEffect(() => {
    void load();
  }, [load]);

  const startCreate = () => {
    isCreatingRef.current = true;
    selectedIdRef.current = null;
    setIsCreating(true);
    setSelectedId(null);
    setError(null);
    setNotice(null);
    setName("");
    setPlatform(
      dictionaries?.platforms.find((d) => d.isActive)?.code ??
        dictionaries?.platforms[0]?.code ??
        "shopee"
    );
    setMarket(
      dictionaries?.markets.find((d) => d.isActive)?.code ??
        dictionaries?.markets[0]?.code ??
        "PH"
    );
    setIsDefault(false);
    setRules(structuredClone(DEFAULT_RULES));
    setCarouselExtsText(DEFAULT_RULES.carousel.allowedExts.join(", "));
    setDetailExtsText(DEFAULT_RULES.detail.allowedExts.join(", "));
    setSkuExtsText(DEFAULT_RULES.sku.allowedExts.join(", "));
    setVideoExtsText(DEFAULT_RULES.video.allowedExts.join(", "));
  };

  const parseExtCsv = (csv: string): string[] =>
    csv
      .split(/[,\s]+/)
      .map((item) => item.trim().toLowerCase().replace(/^\.+/, ""))
      .filter(Boolean);

  const toggleRequiredField = (field: PdpRequiredField) => {
    setRules((prev) => {
      const has = prev.pdp.requiredFields.includes(field);
      return {
        ...prev,
        pdp: {
          ...prev.pdp,
          requiredFields: has
            ? prev.pdp.requiredFields.filter((f) => f !== field)
            : [...prev.pdp.requiredFields, field]
        }
      };
    });
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);

    const nextRules: ExportTemplateRules = {
      folders: rules.folders,
      pdp: rules.pdp,
      naming: rules.naming,
      carousel: { ...rules.carousel, allowedExts: parseExtCsv(carouselExtsText) },
      detail: { ...rules.detail, allowedExts: parseExtCsv(detailExtsText) },
      sku: { ...rules.sku, allowedExts: parseExtCsv(skuExtsText) },
      video: { ...rules.video, allowedExts: parseExtCsv(videoExtsText) }
    };

    try {
      if (isCreating || !selectedId) {
        const created = await api.createExportTemplate({
          name,
          platform,
          market,
          isDefault,
          rules: nextRules
        });
        setNotice(`已新建导出模板「${created.name}」(v${created.version})`);
        hydrateForm(created);
        const refreshed = await api.listExportTemplates();
        setTemplates(refreshed.items);
      } else {
        const updated = await api.updateExportTemplate(selectedId, {
          name,
          platform,
          market,
          isDefault,
          rules: nextRules
        });
        setNotice(
          `已更新导出模板「${updated.name}」至 v${updated.version}（历史 Release 仍保留其发布时的模板版本快照）`
        );
        hydrateForm(updated);
        const refreshed = await api.listExportTemplates();
        setTemplates(refreshed.items);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "保存导出模板失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">导出模板规则</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            配置各平台/市场的文件夹结构、图片数量/比例/分辨率及 PDP 必填字段；每次保存自动递增版本号
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
          <button
            type="button"
            onClick={startCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            新建模板
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-3 text-xs text-blue-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
        <span>
          内置模板为可编辑的业务示例配置（非 Shopee / TikTok 官方实时规则）。请按各站点卖家后台的实际要求调整数量、比例与尺寸阈值。
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <aside className="space-y-2 lg:col-span-4">
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-gray-700">
                模板列表（{templates.length}）
              </span>
            </div>
            <div className="space-y-1.5">
              {templates.map((tpl) => {
                const active = !isCreating && selectedId === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      hydrateForm(tpl);
                    }}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      active
                        ? "border-blue-300 bg-blue-50/70"
                        : "border-gray-200 bg-white hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-gray-900">
                        {tpl.name}
                      </span>
                      <span className="font-mono-tabular shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700">
                        v{tpl.version}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono-tabular">
                        {tpl.platform}
                      </span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono-tabular">
                        {tpl.market}
                      </span>
                      {tpl.isDefault && (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                          默认
                        </span>
                      )}
                    </div>
                    <div className="mt-1 font-mono-tabular text-[10px] text-gray-400">
                      更新于 {formatDateTime(tpl.updatedAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="lg:col-span-8">
          <form
            onSubmit={(e) => void handleSave(e)}
            className="space-y-5 rounded-xl border border-gray-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-blue-600" />
                <h2 className="text-sm font-semibold text-gray-900">
                  {isCreating ? "新建导出模板" : `编辑模板：${name}`}
                </h2>
              </div>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? "保存中..." : isCreating ? "创建模板" : "保存并递增版本"}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className="mb-1 block font-medium text-gray-700">模板名称</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Shopee PH 正式上架模板"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">平台</label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  {(dictionaries?.platforms ?? []).map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.label} ({p.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-gray-700">市场</label>
                <select
                  value={market}
                  onChange={(e) => setMarket(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                >
                  {(dictionaries?.markets ?? []).map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.label} ({m.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end pb-1">
                <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={(e) => setIsDefault(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                  />
                  设为该平台/市场默认模板
                </label>
              </div>
            </div>

            {/* Folder Structure */}
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <h3 className="text-xs font-semibold text-gray-900">ZIP 标准目录命名</h3>
              <div className="grid grid-cols-2 gap-2.5 text-xs sm:grid-cols-5">
                {(
                  [
                    ["carousel", "轮播图目录"],
                    ["sku", "SKU 图目录"],
                    ["detail", "详情图目录"],
                    ["video", "视频目录"],
                    ["pdp", "PDP 文案目录"]
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <label className="mb-1 block text-[11px] text-gray-600">{label}</label>
                    <input
                      type="text"
                      required
                      value={rules.folders[key]}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          folders: { ...prev.folders, [key]: e.target.value }
                        }))
                      }
                      className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Carousel Rules */}
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <h3 className="text-xs font-semibold text-gray-900">轮播图 / 主图规则</h3>
              <div className="grid grid-cols-2 gap-2.5 text-xs sm:grid-cols-4">
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">最少张数（阻断）</label>
                  <input
                    type="number"
                    min={0}
                    value={rules.carousel.minCount}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, minCount: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">推荐张数（提醒）</label>
                  <input
                    type="number"
                    min={0}
                    value={rules.carousel.targetCount}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, targetCount: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">最多张数（阻断）</label>
                  <input
                    type="number"
                    min={1}
                    value={rules.carousel.maxCount}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, maxCount: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">目标比例 (W:H)</label>
                  <input
                    type="text"
                    value={rules.carousel.aspectRatio}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, aspectRatio: e.target.value }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">最小宽度 (px)</label>
                  <input
                    type="number"
                    min={0}
                    value={rules.carousel.minWidth}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, minWidth: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">最小高度 (px)</label>
                  <input
                    type="number"
                    min={0}
                    value={rules.carousel.minHeight}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, minHeight: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">单文件上限 (MB)</label>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    value={rules.carousel.maxFileSizeMB}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        carousel: { ...prev.carousel, maxFileSizeMB: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">允许格式 (逗号分隔)</label>
                  <input
                    type="text"
                    value={carouselExtsText}
                    onChange={(e) => setCarouselExtsText(e.target.value)}
                    className="font-mono-tabular w-full rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
              </div>
            </div>

            {/* Detail / SKU / Video Rules */}
            <div className="grid grid-cols-1 gap-4 border-t border-gray-100 pt-4 sm:grid-cols-3 text-xs">
              <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                <h4 className="font-semibold text-gray-900">详情图规则</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-gray-600">最少/最多</label>
                    <div className="mt-0.5 flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        value={rules.detail.minCount}
                        onChange={(e) =>
                          setRules((prev) => ({
                            ...prev,
                            detail: { ...prev.detail, minCount: Number(e.target.value) }
                          }))
                        }
                        className="font-mono-tabular w-full rounded border border-gray-200 bg-white px-2 py-1"
                      />
                      <span>-</span>
                      <input
                        type="number"
                        min={0}
                        value={rules.detail.maxCount}
                        onChange={(e) =>
                          setRules((prev) => ({
                            ...prev,
                            detail: { ...prev.detail, maxCount: Number(e.target.value) }
                          }))
                        }
                        className="font-mono-tabular w-full rounded border border-gray-200 bg-white px-2 py-1"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-600">目标比例</label>
                    <input
                      type="text"
                      value={rules.detail.aspectRatio}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          detail: { ...prev.detail, aspectRatio: e.target.value }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-600">允许格式</label>
                  <input
                    type="text"
                    value={detailExtsText}
                    onChange={(e) => setDetailExtsText(e.target.value)}
                    className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                <h4 className="font-semibold text-gray-900">SKU 图规则</h4>
                <label className="inline-flex cursor-pointer items-center gap-2 text-gray-700">
                  <input
                    type="checkbox"
                    checked={rules.sku.required}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        sku: { ...prev.sku, required: e.target.checked }
                      }))
                    }
                    className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600"
                  />
                  所有已绑定 SKU 必须配图
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-gray-600">最小宽 (px)</label>
                    <input
                      type="number"
                      min={0}
                      value={rules.sku.minWidth}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          sku: { ...prev.sku, minWidth: Number(e.target.value) }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-600">上限 (MB)</label>
                    <input
                      type="number"
                      min={1}
                      value={rules.sku.maxFileSizeMB}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          sku: { ...prev.sku, maxFileSizeMB: Number(e.target.value) }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-600">允许格式</label>
                  <input
                    type="text"
                    value={skuExtsText}
                    onChange={(e) => setSkuExtsText(e.target.value)}
                    className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                <h4 className="font-semibold text-gray-900">视频规则</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-gray-600">最多数量</label>
                    <input
                      type="number"
                      min={0}
                      value={rules.video.maxCount}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          video: { ...prev.video, maxCount: Number(e.target.value) }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-600">上限 (MB)</label>
                    <input
                      type="number"
                      min={1}
                      value={rules.video.maxFileSizeMB}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          video: { ...prev.video, maxFileSizeMB: Number(e.target.value) }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-600">允许格式</label>
                  <input
                    type="text"
                    value={videoExtsText}
                    onChange={(e) => setVideoExtsText(e.target.value)}
                    className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1"
                  />
                </div>
              </div>
            </div>

            {/* PDP and naming */}
            <div className="grid grid-cols-1 gap-4 border-t border-gray-100 pt-4 sm:grid-cols-2 text-xs">
              <div className="space-y-2">
                <h3 className="flex items-center gap-1.5 font-semibold text-gray-900">
                  <FileCheck2 className="h-3.5 w-3.5 text-blue-600" />
                  PDP 文案检查
                </h3>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-600">
                    标题建议最大 Unicode 字符数
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={2000}
                    value={rules.pdp.maxTitleCodePoints}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        pdp: { ...prev.pdp, maxTitleCodePoints: Number(e.target.value) }
                      }))
                    }
                    className="font-mono-tabular w-40 rounded-lg border border-gray-200 px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-gray-600">正式发布必填字段（阻断）</div>
                  <div className="flex flex-wrap gap-2">
                    {PDP_FIELD_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px]"
                      >
                        <input
                          type="checkbox"
                          checked={rules.pdp.requiredFields.includes(opt.value)}
                          onChange={() => toggleRequiredField(opt.value)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600"
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="font-semibold text-gray-900">文件命名</h3>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-gray-600">主图文件名</label>
                    <input
                      type="text"
                      value={rules.naming.mainImageName}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          naming: { ...prev.naming, mainImageName: e.target.value }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 px-2 py-1"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-600">详情图前缀</label>
                    <input
                      type="text"
                      value={rules.naming.detailPrefix}
                      onChange={(e) =>
                        setRules((prev) => ({
                          ...prev,
                          naming: { ...prev.naming, detailPrefix: e.target.value }
                        }))
                      }
                      className="font-mono-tabular mt-0.5 w-full rounded border border-gray-200 px-2 py-1"
                    />
                  </div>
                </div>
              </div>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
