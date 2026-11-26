import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  XCircle
} from "lucide-react";
import type { JobRecord, StorageProviderStatus } from "../../shared/types";

export function StorageStatusBadge({ status }: { status: StorageProviderStatus }) {
  const config: Record<
    StorageProviderStatus,
    { label: string; className: string; icon: typeof CheckCircle2 }
  > = {
    healthy: {
      label: "在线正常",
      className: "bg-emerald-50 text-emerald-700 border-emerald-200",
      icon: CheckCircle2
    },
    degraded: {
      label: "状态降级",
      className: "bg-amber-50 text-amber-800 border-amber-200",
      icon: AlertTriangle
    },
    offline: {
      label: "已停用 / 离线",
      className: "bg-slate-100 text-slate-700 border-slate-200",
      icon: XCircle
    },
    missing_config: {
      label: "配置缺失（离线保护）",
      className: "bg-rose-50 text-rose-700 border-rose-200",
      icon: AlertCircle
    },
    unknown: {
      label: "待连通性检测",
      className: "bg-blue-50 text-blue-700 border-blue-200",
      icon: HelpCircle
    }
  };

  const item = config[status];
  const Icon = item.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${item.className}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{item.label}</span>
    </span>
  );
}

export function JobStatusBadge({ status }: { status: JobRecord["status"] }) {
  const config: Record<
    JobRecord["status"],
    { label: string; className: string; icon: typeof CheckCircle2 }
  > = {
    queued: {
      label: "排队中",
      className: "bg-slate-100 text-slate-700 border-slate-200",
      icon: Clock
    },
    running: {
      label: "执行中",
      className: "bg-blue-50 text-blue-700 border-blue-200",
      icon: Clock
    },
    succeeded: {
      label: "已完成",
      className: "bg-emerald-50 text-emerald-700 border-emerald-200",
      icon: CheckCircle2
    },
    failed: {
      label: "执行失败",
      className: "bg-rose-50 text-rose-700 border-rose-200",
      icon: AlertCircle
    },
    cancelled: {
      label: "已取消",
      className: "bg-amber-50 text-amber-800 border-amber-200",
      icon: XCircle
    }
  };

  const item = config[status];
  const Icon = item.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${item.className}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{item.label}</span>
    </span>
  );
}
