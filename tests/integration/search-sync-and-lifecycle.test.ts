import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-search-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

async function bootApp(options: { startWorker?: boolean } = {}) {
  const dir = makeTempDir();
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configPath,
    [
      "app:",
      "  host: 127.0.0.1",
      "  port: 3099",
      "database:",
      `  path: ${path.join(dir, "db.sqlite")}`,
      "storage:",
      "  default: local-main",
      "  providers:",
      "    local-main:",
      "      type: local",
      "      name: Local Main",
      `      root: ${path.join(dir, "storage")}`,
      "cache:",
      `  path: ${path.join(dir, "cache")}`,
      "backups:",
      `  path: ${path.join(dir, "backups")}`,
      "uploads:",
      `  tempDir: ${path.join(dir, "tmp")}`,
      "  maxFileSizeMB: 20"
    ].join("\n"),
    "utf8"
  );

  const config = loadConfig({
    configPath,
    env: { NODE_ENV: "test" }
  });

  const runtime = await createApp({
    config,
    logger: false,
    startWorker: options.startWorker ?? false
  });
  runtimes.push(runtime);
  return { runtime, dir };
}

afterEach(async () => {
  while (runtimes.length > 0) {
    const rt = runtimes.pop()!;
    await rt.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Listing search index synchronization & app lifecycle", () => {
  it("syncs linked active listing search documents when product SPU/names or store metadata are updated", async () => {
    const { runtime } = await bootApp();
    const csrfHeaders = { "x-assetnest-request": "1" };

    // 1. Create product & store
    const productRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: csrfHeaders,
      payload: {
        spu: "SPU-OLD-LAMP",
        nameZh: "复古折叠台灯",
        nameEn: "Retro Folding Lamp"
      }
    });
    expect(productRes.statusCode).toBe(201);
    const productId = productRes.json().id as string;

    const storeRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/stores",
      headers: csrfHeaders,
      payload: {
        name: "AlphaStoreOld",
        platform: "shopee",
        market: "PH",
        defaultLanguage: "en"
      }
    });
    expect(storeRes.statusCode).toBe(201);
    const storeId = storeRes.json().id as string;

    // 2. Create two listings: one stays active, one is moved to trash
    const activeListingRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/listings",
      headers: csrfHeaders,
      payload: {
        productId,
        storeId,
        displayName: "PH Primary Listing",
        language: "en"
      }
    });
    expect(activeListingRes.statusCode).toBe(201);
    const activeListingId = activeListingRes.json().id as string;

    const trashedListingRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/listings",
      headers: csrfHeaders,
      payload: {
        productId,
        storeId,
        displayName: "PH Trashed Listing",
        language: "en"
      }
    });
    expect(trashedListingRes.statusCode).toBe(201);
    const trashedListingId = trashedListingRes.json().id as string;

    const deleteTrashedRes = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/listings/${trashedListingId}`,
      headers: csrfHeaders
    });
    expect(deleteTrashedRes.statusCode).toBe(200);

    // Baseline search finds active listing via old product & store fields
    const queryListings = async (q: string): Promise<string[]> => {
      const res = await runtime.app.inject({
        method: "GET",
        url: `/api/v1/listings?q=${encodeURIComponent(q)}`
      });
      expect(res.statusCode).toBe(200);
      return (res.json().items as Array<{ id: string }>).map((item) => item.id);
    };

    expect(await queryListings("SPU-OLD-LAMP")).toEqual([activeListingId]);
    expect(await queryListings("复古折叠台灯")).toEqual([activeListingId]);
    expect(await queryListings("AlphaStoreOld")).toEqual([activeListingId]);

    // 3. Update product SPU, Chinese name, and English name
    const updateProductRes = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}`,
      headers: csrfHeaders,
      payload: {
        spu: "SPU-NEW-LANTERN",
        nameZh: "极简露营手提灯",
        nameEn: "Minimalist Camp Lantern"
      }
    });
    expect(updateProductRes.statusCode).toBe(200);

    // Active listing search immediately reflects new product metadata and drops stale tokens
    expect(await queryListings("SPU-NEW-LANTERN")).toEqual([activeListingId]);
    expect(await queryListings("极简露营手提灯")).toEqual([activeListingId]);
    expect(await queryListings("Minimalist Camp Lantern")).toEqual([activeListingId]);
    expect(await queryListings("SPU-OLD-LAMP")).toEqual([]);
    expect(await queryListings("复古折叠台灯")).toEqual([]);

    // Trashed listing must remain absent from search_documents
    const trashedDoc = runtime.db.raw
      .prepare("SELECT entity_id FROM search_documents WHERE entity_type = 'listing' AND entity_id = ?")
      .get(trashedListingId);
    expect(trashedDoc).toBeUndefined();

    // 4. Update store name, platform, and market
    const updateStoreRes = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/stores/${storeId}`,
      headers: csrfHeaders,
      payload: {
        name: "BetaFlagshipNew",
        platform: "lazada",
        market: "TH"
      }
    });
    expect(updateStoreRes.statusCode).toBe(200);

    // Active listing search immediately reflects new store metadata and drops stale tokens
    expect(await queryListings("BetaFlagshipNew")).toEqual([activeListingId]);
    expect(await queryListings("lazada")).toEqual([activeListingId]);
    expect(await queryListings("TH")).toEqual([activeListingId]);
    expect(await queryListings("AlphaStoreOld")).toEqual([]);
    expect(await queryListings("shopee")).toEqual([]);

    // 5. Restoring the trashed listing indexes the latest updated product & store metadata
    const restoreRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/restore",
      headers: csrfHeaders,
      payload: { type: "listing", ids: [trashedListingId] }
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(new Set(await queryListings("BetaFlagshipNew"))).toEqual(
      new Set([activeListingId, trashedListingId])
    );
    expect(new Set(await queryListings("SPU-NEW-LANTERN"))).toEqual(
      new Set([activeListingId, trashedListingId])
    );
  });

  it("allows GET/HEAD /healthz with query params during maintenance mode while blocking other routes with 503", async () => {
    const { runtime } = await bootApp();
    runtime.setMaintenanceMode(true);

    const plainHealth = await runtime.app.inject({ method: "GET", url: "/healthz" });
    expect(plainHealth.statusCode).toBe(200);
    expect(plainHealth.json().status).toBe("maintenance");

    const queryHealth = await runtime.app.inject({
      method: "GET",
      url: "/healthz?ts=1732697767&probe=k8s"
    });
    expect(queryHealth.statusCode).toBe(200);
    expect(queryHealth.json().status).toBe("maintenance");

    const headHealth = await runtime.app.inject({
      method: "HEAD",
      url: "/healthz?check=alive"
    });
    expect(headHealth.statusCode).toBe(200);

    const postHealth = await runtime.app.inject({
      method: "POST",
      url: "/healthz?ts=1"
    });
    expect(postHealth.statusCode).toBe(503);
    expect(postHealth.json().error.code).toBe("MAINTENANCE_MODE");

    const subPathHealth = await runtime.app.inject({
      method: "GET",
      url: "/healthz/extra"
    });
    expect(subPathHealth.statusCode).toBe(503);
    expect(subPathHealth.json().error.code).toBe("MAINTENANCE_MODE");

    const apiRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/products"
    });
    expect(apiRes.statusCode).toBe(503);
    expect(apiRes.json().error.code).toBe("MAINTENANCE_MODE");

    runtime.setMaintenanceMode(false);
    const recoveredHealth = await runtime.app.inject({
      method: "GET",
      url: "/healthz?ts=after"
    });
    expect(recoveredHealth.statusCode).toBe(200);
    expect(recoveredHealth.json().status).toBe("ok");
  });

  it("closes HTTP server before stopping worker and closing DB, and shares concurrent close promises", async () => {
    const { runtime } = await bootApp();
    const events: string[] = [];

    const origAppClose = runtime.app.close.bind(runtime.app);
    const origWorkerStop = runtime.worker.stop.bind(runtime.worker);
    const origDbClose = runtime.db.close.bind(runtime.db);

    vi.spyOn(runtime.app, "close").mockImplementation(async () => {
      events.push("app.close:start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await origAppClose();
      events.push("app.close:end");
    });
    vi.spyOn(runtime.worker, "stop").mockImplementation(async () => {
      events.push("worker.stop:start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      await origWorkerStop();
      events.push("worker.stop:end");
    });
    vi.spyOn(runtime.db, "close").mockImplementation(() => {
      events.push("db.close");
      origDbClose();
    });

    // Two concurrent close() callers must both await full completion without early return
    const p1 = runtime.close();
    const p2 = runtime.close();
    let p2ResolvedEarly = false;
    void p2.then(() => {
      if (!events.includes("db.close")) {
        p2ResolvedEarly = true;
      }
    });

    await Promise.all([p1, p2]);
    expect(p2ResolvedEarly).toBe(false);
    expect(events).toEqual([
      "app.close:start",
      "app.close:end",
      "worker.stop:start",
      "worker.stop:end",
      "db.close"
    ]);
  });

  it("still stops worker and closes DB when app.close() throws", async () => {
    const { runtime } = await bootApp();
    const events: string[] = [];

    const origAppClose = runtime.app.close.bind(runtime.app);
    const origWorkerStop = runtime.worker.stop.bind(runtime.worker);
    const origDbClose = runtime.db.close.bind(runtime.db);

    vi.spyOn(runtime.app, "close").mockImplementation(async () => {
      events.push("app.close");
      await origAppClose();
      throw new Error("simulated http close failure");
    });
    vi.spyOn(runtime.worker, "stop").mockImplementation(async () => {
      events.push("worker.stop");
      await origWorkerStop();
    });
    vi.spyOn(runtime.db, "close").mockImplementation(() => {
      events.push("db.close");
      origDbClose();
    });

    await expect(runtime.close()).rejects.toThrow("simulated http close failure");
    expect(events).toEqual(["app.close", "worker.stop", "db.close"]);
  });
});
