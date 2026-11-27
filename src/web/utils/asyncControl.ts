export interface LatestRequestHandle {
  readonly id: number;
  readonly signal: AbortSignal;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}

/**
 * Coordinates "latest-wins" async requests:
 * starting a new request aborts the previous in-flight AbortController and advances the sequence ID
 * so stale responses or errors can never overwrite newer UI state.
 */
export class LatestRequestController {
  private currentId = 0;
  private controller: AbortController | null = null;
  private activeId: number | null = null;
  private detachExternalAbort: (() => void) | null = null;

  next(externalSignal?: AbortSignal): LatestRequestHandle {
    this.abort();
    const id = ++this.currentId;
    const controller = new AbortController();
    this.controller = controller;
    this.activeId = id;

    if (externalSignal) {
      if (externalSignal.aborted) {
        this.activeId = null;
        controller.abort(externalSignal.reason);
      } else {
        const onExternalAbort = () => {
          if (this.controller === controller) {
            this.activeId = null;
            this.detachExternalAbort = null;
            if (!controller.signal.aborted) {
              controller.abort(externalSignal.reason);
            }
          }
        };
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        this.detachExternalAbort = () => {
          externalSignal.removeEventListener("abort", onExternalAbort);
        };
      }
    }

    return { id, signal: controller.signal };
  }

  isCurrent(id: number): boolean {
    return id === this.currentId && this.controller !== null && !this.controller.signal.aborted;
  }

  finish(id: number): void {
    if (this.activeId === id) {
      this.activeId = null;
    }
    if (id === this.currentId && this.detachExternalAbort) {
      this.detachExternalAbort();
      this.detachExternalAbort = null;
    }
  }

  isInFlight(): boolean {
    return this.activeId !== null && this.controller !== null && !this.controller.signal.aborted;
  }

  abort(): void {
    this.currentId += 1;
    this.activeId = null;
    if (this.detachExternalAbort) {
      this.detachExternalAbort();
      this.detachExternalAbort = null;
    }
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }
    this.controller = null;
  }
}

/**
 * Runs a polling task without overlapping ticks: the next delay is scheduled only after the
 * previous execution settles. Calling the returned cleanup function cancels any pending timer
 * and aborts the active tick's AbortSignal.
 */
export function startSafePolling(
  task: (signal: AbortSignal) => Promise<void> | void,
  intervalMs: number
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runTick();
    }, intervalMs);
  };

  const runTick = async () => {
    if (stopped) return;
    const controller = new AbortController();
    activeController = controller;
    try {
      await task(controller.signal);
    } catch {
      // Polling tasks handle user-facing errors themselves; keep polling resilient on transient errors.
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
      if (!stopped) {
        schedule();
      }
    }
  };

  schedule();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
    }
    activeController = null;
  };
}
