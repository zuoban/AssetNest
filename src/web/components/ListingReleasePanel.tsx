import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CopyPlus,
  Download,
  FileJson,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck
} from "lucide-react";
import type {
  ExportTemplateRecord,
  ListingDetail,
  ListingValidationResult,
  ReleaseDetail,
  ReleaseSummary
} from "../../shared/types";
import { api, ApiClientError } from "../api/client";
import { formatBytes, formatDateTime } from "../utils/format";
import { formatValidationCode, VALIDATION_TARGET_LABELS } from "../utils/labels";

interface ListingReleasePanelProps {
  listing: ListingDetail;
}

export function ListingReleasePanel({ listing }: ListingReleasePanelProps) {
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<ExportTemplateRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [validation, setValidation] = useState<ListingValidationResult | null>(null);
  const [validating, setValidating] = useState(false);

  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [expandedReleaseId, setExpandedReleaseId] = useState<string | null>(null);
  const [releaseDetailsMap, setReleaseDetailsMap] = useState<Record<string, ReleaseDetail>>({});

  const [releaseNote, setReleaseNote] = useState("");
  const [creatingMode, setCreatingMode] = useState<"formal" | "draft" | null>(null);
  const [exportingReleaseId, setExportingReleaseId] = useState<string | null>(null);
  const [restoringReleaseId, setRestoringReleaseId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const runValidation = useCallback(
    async (templateId?: string) => {
      setValidating(true);
      setError(null);
      try {
        const res = await api.validateListing(listing.id, templateId || undefined);
        setValidation(res);
        if (!templateId) {
          setSelectedTemplateId(res.templateId);
        }
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : "预检执行失败");
      } finally {
        setValidating(false);
      }
    },
    [listing.id]
  );

  const loadReleases = useCallback(async () => {
    try {
      const res = await api.listListingReleases(listing.id);
      setReleases(res.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载历史 Release 失败");
    }
  }, [listing.id]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [tplRes, relRes] = await Promise.all([
          api.listExportTemplates(),
          api.listListingReleases(listing.id)
        ]);
        if (cancelled) return;
        setTemplates(tplRes.items);
        setReleases(relRes.items);
        const preferred =
          tplRes.items.find(
            (t) => t.platform === listing.platform && t.market === listing.market && t.isDefault
          ) ??
          tplRes.items.find(
            (t) => t.platform === listing.platform && t.market === listing.market
          ) ??
          tplRes.items[0];
        if (preferred) {
          setSelectedTemplateId(preferred.id);
          await runValidation(preferred.id);
        } else {
          await runValidation();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : "加载发布模块失败");
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [listing.id, listing.market, listing.platform, runValidation]);

  const hasRunningExport = releases.some(
    (rel) => rel.latestExport?.status === "queued" || rel.latestExport?.status === "running"
  );
  useEffect(() => {
    if (!hasRunningExport) return;
    const timer = setInterval(() => {
      void loadReleases();
      if (expandedReleaseId) {
        void api
          .getReleaseDetail(expandedReleaseId)
          .then((detail) =>
            setReleaseDetailsMap((prev) => ({ ...prev, [expandedReleaseId]: detail }))
          )
          .catch(() => {});
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [expandedReleaseId, hasRunningExport, loadReleases]);

  const handleCreateRelease = async (isDraftPackage: boolean) => {
    setCreatingMode(isDraftPackage ? "draft" : "formal");
    setError(null);
    setNotice(null);
    try {
      const created = await api.createRelease(listing.id, {
        templateId: selectedTemplateId || undefined,
        isDraftPackage,
        note: releaseNote
      });
      setReleaseNote("");
      setReleaseDetailsMap((prev) => ({ ...prev, [created.id]: created }));
      setExpandedReleaseId(created.id);
      await loadReleases();
      const exp = await api.enqueueReleaseExport(created.id);
      setNotice(
        `已创建不可变${isDraftPackage ? "草稿导出包" : "正式 Release"} ${created.releaseCode}，并入队生成 ZIP（任务 ${exp.job.id.slice(0, 8)}）`
      );
      await loadReleases();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "创建 Release 失败");
    } finally {
      setCreatingMode(null);
    }
  };

  const handleEnqueueExport = async (releaseId: string, releaseCode: string) => {
    setExportingReleaseId(releaseId);
    setError(null);
    setNotice(null);
    try {
      const exp = await api.enqueueReleaseExport(releaseId);
      setNotice(
        `已从不可变历史快照 ${releaseCode} 入队重新生成流式 ZIP（任务 ${exp.job.id.slice(0, 8)}）`
      );
      await loadReleases();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "入队生成 ZIP 失败");
    } finally {
      setExportingReleaseId(null);
    }
  };

  const handleToggleDetails = async (releaseId: string) => {
    if (expandedReleaseId === releaseId) {
      setExpandedReleaseId(null);
      return;
    }
    setExpandedReleaseId(releaseId);
    try {
      const detail = await api.getReleaseDetail(releaseId);
      setReleaseDetailsMap((prev) => ({ ...prev, [releaseId]: detail }));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "加载 Release 详情失败");
    }
  };

  const handleRestoreDraft = async (release: ReleaseSummary) => {
    setRestoringReleaseId(release.id);
    setError(null);
    setNotice(null);
    try {
      const newListing = await api.restoreReleaseDraft(release.id);
      navigate(`/listings/${newListing.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "从历史 Release 恢复新草稿失败");
    } finally {
      setRestoringReleaseId(null);
    }
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <PackageCheck className="h-4 w-4 text-blue-600" />
              上架前规则预检与 Release 快照
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              逐一校验当前固定素材版本、存储对象可读性、审核状态、SKU 绑定与 PDP 必填字段
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value);
                void runValidation(e.target.value);
              }}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-800"
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} (v{tpl.version})
                </option>
              ))}
            </select>
            <Link
              to="/templates"
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              编辑模板
            </Link>
            <button
              type="button"
              disabled={validating}
              onClick={() => void runValidation(selectedTemplateId)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${validating ? "animate-spin" : ""}`} />
              重新预检
            </button>
          </div>
        </div>

        {validation && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 px-3.5 py-2.5 text-xs">
              {validation.canCreateFormalRelease ? (
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                  <ShieldCheck className="h-4 w-4" />
                  通过正式上架门槛（0 阻断错误）
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-semibold text-rose-700">
                  <ShieldAlert className="h-4 w-4" />
                  存在 {validation.blockers.length} 项阻断错误，禁止创建正式 Release
                </span>
              )}
              <span className="text-gray-300">|</span>
              <span className="font-mono-tabular text-gray-600">
                轮播 {validation.stats.carouselCount} · SKU图 {validation.stats.skuBoundCount}/
                {validation.stats.skuTotalCount} · 详情 {validation.stats.detailCount} · 视频{" "}
                {validation.stats.videoCount} · 标题 {validation.stats.titleCodePoints} 字符
              </span>
            </div>

            {validation.blockers.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50/70 p-3.5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-rose-800">
                  <AlertCircle className="h-4 w-4" />
                  阻断错误（必须修复后才能创建正式 Release）
                </div>
                <ul className="space-y-1.5 text-xs text-rose-700">
                  {validation.blockers.map((issue, idx) => (
                    <li key={`${issue.code}-${idx}`} className="flex items-start gap-2">
                      <span
                        title={issue.code}
                        className="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-800"
                      >
                        {formatValidationCode(issue.code)}
                      </span>
                      {issue.targetKind && (
                        <span className="shrink-0 rounded border border-rose-200 bg-white px-1.5 py-0.5 text-[10px] text-rose-700">
                          {VALIDATION_TARGET_LABELS[issue.targetKind]}
                        </span>
                      )}
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {validation.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3.5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                  <AlertTriangle className="h-4 w-4" />
                  提醒项（不阻断发布，建议发布前人工核对）
                </div>
                <ul className="space-y-1.5 text-xs text-amber-800">
                  {validation.warnings.map((issue, idx) => (
                    <li key={`${issue.code}-${idx}`} className="flex items-start gap-2">
                      <span
                        title={issue.code}
                        className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                      >
                        {formatValidationCode(issue.code)}
                      </span>
                      {issue.targetKind && (
                        <span className="shrink-0 rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[10px] text-amber-800">
                          {VALIDATION_TARGET_LABELS[issue.targetKind]}
                        </span>
                      )}
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-gray-100 pt-4">
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-700">
              本次发布说明（可选，将永久写入不可变快照）
            </label>
            <input
              type="text"
              value={releaseNote}
              onChange={(e) => setReleaseNote(e.target.value)}
              placeholder="例如：2026 双十一菲律宾主图与英文 PDP 首版"
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={creatingMode !== null || !validation?.canCreateFormalRelease}
              onClick={() => void handleCreateRelease(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {creatingMode === "formal" ? "正在创建正式 Release..." : "创建正式 Release 并打包 ZIP"}
            </button>
            <button
              type="button"
              disabled={creatingMode !== null}
              onClick={() => void handleCreateRelease(true)}
              title="允许带阻断项导出，但包内与清单会明确标记为 DRAFT 草稿包"
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              {creatingMode === "draft" ? "正在生成草稿包..." : "导出草稿包（明确标记 DRAFT）"}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              不可变历史 Release 列表（{releases.length}）
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Release 一经创建永久不可修改；即使后续改动当前草稿，仍可随时重新流式导出内容一致的历史 ZIP，或恢复为新的独立草稿
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadReleases()}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw className="h-3 w-3" />
            刷新
          </button>
        </div>

        {releases.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-xs text-gray-500">
            暂无发布记录。请通过上方预检后创建首个正式 Release 或草稿导出包。
          </div>
        ) : (
          <div className="space-y-3">
            {releases.map((rel) => {
              const expanded = expandedReleaseId === rel.id;
              const detail = releaseDetailsMap[rel.id];
              const latestExp = rel.latestExport;

              return (
                <div
                  key={rel.id}
                  className="overflow-hidden rounded-xl border border-gray-200 bg-white"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono-tabular text-sm font-bold text-gray-900">
                          {rel.releaseCode}
                        </span>
                        {rel.isDraftPackage ? (
                          <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            草稿包 (DRAFT)
                          </span>
                        ) : (
                          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            正式 Release
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          模板：{rel.templateName} (v{rel.templateVersion})
                        </span>
                        <span className="font-mono-tabular text-xs text-gray-500">
                          · {rel.assetCount} 个素材
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
                        <span className="font-mono-tabular">
                          创建于 {formatDateTime(rel.createdAt)}
                        </span>
                        {rel.note && <span className="text-gray-700">备注：{rel.note}</span>}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {latestExp?.status === "ready" && (
                        <a
                          href={api.exportDownloadUrl(latestExp.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                        >
                          <Download className="h-3.5 w-3.5" />
                          下载 ZIP
                          {latestExp.sizeBytes ? ` (${formatBytes(latestExp.sizeBytes)})` : ""}
                        </a>
                      )}
                      {(latestExp?.status === "queued" || latestExp?.status === "running") && (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          ZIP 打包中...
                        </span>
                      )}
                      {latestExp?.status === "expired" && (
                        <span className="rounded border border-gray-200 bg-gray-100 px-2 py-1 text-[11px] text-gray-600">
                          上次 ZIP 已过期
                        </span>
                      )}
                      {latestExp?.status === "failed" && (
                        <span
                          className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700"
                          title={latestExp.lastError ?? ""}
                        >
                          打包失败：{latestExp.lastError?.slice(0, 32)}
                        </span>
                      )}

                      <button
                        type="button"
                        disabled={exportingReleaseId === rel.id}
                        onClick={() => void handleEnqueueExport(rel.id, rel.releaseCode)}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <Archive className="h-3.5 w-3.5" />
                        {latestExp ? "重新生成 ZIP" : "生成 ZIP"}
                      </button>

                      <button
                        type="button"
                        disabled={restoringReleaseId === rel.id}
                        onClick={() => void handleRestoreDraft(rel)}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <CopyPlus className="h-3.5 w-3.5" />
                        {restoringReleaseId === rel.id ? "恢复中..." : "恢复为新草稿"}
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleToggleDetails(rel.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
                      >
                        <FileJson className="h-3.5 w-3.5" />
                        清单详情
                        {expanded ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {expanded && detail && (
                    <div className="border-t border-gray-100 bg-gray-50/70 px-4 py-3 text-xs space-y-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <div className="mb-1.5 font-semibold text-gray-800">
                            导出路径与哈希清单（{detail.assets.length} 个原文件）
                          </div>
                          <div className="max-h-52 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                            <table className="w-full text-left text-[11px]">
                              <thead className="bg-gray-50 text-gray-500">
                                <tr>
                                  <th className="px-2.5 py-1.5">导出相对路径</th>
                                  <th className="px-2.5 py-1.5">版本</th>
                                  <th className="px-2.5 py-1.5">SHA-256</th>
                                  <th className="px-2.5 py-1.5 text-right">大小</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100 font-mono-tabular">
                                {detail.assets.map((a) => (
                                  <tr key={a.id}>
                                    <td className="px-2.5 py-1.5 text-gray-800">
                                      {a.exportRelativePath}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-gray-600">
                                      V{a.versionNo ?? "?"}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-gray-500" title={a.sha256}>
                                      {a.sha256.slice(0, 12)}…
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right text-gray-600">
                                      {formatBytes(a.sizeBytes)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        <div>
                          <div className="mb-1.5 font-semibold text-gray-800">
                            导出记录与冻结摘要
                          </div>
                          <div className="space-y-1.5 rounded-lg border border-gray-200 bg-white p-3 font-mono-tabular text-[11px] text-gray-600">
                            <div>Release ID: {detail.id}</div>
                            <div>PDP Version ID: {detail.pdpVersionId ?? "—"}</div>
                            <div>
                              校验结果：{detail.blockerCount} 阻断 / {detail.warningCount} 提醒
                            </div>
                            {detail.exports.length > 0 && (
                              <div className="mt-2 border-t border-gray-100 pt-2">
                                <div className="mb-1 font-sans font-medium text-gray-800">
                                  最近 ZIP 生成记录：
                                </div>
                                {detail.exports.slice(0, 4).map((exp) => (
                                  <div
                                    key={exp.id}
                                    className="flex items-center justify-between gap-2 py-0.5"
                                  >
                                    <span className="truncate">{exp.fileName}</span>
                                    <span>
                                      [{exp.status}]
                                      {exp.expiresAt
                                        ? ` 过期 ${formatDateTime(exp.expiresAt)}`
                                        : ""}
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
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
