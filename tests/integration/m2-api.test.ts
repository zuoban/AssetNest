import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import yauzl from "yauzl";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";
import {
  startTestS3Server,
  startTestWebDavServer,
  type TestS3Server,
  type TestWebDavServer
} from "../helpers/remote-storage-servers.js";

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];
const remoteCleanups: Array<() => Promise<void>> = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-m2-"));
  tempDirs.push(dir);
  return dir;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) return "";
  const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return first ? first.split(";")[0] ?? "" : "";
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function makePng(r: number, g: number, b: number, width = 32, height = 32): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } }
  })
    .png()
    .toBuffer();
}

function buildMultipartPayload(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer }
  >
): { body: Buffer; contentType: string } {
  const boundary = `----AssetNestM2Test${crypto.randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("data" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`
        )
      );
      chunks.push(part.data);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`)
      );
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function readZipEntries(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip"));
        return;
      }
      const entries = new Map<string, Buffer>();
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            reject(streamErr ?? new Error("Failed to read zip entry"));
            return;
          }
          const chunks: Buffer[] = [];
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("error", reject);
          readStream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
    });
  });
}

async function bootThreeStorageApp(options?: {
  dir?: string;
  s3Server?: TestS3Server;
  davServer?: TestWebDavServer;
  startWorker?: boolean;
  skipSetup?: boolean;
}) {
  const dir = options?.dir ?? makeTempDir();
  const dataDir = path.join(dir, "data");
  const configPath = path.join(dir, "config.yaml");

  let s3Server = options?.s3Server;
  if (!s3Server) {
    s3Server = await startTestS3Server();
    remoteCleanups.push(() => s3Server!.close());
  }
  let davServer = options?.davServer;
  if (!davServer) {
    davServer = await startTestWebDavServer();
    remoteCleanups.push(() => davServer!.close());
  }

  const yaml = `
storage:
  default: local
  providers:
    local:
      type: local
      name: 本地存储
      root: ./data/storage
    s3_main:
      type: s3
      name: 测试对象存储
      endpoint: ${s3Server.endpoint}
      region: us-east-1
      bucket: ${s3Server.bucket}
      prefix: assetnest/
      accessKeyId: \${TEST_S3_AK}
      secretAccessKey: \${TEST_S3_SK}
      forcePathStyle: true
    webdav_nas:
      type: webdav
      name: 测试 WebDAV
      endpoint: ${davServer.endpoint}
      root: /nested/assets
      username: \${TEST_DAV_USER}
      password: \${TEST_DAV_PASS}
