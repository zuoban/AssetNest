import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError, isAbortError } from "../../src/web/api/client.js";
import { LatestRequestController, startSafePolling } from "../../src/web/utils/asyncControl.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("web asyncControl utilities & API AbortSignal support", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("identifies AbortError instances without misclassifying regular or API errors", () => {
    expect(isAbortError(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
    const customAbort = new Error("aborted");
    customAbort.name = "AbortError";
    expect(isAbortError(customAbort)).toBe(true);

    expect(isAbortError(new Error("network failed"))).toBe(false);
    expect(isAbortError(new ApiClientError(500, "INTERNAL_ERROR", "boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("aborts superseded requests and prevents out-of-order responses from overwriting state", async () => {
    const controller = new LatestRequestController();
    const committed: string[] = [];
    const errors: string[] = [];
    let loading = false;

    const firstDeferred = createDeferred<string>();
    const secondDeferred = createDeferred<string>();

    const run = async (label: string, deferred: ReturnType<typeof createDeferred<string>>) => {
      const req = controller.next();
      loading = true;
      try {
        const result = await deferred.promise;
        if (!controller.isCurrent(req.id)) return;
        committed.push(result);
      } catch (err) {
        if (!controller.isCurrent(req.id) || isAbortError(err)) return;
        errors.push(`${label}:${String(err)}`);
      } finally {
        controller.finish(req.id);
        if (controller.isCurrent(req.id)) {
          loading = false;
        }
      }
    };

    const req1HandlePromise = run("first", firstDeferred);
    expect(controller.isInFlight()).toBe(true);

    const req2HandlePromise = run("second", secondDeferred);
    expect(loading).toBe(true);

    // Slow first request fails AFTER second request started — must not clear loading or record error
    firstDeferred.reject(new Error("stale failure"));
    await req1HandlePromise;
    expect(loading).toBe(true);
    expect(errors).toEqual([]);
    expect(controller.isInFlight()).toBe(true);

    // Fast second request resolves and commits cleanly
    secondDeferred.resolve("second-result");
    await req2HandlePromise;
    expect(committed).toEqual(["second-result"]);
    expect(loading).toBe(false);
    expect(controller.isInFlight()).toBe(false);
  });

  it("aborts active signal, invalidates current handle, and tracks external AbortSignal cleanly", () => {
    const controller = new LatestRequestController();
    const req1 = controller.next();
    expect(controller.isCurrent(req1.id)).toBe(true);
    expect(controller.isInFlight()).toBe(true);
    expect(req1.signal.aborted).toBe(false);

    // Starting req2 aborts req1's signal immediately
    const external = new AbortController();
    const req2 = controller.next(external.signal);
    expect(req1.signal.aborted).toBe(true);
    expect(controller.isCurrent(req1.id)).toBe(false);
    expect(controller.isCurrent(req2.id)).toBe(true);
    expect(req2.signal.aborted).toBe(false);

    // Aborting external signal propagates to req2 and clears inFlight
    external.abort(new DOMException("poll stopped", "AbortError"));
    expect(req2.signal.aborted).toBe(true);
    expect(controller.isCurrent(req2.id)).toBe(false);
    expect(controller.isInFlight()).toBe(false);

    // Already-aborted external signal yields immediately aborted handle
    const req3 = controller.next(external.signal);
    expect(req3.signal.aborted).toBe(true);
    expect(controller.isCurrent(req3.id)).toBe(false);
    expect(controller.isInFlight()).toBe(false);

    // Finishing normally detaches external abort listener and clears inFlight
    const reusableExternal = new AbortController();
    const req4 = controller.next(reusableExternal.signal);
    expect(controller.isCurrent(req4.id)).toBe(true);
    controller.finish(req4.id);
    expect(controller.isInFlight()).toBe(false);
    reusableExternal.abort();
    expect(req4.signal.aborted).toBe(false);

    // Explicit abort() invalidates even finished current handle
    controller.abort();
    expect(controller.isCurrent(req4.id)).toBe(false);
  });

  it("prevents overlapping polling ticks and aborts in-flight tick on stop", async () => {
    vi.useFakeTimers();

    let concurrent = 0;
    let maxConcurrent = 0;
    let startedTicks = 0;
    const signals: AbortSignal[] = [];
    const deferreds: Array<ReturnType<typeof createDeferred<void>>> = [];

    const stop = startSafePolling(async (signal) => {
      startedTicks += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      signals.push(signal);
      const d = createDeferred<void>();
      deferreds.push(d);
      try {
        await d.promise;
      } finally {
        concurrent -= 1;
      }
    }, 1000);

    // First tick fires at 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(startedTicks).toBe(1);
    expect(concurrent).toBe(1);

    // Even after 5x interval while tick 1 is still pending, tick 2 must NOT start
    await vi.advanceTimersByTimeAsync(5000);
    expect(startedTicks).toBe(1);
    expect(maxConcurrent).toBe(1);

    // Settle tick 1 with an error — polling must recover and schedule tick 2 after intervalMs
    deferreds[0]!.reject(new Error("transient network glitch"));
    await Promise.resolve();
    await Promise.resolve();
    expect(concurrent).toBe(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(startedTicks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedTicks).toBe(2);
    expect(maxConcurrent).toBe(1);

    // Stop while tick 2 is in flight -> signal must abort immediately and no tick 3 ever starts
    expect(signals[1]!.aborted).toBe(false);
    stop();
    expect(signals[1]!.aborted).toBe(true);

    deferreds[1]!.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(startedTicks).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it("forwards AbortSignal through API client read methods and surfaces AbortError on abort", async () => {
    const observedCalls: Array<{ url: string; signal: AbortSignal | undefined }> = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      observedCalls.push({ url, signal: init?.signal ?? undefined });
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0 })
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    const opts = { signal: ac.signal };

    await api.listAssets({ folderId: "f1" }, opts);
    await api.getAsset("a1", opts);
    await api.getProduct("p1", opts);
    await api.getListing("l1", opts);
    await api.getListingAssetSets("l1", opts);
    await api.getListingPdp("l1", opts);
    await api.getJobs(1, 20, opts);
    await api.getActivities(1, 20, opts);
    await api.getBackups(opts);
    await api.validateListing("l1", "tpl-1", opts);
    await api.listListingReleases("l1", opts);
    await api.getReleaseDetail("rel-1", opts);

    expect(observedCalls).toHaveLength(12);
    for (const call of observedCalls) {
      expect(call.signal).toBe(ac.signal);
    }

    // Verify abort rejection propagates cleanly as AbortError
    const abortableFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    vi.stubGlobal("fetch", abortableFetch);

    const abortCtrl = new AbortController();
    const pending = api.listAssets({ q: "lamp" }, { signal: abortCtrl.signal });
    abortCtrl.abort();

    let caught: unknown = null;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(isAbortError(caught)).toBe(true);
  });
});
