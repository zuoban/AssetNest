import { useCallback, useRef, useState } from "react";
import type { UploadTransferProgress } from "../api/client";

export type ReportUploadProgress = (progress: UploadTransferProgress | null) => void;

export function useUploadSubmission(onBusyChange?: (busy: boolean) => void) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadTransferProgress | null>(null);

  const run = useCallback(async (submit: (reportProgress: ReportUploadProgress) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      await submit(setProgress);
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(null);
      onBusyChange?.(false);
    }
  }, [onBusyChange]);

  return { busy, progress, running, run };
}

export function initialUploadProgress(total: number): UploadTransferProgress {
  return { loaded: 0, total, percent: 0, phase: "uploading" };
}
