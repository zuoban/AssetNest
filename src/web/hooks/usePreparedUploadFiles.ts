import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_COMPRESSION_CONCURRENCY,
  UploadPreparationController,
  type PreparedUploadFile,
  type PreparedUploadItem,
  type PreparedUploadSnapshot,
  type PreparedUploadSummary
} from "../utils/uploadPreparation";

export interface UsePreparedUploadFilesResult {
  items: PreparedUploadItem[];
  summary: PreparedUploadSummary;
  preparedFiles: PreparedUploadFile[];
  setFiles: (files: File[]) => void;
  addFiles: (files: File[]) => void;
  removeFile: (id: string) => void;
  clear: () => void;
}

export function usePreparedUploadFiles(
  compressEnabled: boolean,
  options: { concurrency?: number } = {}
): UsePreparedUploadFilesResult {
  const concurrency = options.concurrency ?? DEFAULT_COMPRESSION_CONCURRENCY;
  const controllerRef = useRef<UploadPreparationController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new UploadPreparationController({
      compressEnabled,
      concurrency
    });
  }

  const [snapshot, setSnapshot] = useState<PreparedUploadSnapshot>(() =>
    controllerRef.current!.getSnapshot()
  );

  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = controller.subscribe(setSnapshot);
    setSnapshot(controller.getSnapshot());
    return () => {
      unsubscribe();
      controller.clear();
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setCompressEnabled(compressEnabled);
  }, [compressEnabled]);

  const setFiles = useCallback((files: File[]) => {
    controllerRef.current?.setFiles(files);
  }, []);

  const addFiles = useCallback((files: File[]) => {
    controllerRef.current?.addFiles(files);
  }, []);

  const removeFile = useCallback((id: string) => {
    controllerRef.current?.removeFile(id);
  }, []);

  const clear = useCallback(() => {
    controllerRef.current?.clear();
  }, []);

  const preparedFiles = useMemo<PreparedUploadFile[]>(
    () =>
      snapshot.items.map((item) => ({
        original: item.originalFile,
        upload: item.uploadFile
      })),
    [snapshot.items]
  );

  return {
    items: snapshot.items,
    summary: snapshot.summary,
    preparedFiles,
    setFiles,
    addFiles,
    removeFile,
    clear
  };
}
