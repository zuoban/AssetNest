import { useEffect } from "react";
import { AlertTriangle, HelpCircle, ShieldAlert, X } from "lucide-react";

export type ConfirmDialogTone = "danger" | "warning" | "primary";

export interface ConfirmDialogState {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  onConfirm: () => void | Promise<void>;
}

interface ConfirmDialogProps {
  dialog: ConfirmDialogState | null;
  busy?: boolean;
  onClose: () => void;
}

export function ConfirmDialog({ dialog, busy = false, onClose }: ConfirmDialogProps) {
  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, busy, onClose]);

  if (!dialog) return null;

  const tone = dialog.tone ?? "primary";
  const iconMeta =
    tone === "danger"
      ? {
          icon: ShieldAlert,
          wrapClass: "bg-rose-50 text-rose-600 border-rose-200",
          btnClass: "bg-rose-600 text-white hover:bg-rose-700"
        }
      : tone === "warning"
        ? {
            icon: AlertTriangle,
            wrapClass: "bg-amber-50 text-amber-600 border-amber-200",
            btnClass: "bg-amber-600 text-white hover:bg-amber-700"
          }
        : {
            icon: HelpCircle,
            wrapClass: "bg-blue-50 text-blue-600 border-blue-200",
            btnClass: "bg-blue-600 text-white hover:bg-blue-700"
          };

  const Icon = iconMeta.icon;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${iconMeta.wrapClass}`}
          >
            <Icon className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 id="confirm-dialog-title" className="text-sm font-semibold text-gray-900">
                {dialog.title}
              </h3>
              <button
                type="button"
                disabled={busy}
                aria-label="关闭确认弹窗"
                onClick={onClose}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-gray-600">
              {dialog.description}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {dialog.cancelLabel || "取消"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void dialog.onConfirm()}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${iconMeta.btnClass}`}
          >
            {busy ? "处理中..." : dialog.confirmLabel || "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