`;
  fs.writeFileSync(configPath, yaml, "utf8");

  const config = loadConfig({
    cwd: dir,
    configPath,
    env: {
      ASSETNEST_DATA_DIR: dataDir,
      TEST_S3_AK: s3Server.accessKeyId,
      TEST_S3_SK: s3Server.secretAccessKey,
      TEST_DAV_USER: davServer.username,
      TEST_DAV_PASS: davServer.password
    }
  });

  const runtime = await createApp({
    config,
    logger: false,
    startWorker: options?.startWorker ?? true,
    workerPollIntervalMs: 50,
    workerRetryBaseDelayMs: 50
  });
  runtimes.push(runtime);

  let cookie = "";
  if (!options?.skipSetup) {
    const initRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/setup/init",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", displayName: "管理员", password: "StrongPassword123!" }
    });
    expect(initRes.statusCode).toBe(201);
    cookie = extractCookie(initRes.headers["set-cookie"]);
  } else {
    const loginRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "StrongPassword123!" }
    });
    expect(loginRes.statusCode).toBe(200);
    cookie = extractCookie(loginRes.headers["set-cookie"]);
  }

  return { dir, dataDir, config, runtime, cookie, s3Server, davServer };
}

async function uploadAsset(
  runtime: AppRuntime,
  cookie: string,
  params: {
    filename: string;
    contentType: string;
    data: Buffer;
    productIds?: string[];
    storageId?: string;
  }
) {
  const parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer }
  > = [];
  if (params.productIds && params.productIds.length > 0) {
    parts.push({ name: "productIds", value: JSON.stringify(params.productIds) });
  }
  if (params.storageId) {
    parts.push({ name: "storageId", value: params.storageId });
  }
  parts.push({
    name: "file",
    filename: params.filename,
    contentType: params.contentType,
    data: params.data
  });
  const multipart = buildMultipartPayload(parts);
  const res = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/assets/upload",
    headers: {
      cookie,
      "x-assetnest-request": "1",
      "content-type": multipart.contentType
    },
    payload: multipart.body
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    items: Array<{
      id: string;
      currentVersionId: string;
      storageId: string;
      sha256: string;
    }>;
    uploadedCount: number;
    deduplicatedCount: number;
  };
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (remoteCleanups.length > 0) {
    await remoteCleanups.pop()!();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("M2 API integration (S3/WebDAV, Migration, Cleanup, Offline Degradation, GC, Backups)", () => {
  it("T1: probes all 3 providers with zero secret leaks, switches default storage, enforces delete guard, and differentiates Range capabilities", async () => {
    const { runtime, cookie, s3Server, davServer } = await bootThreeStorageApp();
    const headers = { cookie, "x-assetnest-request": "1" };

    // Check zero secrets in API response and SQLite storage_providers table
    const listRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/storage/providers",
      headers: { cookie }
    });
    expect(listRes.statusCode).toBe(200);
    const listText = listRes.body;
    expect(listText).not.toContain(s3Server.secretAccessKey);
    expect(listText).not.toContain(davServer.password);

    const dbDump = JSON.stringify(
      runtime.db.raw.prepare("SELECT * FROM storage_providers").all()
    );
    expect(dbDump).not.toContain(s3Server.secretAccessKey);
    expect(dbDump).not.toContain(davServer.password);

    // Probe all 3 providers
    for (const providerId of ["local", "s3_main", "webdav_nas"]) {
      const probeRes = await runtime.app.inject({
        method: "POST",
        url: `/api/v1/storage/providers/${providerId}/test`,
        headers
      });
      expect(probeRes.statusCode).toBe(200);
      const probeBody = probeRes.json();
      expect(probeBody.result.ok).toBe(true);
      expect(probeBody.result.code).toBe("OK");
      expect(probeBody.provider.status).toBe("healthy");
    }
    expect(s3Server.objects.size).toBe(0);
    expect(davServer.files.size).toBe(0);

    // Upload to local (current default)
    const localPng = await makePng(220, 40, 40);
    const upLocal = await uploadAsset(runtime, cookie, {
      filename: "local-item.png",
      contentType: "image/png",
      data: localPng
    });
    expect(upLocal.items[0]!.storageId).toBe("local");

    // Switch default storage to s3_main
    const switchRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/default",
      headers,
      payload: { storageId: "s3_main" }
    });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json().defaultStorageId).toBe("s3_main");

    // New upload lands on s3_main; old local upload stays on local
    const s3Png = await makePng(40, 180, 90, 64, 64);
    const upS3 = await uploadAsset(runtime, cookie, {
      filename: "s3-item.png",
      contentType: "image/png",
      data: s3Png
    });
    expect(upS3.items[0]!.storageId).toBe("s3_main");

    // Upload directly to webdav_nas
    const davPng = await makePng(50, 90, 220, 48, 48);
    const upDav = await uploadAsset(runtime, cookie, {
      filename: "dav-item.png",
      contentType: "image/png",
      data: davPng,
      storageId: "webdav_nas"
    });
    expect(upDav.items[0]!.storageId).toBe("webdav_nas");

    // Verify intact downloads across all 3 backends
    const dlLocal = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${upLocal.items[0]!.id}/versions/${upLocal.items[0]!.currentVersionId}/content`,
      headers: { cookie }
    });
    expect(dlLocal.statusCode).toBe(200);
    expect(sha256Hex(dlLocal.rawPayload)).toBe(sha256Hex(localPng));

    // S3 supports Range 206
    const s3Range = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${upS3.items[0]!.id}/versions/${upS3.items[0]!.currentVersionId}/content?preview=1`,
      headers: { cookie, range: "bytes=0-31" }
    });
    expect(s3Range.statusCode).toBe(206);
    expect(s3Range.headers["accept-ranges"]).toBe("bytes");
    expect(s3Range.rawPayload.length).toBe(32);
    expect(s3Range.rawPayload.equals(s3Png.subarray(0, 32))).toBe(true);

    // WebDAV degrades Range to full 200 stream with Accept-Ranges: none
    const davRange = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${upDav.items[0]!.id}/versions/${upDav.items[0]!.currentVersionId}/content?preview=1`,
      headers: { cookie, range: "bytes=0-31" }
    });
    expect(davRange.statusCode).toBe(200);
    expect(davRange.headers["accept-ranges"]).toBe("none");
    expect(sha256Hex(davRange.rawPayload)).toBe(sha256Hex(davPng));

    // Provider deletion blocked when default or referenced by files
    const delDefault = await runtime.app.inject({
      method: "DELETE",
      url: "/api/v1/storage/providers/s3_main",
      headers
    });
    expect(delDefault.statusCode).toBe(409);

    const delReferenced = await runtime.app.inject({
      method: "DELETE",
      url: "/api/v1/storage/providers/local",
      headers
    });
    expect(delReferenced.statusCode).toBe(409);
  });

  it("T2: executes Local -> S3 -> WebDAV -> Local migration chain with shared-file dry-run, secondary cleanup confirmation, crash/retry resume, and dedup merge", async () => {
    const env = await bootThreeStorageApp();
    const { dir, dataDir, s3Server, davServer } = env;
    let { runtime, cookie } = env;
    let headers = { cookie, "x-assetnest-request": "1" };

    // Create two products sharing one physical file
    const prodARes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers,
      payload: { spu: "SPU-MIG-A", nameZh: "迁移商品A", status: "active" }
    });
    expect(prodARes.statusCode).toBe(201);
    const prodA = prodARes.json() as { id: string };

    const prodBRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers,
      payload: { spu: "SPU-MIG-B", nameZh: "迁移商品B", status: "active" }
    });
    expect(prodBRes.statusCode).toBe(201);
    const prodB = prodBRes.json() as { id: string };

    const pngShared = await makePng(10, 120, 200);
    const pngSingle = await makePng(200, 120, 10);

    const upShared = await uploadAsset(runtime, cookie, {
      filename: "shared-a.png",
      contentType: "image/png",
      data: pngShared,
      productIds: [prodA.id]
    });
    const upSharedB = await uploadAsset(runtime, cookie, {
      filename: "shared-b.png",
      contentType: "image/png",
      data: pngShared,
      productIds: [prodB.id]
    });
    expect(upSharedB.deduplicatedCount).toBe(1);
    const upSingle = await uploadAsset(runtime, cookie, {
      filename: "single.png",
      contentType: "image/png",
      data: pngSingle,
      productIds: [prodA.id]
    });

    const sharedSha = upShared.items[0]!.sha256;
    const singleSha = upSingle.items[0]!.sha256;
    const localSharedPath = path.join(dataDir, "storage", "originals", sharedSha.slice(0, 2), sharedSha);
    expect(fs.existsSync(localSharedPath)).toBe(true);

    // Step 1: Dry-run preview Local -> S3 scoped to Product A must reveal shared file impacting Product B
    const previewRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/migrations/preview",
      headers,
      payload: {
        sourceStorageId: "local",
        targetStorageId: "s3_main",
        scope: { mode: "product", productId: prodA.id }
      }
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json();
    expect(preview.fileCount).toBe(2);
    expect(preview.sharedFileCount).toBe(1);
    expect(preview.affectedProducts.map((p: { spu: string }) => p.spu).sort()).toEqual([
      "SPU-MIG-A",
      "SPU-MIG-B"
    ]);

    // Start Local -> S3 migration
    const mig1Res = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/migrations",
      headers,
      payload: {
        sourceStorageId: "local",
        targetStorageId: "s3_main",
        scope: { mode: "all" }
      }
    });
    expect(mig1Res.statusCode).toBe(202);
    const mig1JobId = mig1Res.json().job.id as string;
    await runtime.worker.waitForIdle();

    const mig1Status = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/jobs/${mig1JobId}`,
      headers: { cookie }
    });
    expect(mig1Status.json().status).toBe("succeeded");
    expect(s3Server.objects.size).toBe(2);

    // Source files on local must NOT be auto-deleted before secondary confirmation
    expect(fs.existsSync(localSharedPath)).toBe(true);
    const queueBefore = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/storage/cleanup-queue?status=awaiting_confirmation",
      headers: { cookie }
    });
    expect(queueBefore.json().items.length).toBe(2);

    // Secondary confirmation deletes source objects from local
    const confirmRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/cleanup-queue/confirm",
      headers,
      payload: { allAwaiting: true }
    });
    expect(confirmRes.statusCode).toBe(202);
    await runtime.worker.waitForIdle();
    expect(fs.existsSync(localSharedPath)).toBe(false);

    // Step 2: S3 -> WebDAV migration with mid-flight outage + simulated process restart + resume
    // Stop current worker before creating job so we can deterministically take WebDAV offline right after probe passes
    await runtime.close();
    runtimes.pop();

    const pausedBoot = await bootThreeStorageApp({
      dir,
      s3Server,
      davServer,
      startWorker: false,
      skipSetup: true
    });
    runtime = pausedBoot.runtime;
    cookie = pausedBoot.cookie;
    headers = { cookie, "x-assetnest-request": "1" };

    const mig2Res = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/migrations",
      headers,
      payload: {
        sourceStorageId: "s3_main",
        targetStorageId: "webdav_nas",
        scope: { mode: "all" }
      }
    });
    expect(mig2Res.statusCode).toBe(202);
    const mig2JobId = mig2Res.json().job.id as string;

    // Take WebDAV offline before starting worker -> job fails after retries
    davServer.setOffline(true);
    // Force max_attempts = 1 so it deterministically lands in failed state quickly for manual retry after restart
    runtime.db.raw.prepare("UPDATE jobs SET max_attempts = 1 WHERE id = ?").run(mig2JobId);
    runtime.worker.start();
    await runtime.worker.waitForIdle();

    const failedJobRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/jobs/${mig2JobId}`,
      headers: { cookie }
    });
    expect(failedJobRes.json().status).toBe("failed");

    // Simulate server restart on same SQLite DB
    await runtime.close();
    runtimes.pop();
    davServer.setOffline(false);

    const resumedBoot = await bootThreeStorageApp({
      dir,
      s3Server,
      davServer,
      startWorker: true,
      skipSetup: true
    });
    runtime = resumedBoot.runtime;
    cookie = resumedBoot.cookie;
    headers = { cookie, "x-assetnest-request": "1" };

    const retryRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/jobs/${mig2JobId}/retry`,
      headers
    });
    expect(retryRes.statusCode).toBe(200);
    await runtime.worker.waitForIdle();

    const mig2Done = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/jobs/${mig2JobId}`,
      headers: { cookie }
    });
    expect(mig2Done.json().status).toBe("succeeded");
    expect(davServer.files.size).toBe(2);

    // Step 3: WebDAV -> Local migration with target deduplication merge
    // First upload pngShared directly to local so the same SHA-256 already exists on target
    const upDupOnLocal = await uploadAsset(runtime, cookie, {
      filename: "shared-copy-on-local.png",
      contentType: "image/png",
      data: pngShared,
      storageId: "local"
    });
    expect(upDupOnLocal.items[0]!.storageId).toBe("local");

    const previewBack = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/migrations/preview",
      headers,
      payload: {
        sourceStorageId: "webdav_nas",
        targetStorageId: "local",
        scope: { mode: "all" }
      }
    });
    expect(previewBack.statusCode).toBe(200);
    expect(previewBack.json().fileCount).toBe(2);
    expect(previewBack.json().alreadyOnTargetCount).toBe(1);

    const mig3Res = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/migrations",
      headers,
      payload: {
        sourceStorageId: "webdav_nas",
        targetStorageId: "local",
        scope: { mode: "all" }
      }
    });
    expect(mig3Res.statusCode).toBe(202);
    const mig3JobId = mig3Res.json().job.id as string;
    await runtime.worker.waitForIdle();

    const mig3Done = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/jobs/${mig3JobId}`,
      headers: { cookie }
    });
    expect(mig3Done.json().status).toBe("succeeded");

    // Both active files on local should be deduplicated (only 1 active row per SHA-256)
    const activeSharedRows = runtime.db.raw
      .prepare("SELECT id, storage_id FROM files WHERE sha256 = ? AND state = 'ready'")
      .all(sharedSha) as Array<{ id: string; storage_id: string }>;
    expect(activeSharedRows).toHaveLength(1);
    expect(activeSharedRows[0]!.storage_id).toBe("local");

    // Verify downloads of original migrated assets still return exact bytes
    const dlBack1 = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${upShared.items[0]!.id}/versions/${upShared.items[0]!.currentVersionId}/content`,
      headers: { cookie }
    });
    expect(dlBack1.statusCode).toBe(200);
    expect(sha256Hex(dlBack1.rawPayload)).toBe(sharedSha);

    const dlBack2 = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${upSingle.items[0]!.id}/versions/${upSingle.items[0]!.currentVersionId}/content`,
      headers: { cookie }
    });
    expect(dlBack2.statusCode).toBe(200);
    expect(sha256Hex(dlBack2.rawPayload)).toBe(singleSha);
  });

  it("T3: supports offline degraded browsing, GC remote-failure retention & retry, cache clear + lazy regen, and verified metadata/full backups", async () => {
    const { dir, runtime, cookie, s3Server, davServer } = await bootThreeStorageApp();
    const headers = { cookie, "x-assetnest-request": "1" };

    // Upload one asset to s3_main and one to local
    const s3Png = await makePng(120, 60, 180, 64, 64);
    const upS3 = await uploadAsset(runtime, cookie, {
      filename: "s3-offline-test.png",
      contentType: "image/png",
      data: s3Png,
      storageId: "s3_main"
    });
    const s3Asset = upS3.items[0]!;

    const localPng = await makePng(30, 160, 90, 48, 48);
    const upLocal = await uploadAsset(runtime, cookie, {
      filename: "local-backup-test.png",
      contentType: "image/png",
      data: localPng,
      storageId: "local"
    });
    const localAsset = upLocal.items[0]!;

    // Warm thumbnail for S3 asset
    const thumbBefore = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${s3Asset.id}/versions/${s3Asset.currentVersionId}/thumbnail`,
      headers: { cookie }
    });
    expect(thumbBefore.statusCode).toBe(200);
    expect(thumbBefore.headers["content-type"]).toBe("image/webp");

    // Take S3 offline -> asset list & cached thumbnail still work, original content returns 503
    s3Server.setOffline(true);
    const listWhileOffline = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/assets",
      headers: { cookie }
    });
    expect(listWhileOffline.statusCode).toBe(200);
    expect(listWhileOffline.json().total).toBe(2);

    const thumbWhileOffline = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${s3Asset.id}/versions/${s3Asset.currentVersionId}/thumbnail`,
      headers: { cookie }
    });
    expect(thumbWhileOffline.statusCode).toBe(200);

    const contentWhileOffline = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${s3Asset.id}/versions/${s3Asset.currentVersionId}/content`,
      headers: { cookie }
    });
    expect(contentWhileOffline.statusCode).toBe(503);
    expect(contentWhileOffline.json().error.code).toBe("STORAGE_OFFLINE");

    // Soft-delete S3 asset and run GC while S3 is still offline -> must record delete_failed & cleanup queue entry
    const delAssetRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers,
      payload: {
        assetIds: [s3Asset.id],
        action: "soft_delete"
      }
    });
    expect(delAssetRes.statusCode).toBe(200);

    const gcRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/gc",
      headers,
      payload: { forceIgnoreRetention: true }
    });
    expect(gcRes.statusCode).toBe(202);
    await runtime.worker.waitForIdle();

    const failedQueueRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/storage/cleanup-queue?status=failed",
      headers: { cookie }
    });
    expect(failedQueueRes.statusCode).toBe(200);
    expect(failedQueueRes.json().items.length).toBe(1);
    expect(failedQueueRes.json().items[0].reason).toBe("gc_unreferenced");
    expect(s3Server.objects.size).toBe(1);

    // Bring S3 back online and retry failed cleanup queue item -> remote object actually deleted
    s3Server.setOffline(false);
    const retryCleanup = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/storage/cleanup-queue/confirm",
      headers,
      payload: { allAwaiting: true }
    });
    expect(retryCleanup.statusCode).toBe(202);
    await runtime.worker.waitForIdle();
    expect(s3Server.objects.size).toBe(0);

    // Clear thumbnail cache & verify lazy regeneration on next thumbnail request
    const clearCacheRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/cache/clear",
      headers
    });
    expect(clearCacheRes.statusCode).toBe(200);
    expect(clearCacheRes.json().clearedFiles).toBeGreaterThanOrEqual(1);

    const regenThumb = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${localAsset.id}/versions/${localAsset.currentVersionId}/thumbnail`,
      headers: { cookie }
    });
    expect(regenThumb.statusCode).toBe(200);
    expect(regenThumb.headers["content-type"]).toBe("image/webp");

    // Create metadata backup and full backup, download ZIPs, verify SQLite integrity & SHA-256 & zero secrets
    const metaBackupRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups",
      headers,
      payload: { kind: "metadata" }
    });
    expect(metaBackupRes.statusCode).toBe(202);
    const metaBackupId = metaBackupRes.json().backup.id as string;

    const fullBackupRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups",
      headers,
      payload: { kind: "full" }
    });
    expect(fullBackupRes.statusCode).toBe(202);
    const fullBackupId = fullBackupRes.json().backup.id as string;

    await runtime.worker.waitForIdle();

    const listBackupsRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/backups",
      headers: { cookie }
    });
    expect(listBackupsRes.statusCode).toBe(200);
    const backups = listBackupsRes.json().items as Array<{
      id: string;
      status: string;
      kind: string;
      fileCount: number;
    }>;
    expect(backups.find((b) => b.id === metaBackupId)?.status).toBe("ready");
    expect(backups.find((b) => b.id === fullBackupId)?.status).toBe("ready");

    // Inspect metadata backup ZIP
    const metaZipRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/backups/${metaBackupId}/download`,
      headers: { cookie }
    });
    expect(metaZipRes.statusCode).toBe(200);
    const metaEntries = await readZipEntries(metaZipRes.rawPayload);
    expect(metaEntries.has("manifest.json")).toBe(true);
    expect(metaEntries.has("assetnest.db")).toBe(true);
    const metaManifestText = metaEntries.get("manifest.json")!.toString("utf8");
    expect(metaManifestText).not.toContain(s3Server.secretAccessKey);
    expect(metaManifestText).not.toContain(davServer.password);

    // Inspect full backup ZIP: manifest + SQLite integrity_check + verified original file bytes
    const fullZipRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/backups/${fullBackupId}/download`,
      headers: { cookie }
    });
    expect(fullZipRes.statusCode).toBe(200);
    const fullEntries = await readZipEntries(fullZipRes.rawPayload);
    const fullManifest = JSON.parse(fullEntries.get("manifest.json")!.toString("utf8")) as {
      kind: string;
      schemaVersion: number;
      database: { zipPath: string; sha256: string; sizeBytes: number };
      files: Array<{ zipPath: string; sha256: string }>;
    };
    expect(fullManifest.kind).toBe("full");
    expect(fullManifest.schemaVersion).toBeGreaterThanOrEqual(3);

    const dbBuf = fullEntries.get("assetnest.db")!;
    expect(sha256Hex(dbBuf)).toBe(fullManifest.database.sha256);

    const extractedDbPath = path.join(dir, "restored-check.db");
    fs.writeFileSync(extractedDbPath, dbBuf);
    const restoredDb = new DatabaseSync(extractedDbPath);
    try {
      const integrity = restoredDb.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      expect(integrity.integrity_check).toBe("ok");
    } finally {
      restoredDb.close();
    }

    expect(fullManifest.files.length).toBe(1);
    const archivedFile = fullEntries.get(fullManifest.files[0]!.zipPath)!;
    expect(archivedFile).toBeDefined();
    expect(sha256Hex(archivedFile)).toBe(localAsset.sha256);
  });
});
