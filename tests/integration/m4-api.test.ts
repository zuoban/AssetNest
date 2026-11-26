import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import yauzl from "yauzl";
import yazl from "yazl";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";
import {
  startTestS3Server,
  type TestS3Server
} from "../helpers/remote-storage-servers.js";

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];
const remoteCleanups: Array<() => Promise<void>> = [];

function makeTempDir(prefix = "assetnest-m4-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function buildMultipartPayload(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer }
  >
): { body: Buffer; contentType: string } {
  const boundary = `----AssetNestM4Test${crypto.randomUUID().replace(/-/g, "")}`;
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

async function makePng(r: number, g: number, b: number, width = 800, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } }
  })
    .png()
    .toBuffer();
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

async function buildZipBuffer(
  entries: Array<{ name: string; data: Buffer; mode?: number }>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      zip.addBuffer(entry.data, entry.name, entry.mode ? { mode: entry.mode } : undefined);
    }
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

async function waitForJob(
  runtime: AppRuntime,
  authHeaders: Record<string, string>,
  jobId: string,
  timeoutMs = 15000
): Promise<{ id: string; status: string; lastError: string | null; result: Record<string, unknown> | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}`,
      headers: authHeaders
    });
    expect(res.statusCode).toBe(200);
    const job = res.json();
    if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
      return job;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function bootApp(options?: {
  s3Server?: TestS3Server;
  maxFileSizeMb?: number;
  startWorker?: boolean;
}) {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const configPath = path.join(dir, "config.yaml");

  const s3Block = options?.s3Server
    ? `
    s3_main:
      type: s3
      name: 测试 S3 存储
      endpoint: ${options.s3Server.endpoint}
      region: us-east-1
      bucket: ${options.s3Server.bucket}
      prefix: assetnest/
      accessKeyId: \${TEST_S3_AK}
      secretAccessKey: \${TEST_S3_SK}
      forcePathStyle: true`
    : "";

  const uploadsBlock = options?.maxFileSizeMb
    ? `
uploads:
  maxFileSizeMB: ${options.maxFileSizeMb}`
    : "";

  const yaml = `
storage:
  default: local
  providers:
    local:
      type: local
      name: 本地存储
      root: ./data/storage${s3Block}${uploadsBlock}
`;
  fs.writeFileSync(configPath, yaml, "utf8");

  const env: Record<string, string> = { ASSETNEST_DATA_DIR: dataDir, ASSETNEST_ACCESS_CODE: "test-access-code" };
  if (options?.s3Server) {
    env.TEST_S3_AK = options.s3Server.accessKeyId;
    env.TEST_S3_SK = options.s3Server.secretAccessKey;
  }

  const config = loadConfig({ cwd: dir, configPath, env });
  const runtime = await createApp({ config, logger: false });
  runtimes.push(runtime);

  if (options?.startWorker !== false) {
    runtime.worker.start();
  }

  const loginRes = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-assetnest-request": "1" },
    payload: { accessCode: "test-access-code" }
  });
  expect(loginRes.statusCode).toBe(200);
  const cookie = extractCookie(loginRes.headers["set-cookie"]);
  const authHeaders = { cookie, "x-assetnest-request": "1" };

  return { dir, dataDir, config, runtime, cookie, authHeaders };
}

async function uploadAsset(
  runtime: AppRuntime,
  authHeaders: Record<string, string>,
  opts: {
    filename: string;
    data: Buffer;
    contentType?: string;
    productId?: string;
    storageId?: string;
    approve?: boolean;
  }
): Promise<{ id: string; currentVersionId: string; sha256: string }> {
  const parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer }
  > = [];
  if (opts.productId) parts.push({ name: "productId", value: opts.productId });
  if (opts.storageId) parts.push({ name: "storageId", value: opts.storageId });
  parts.push({
    name: "file",
    filename: opts.filename,
    contentType: opts.contentType ?? "image/png",
    data: opts.data
  });

  const mp = buildMultipartPayload(parts);
  const res = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/assets/upload",
    headers: { ...authHeaders, "content-type": mp.contentType },
    payload: mp.body
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  const created = body.items[0];

  if (opts.approve) {
    const revRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/asset-versions/${created.currentVersionId}/review`,
      headers: authHeaders,
      payload: { reviewStatus: "approved" }
    });
    expect(revRes.statusCode).toBe(200);
  }

  return {
    id: created.id,
    currentVersionId: created.currentVersionId,
    sha256: sha256Hex(opts.data)
  };
}

afterEach(async () => {
  while (runtimes.length > 0) {
    const rt = runtimes.pop()!;
    await rt.close().catch(() => {});
  }
  while (remoteCleanups.length > 0) {
    const fn = remoteCleanups.pop()!;
    await fn().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("M4 API integration (Templates, Preflight, Immutable Releases, ZIP Export, Restore, Security)", () => {
  it("AC-07: manages versioned templates, blocks formal release on blockers, allows explicit draft package, exports verified 9+3+1+PDP ZIP, enforces immutability, restores draft, and exports open standard ZIP", async () => {
    const { runtime, authHeaders } = await bootApp();

    // 1. Seeded templates exist & CRUD + version auto-increment works
    const listTplRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/export-templates",
      headers: authHeaders
    });
    expect(listTplRes.statusCode).toBe(200);
    const seededTemplates = listTplRes.json().items as Array<{ id: string; platform: string; market: string }>;
    expect(seededTemplates.length).toBeGreaterThanOrEqual(3);

    const createTplRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/export-templates",
      headers: authHeaders,
      payload: {
        name: "Shopee TH 自定义测试模板",
        platform: "shopee",
        market: "TH",
        isDefault: true,
        rules: {
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
            minWidth: 600,
            minHeight: 600,
            maxFileSizeMB: 5,
            allowedExts: ["png", "jpg", "jpeg", "webp"]
          },
          detail: {
            minCount: 1,
            maxCount: 20,
            aspectRatio: "",
            aspectTolerance: 0.2,
            minWidth: 600,
            minHeight: 600,
            maxFileSizeMB: 5,
            allowedExts: ["png", "jpg", "jpeg", "webp"]
          },
          sku: {
            required: true,
            minWidth: 600,
            minHeight: 600,
            maxFileSizeMB: 5,
            allowedExts: ["png", "jpg", "jpeg", "webp"]
          },
          video: {
            maxCount: 1,
            maxFileSizeMB: 50,
            allowedExts: ["mp4"]
          },
          pdp: {
            maxTitleCodePoints: 60,
            requiredFields: ["title", "description"]
          },
          review: {
            requireApprovedForFormal: true
          },
          naming: {
            carouselPrefix: "carousel",
            mainImageName: "main",
            detailPrefix: "detail",
            videoPrefix: "video"
          }
        }
      }
    });
    expect(createTplRes.statusCode).toBe(201);
    const tpl = createTplRes.json();
    expect(tpl.version).toBe(1);

    const patchTplRes = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/export-templates/${tpl.id}`,
      headers: authHeaders,
      payload: { name: "Shopee TH 自定义测试模板 v2" }
    });
    expect(patchTplRes.statusCode).toBe(200);
    expect(patchTplRes.json().version).toBe(2);

    // 2. Create Store, Product, 3 SKUs, and Listing
    const storeRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/stores",
      headers: authHeaders,
      payload: { name: "Shopee 泰国旗舰店", platform: "shopee", market: "TH", defaultLanguage: "th" }
    });
    expect(storeRes.statusCode).toBe(201);
    const store = storeRes.json();

    const prodRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: { spu: "SPU-M4-001", nameZh: "无线降噪耳机", category: "Audio", status: "active" }
    });
    expect(prodRes.statusCode).toBe(201);
    const product = prodRes.json();

    const skuCodes = ["BLK-1", "WHT-1", "RED-1"];
    const skus: Array<{ id: string; code: string }> = [];
    for (const skuCode of skuCodes) {
      const sRes = await runtime.app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/skus`,
        headers: authHeaders,
        payload: { code: skuCode, name: `颜色 ${skuCode}`, attributes: { color: skuCode } }
      });
      expect(sRes.statusCode).toBe(201);
      skus.push(sRes.json());
    }

    const listingRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/listings",
      headers: authHeaders,
      payload: {
        productId: product.id,
        storeId: store.id,
        language: "th",
        displayName: "Shopee TH 首发版",
        skuIds: skus.map((s) => s.id)
      }
    });
    expect(listingRes.statusCode).toBe(201);
    const listing = listingRes.json();
    const listingSkus = listing.skus as Array<{ id: string; skuCode: string }>;
    expect(listingSkus.length).toBe(3);

    // 3. Upload 1 pending image & put it in carousel (missing SKU images, missing detail, missing PDP, pending review, <9 carousel)
    const pendingImg = await uploadAsset(runtime, authHeaders, {
      filename: "pending-01.png",
      data: await makePng(10, 20, 30, 800, 800),
      productId: product.id,
      approve: false
    });

    const setAddPendingRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: { items: [{ assetVersionId: pendingImg.currentVersionId }] }
    });
    expect(setAddPendingRes.statusCode).toBe(200);

    const valBlockedRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listing.id}/validate`,
      headers: authHeaders,
      payload: { templateId: tpl.id }
    });
    expect(valBlockedRes.statusCode).toBe(200);
    const valBlocked = valBlockedRes.json();
    expect(valBlocked.canCreateFormalRelease).toBe(false);
    const blockerCodes = valBlocked.blockers.map((b: { code: string }) => b.code);
    const warningCodes = valBlocked.warnings.map((w: { code: string }) => w.code);
    expect(blockerCodes).toContain("REVIEW_PENDING");
    expect(blockerCodes).toContain("SKU_IMAGE_MISSING");
    expect(blockerCodes).toContain("DETAIL_COUNT_TOO_LOW");
    expect(blockerCodes).toContain("PDP_REQUIRED_FIELD_MISSING");
    expect(warningCodes).toContain("CAROUSEL_BELOW_TARGET");

    // Formal release must be blocked with 409
    const blockedReleaseRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listing.id}/releases`,
      headers: authHeaders,
      payload: { templateId: tpl.id, isDraftPackage: false, note: "should fail" }
    });
    expect(blockedReleaseRes.statusCode).toBe(409);

    // Explicit draft package must succeed & export ZIP containing DRAFT_NOTICE.txt
    const draftReleaseRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listing.id}/releases`,
      headers: authHeaders,
      payload: { templateId: tpl.id, isDraftPackage: true, note: "内部审核草稿包" }
    });
    expect(draftReleaseRes.statusCode).toBe(201);
    const draftRelease = draftReleaseRes.json();
    expect(draftRelease.isDraftPackage).toBe(true);

    const draftExportRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${draftRelease.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    expect(draftExportRes.statusCode).toBe(202);
    const draftJob = await waitForJob(runtime, authHeaders, draftExportRes.json().job.id);
    expect(draftJob.status).toBe("succeeded");

    const draftZipRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/exports/${draftExportRes.json().exportRecord.id}/download`,
      headers: authHeaders
    });
    expect(draftZipRes.statusCode).toBe(200);
    const draftEntries = await readZipEntries(draftZipRes.rawPayload);
    expect(draftEntries.has("DRAFT_NOTICE.txt")).toBe(true);
    const draftManifest = JSON.parse(draftEntries.get("manifest.json")!.toString("utf8"));
    expect(draftManifest.isDraftPackage).toBe(true);

    // 4. Prepare complete valid 9 carousel + 3 SKU + 1 detail + Thai/EN PDP for formal Release
    const carouselAssets: Array<{ id: string; currentVersionId: string; sha256: string }> = [];
    for (let i = 1; i <= 9; i++) {
      const asset = await uploadAsset(runtime, authHeaders, {
        filename: `carousel-0${i}.png`,
        data: await makePng(20 * i, 40, 200 - i * 10, 800, 800),
        productId: product.id,
        approve: true
      });
      carouselAssets.push(asset);
    }

    const addCarouselRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: {
        items: carouselAssets.map((a) => ({ assetVersionId: a.currentVersionId }))
      }
    });
    expect(addCarouselRes.statusCode).toBe(200);

    const skuSetItems: Array<{ assetVersionId: string; listingSkuId: string }> = [];
    for (let i = 0; i < listingSkus.length; i++) {
      const ls = listingSkus[i]!;
      const asset = await uploadAsset(runtime, authHeaders, {
        filename: `sku-${ls.skuCode}.png`,
        data: await makePng(100 + i * 30, 120, 80, 800, 800),
        productId: product.id,
        approve: true
      });
      skuSetItems.push({ assetVersionId: asset.currentVersionId, listingSkuId: ls.id });
    }
    const bindRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/sku`,
      headers: authHeaders,
      payload: { items: skuSetItems }
    });
    expect(bindRes.statusCode).toBe(200);

    const detailAsset = await uploadAsset(runtime, authHeaders, {
      filename: "detail-banner.png",
      data: await makePng(50, 150, 180, 800, 1200),
      productId: product.id,
      approve: true
    });
    const addDetailRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/detail`,
      headers: authHeaders,
      payload: { items: [{ assetVersionId: detailAsset.currentVersionId }] }
    });
    expect(addDetailRes.statusCode).toBe(200);

    // Save multilingual Thai + English PDP draft (title > 60 code points to trigger warning, not blocker)
    const thaiTitle =
      "หูฟังไร้สายตัดเสียงรบกวนระดับพรีเมียม รุ่นใหม่ล่าสุด 2026 ANC Pro Wireless Headphones";
    const thaiDesc = "รายละเอียดสินค้าภาษาไทย: แบตเตอรี่ใช้งานได้นาน 40 ชั่วโมง กันน้ำ IPX5 พร้อมประกันศูนย์ไทย 1 ปี";
    const savePdpRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/pdp/draft`,
      headers: authHeaders,
      payload: {
        content: {
          title: thaiTitle,
          shortDescription: "Bluetooth 5.4 / ANC",
          bullets: ["ตัดเสียงรบกวน -48dB", "แบตอึด 40 ชม."],
          fullDescription: thaiDesc,
          specs: [
            { specKey: "Battery", specValue: "40", unit: "h" },
            { specKey: "WaterResistance", specValue: "IPX5", unit: "" }
          ],
          packageList: "Headphones x1, USB-C Cable x1",
          usageInstructions: "Press and hold 3s to pair",
          seoKeywords: "หูฟังไร้สาย, wireless headphones",
          notes: "V1 formal release copy"
        }
      }
    });
    expect(savePdpRes.statusCode).toBe(200);

    const valCleanRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listing.id}/validate`,
      headers: authHeaders,
      payload: { templateId: tpl.id }
    });
    expect(valCleanRes.statusCode).toBe(200);
    const valClean = valCleanRes.json();
    expect(valClean.canCreateFormalRelease).toBe(true);
    expect(valClean.blockers).toHaveLength(0);
    expect(valClean.warnings.map((w: { code: string }) => w.code)).toContain("PDP_TITLE_TOO_LONG");

    // 5. Create Formal Release & Export ZIP
    const formalReleaseRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listing.id}/releases`,
      headers: authHeaders,
      payload: { templateId: tpl.id, isDraftPackage: false, note: "双11泰国正式发布版" }
    });
    expect(formalReleaseRes.statusCode).toBe(201);
    const formalRelease = formalReleaseRes.json();
    expect(formalRelease.isDraftPackage).toBe(false);
    expect(formalRelease.pdpVersionId).toBeTruthy();
    expect(formalRelease.assets).toHaveLength(13); // 9 carousel + 3 SKU + 1 detail

    const formalExportRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${formalRelease.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    expect(formalExportRes.statusCode).toBe(202);
    const formalJob = await waitForJob(runtime, authHeaders, formalExportRes.json().job.id);
    expect(formalJob.status).toBe("succeeded");

    const formalZipRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/exports/${formalExportRes.json().exportRecord.id}/download`,
      headers: authHeaders
    });
    expect(formalZipRes.statusCode).toBe(200);
    const entries = await readZipEntries(formalZipRes.rawPayload);
    expect(entries.has("DRAFT_NOTICE.txt")).toBe(false);
    expect(entries.has("manifest.json")).toBe(true);
    expect(entries.has("05_PDP/Title.txt")).toBe(true);
    expect(entries.has("05_PDP/Description.txt")).toBe(true);
    expect(entries.has("05_PDP/Specifications.json")).toBe(true);
    expect(entries.has("05_PDP/PDP_Full.json")).toBe(true);

    // Verify directory layout, ordering, UTF-8 text, SHA-256 of every file, and no secret/server path leaks
    const entryNames = Array.from(entries.keys());
    const carouselPaths = entryNames.filter((n) => n.startsWith("01_Carousel/")).sort();
    const skuPaths = entryNames.filter((n) => n.startsWith("02_SKU/")).sort();
    const detailPaths = entryNames.filter((n) => n.startsWith("03_Detail/")).sort();
    expect(carouselPaths).toHaveLength(9);
    expect(skuPaths).toHaveLength(3);
    expect(detailPaths).toHaveLength(1);
    expect(carouselPaths).toContain("01_Carousel/main.png");
    expect(carouselPaths.some((p) => p.startsWith("01_Carousel/02_"))).toBe(true);
    expect(carouselPaths.some((p) => p.startsWith("01_Carousel/09_"))).toBe(true);

    const titleTxt = entries.get("05_PDP/Title.txt")!.toString("utf8");
    const descTxt = entries.get("05_PDP/Description.txt")!.toString("utf8");
    const pdpJson = JSON.parse(entries.get("05_PDP/PDP_Full.json")!.toString("utf8"));
    expect(titleTxt).toContain(thaiTitle);
    expect(descTxt).toContain(thaiDesc);
    expect(pdpJson.content.title).toBe(thaiTitle);

    const manifestRaw = entries.get("manifest.json")!.toString("utf8");
    expect(manifestRaw).not.toContain("/tmp/");
    expect(manifestRaw).not.toContain("/var/");
    expect(manifestRaw).not.toContain("secretAccessKey");
    expect(manifestRaw).not.toContain("X-Amz-Signature");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.isDraftPackage).toBe(false);
    expect(manifest.assets).toHaveLength(13);

    const originalHashes = new Map<string, string>();
    for (const item of manifest.assets as Array<{ relativePath: string; sha256: string }>) {
      const buf = entries.get(item.relativePath);
      expect(buf).toBeDefined();
      const actualHash = sha256Hex(buf!);
      expect(actualHash).toBe(item.sha256);
      originalHashes.set(item.relativePath, actualHash);
    }

    // 6. Mutate draft Listing & upload new version to carousel asset -> re-export old Release must remain 100% identical
    await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/pdp/draft`,
      headers: authHeaders,
      payload: {
        content: {
          title: "MUTATED TITLE AFTER RELEASE",
          shortDescription: "",
          bullets: [],
          fullDescription: "MUTATED DESC",
          specs: [],
          packageList: "",
          usageInstructions: "",
          seoKeywords: "",
          notes: ""
        }
      }
    });

    const mpNewVer = buildMultipartPayload([
      { name: "changeNote", value: "Post-release v2" },
      { name: "setAsCurrent", value: "true" },
      {
        name: "file",
        filename: "carousel-01-v2.png",
        contentType: "image/png",
        data: await makePng(255, 0, 0, 800, 800)
      }
    ]);
    const newVerRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/assets/${carouselAssets[0]!.id}/versions`,
      headers: { ...authHeaders, "content-type": mpNewVer.contentType },
      payload: mpNewVer.body
    });
    expect(newVerRes.statusCode).toBe(201);

    const reExportRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${formalRelease.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    expect(reExportRes.statusCode).toBe(202);
    const reJob = await waitForJob(runtime, authHeaders, reExportRes.json().job.id);
    expect(reJob.status).toBe("succeeded");

    const reZipRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/exports/${reExportRes.json().exportRecord.id}/download`,
      headers: authHeaders
    });
    const reEntries = await readZipEntries(reZipRes.rawPayload);
    expect(reEntries.get("05_PDP/Title.txt")!.toString("utf8")).toContain(thaiTitle);
    expect(reEntries.get("05_PDP/Title.txt")!.toString("utf8")).not.toContain("MUTATED TITLE");
    for (const [expPath, expectedHash] of originalHashes.entries()) {
      expect(sha256Hex(reEntries.get(expPath)!)).toBe(expectedHash);
    }

    // 7. Database immutability triggers block UPDATE/DELETE on releases & release_assets
    expect(() =>
      runtime.db.raw
        .prepare("UPDATE releases SET note = 'hacked' WHERE id = ?")
        .run(formalRelease.id)
    ).toThrow(/immutable|cannot be (updated|deleted)/i);
    expect(() =>
      runtime.db.raw.prepare("DELETE FROM releases WHERE id = ?").run(formalRelease.id)
    ).toThrow(/immutable|cannot be (updated|deleted)/i);
    expect(() =>
      runtime.db.raw
        .prepare("DELETE FROM release_assets WHERE release_id = ?")
        .run(formalRelease.id)
    ).toThrow(/immutable|cannot be (updated|deleted)/i);

    // 8. Restore historical Release as a brand-new independent draft Listing
    const restoreDraftRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${formalRelease.id}/restore-draft`,
      headers: authHeaders,
      payload: { displayName: "从 Release 恢复的新草稿" }
    });
    expect(restoreDraftRes.statusCode).toBe(201);
    const restoredDraft = restoreDraftRes.json();
    expect(restoredDraft.id).not.toBe(listing.id);
    expect(restoredDraft.status).toBe("draft");
    expect(restoredDraft.skus).toHaveLength(3);

    const restoredPdpRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/listings/${restoredDraft.id}/pdp`,
      headers: authHeaders
    });
    expect(restoredPdpRes.json().draft.content.title).toBe(thaiTitle);

    // 9. Standard Open Export ZIP (no vendor lock-in)
    const stdRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/export-standard",
      headers: authHeaders,
      payload: { productId: product.id, includeAllVersions: false }
    });
    expect(stdRes.statusCode).toBe(200);
    const stdEntries = await readZipEntries(stdRes.rawPayload);
    expect(stdEntries.has("manifest.json")).toBe(true);
    const stdManifest = JSON.parse(stdEntries.get("manifest.json")!.toString("utf8"));
    expect(stdManifest.fileCount).toBeGreaterThanOrEqual(13);
    for (const f of stdManifest.files as Array<{ relativePath: string; sha256: string }>) {
      expect(sha256Hex(stdEntries.get(f.relativePath)!)).toBe(f.sha256);
    }
  });

  it("AC-11: protects release-referenced trashed assets from GC while purging expired export ZIPs without harming immutable releases", async () => {
    const { runtime, authHeaders } = await bootApp();

    const store = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/v1/stores",
        headers: authHeaders,
        payload: { name: "US Store", platform: "amazon", market: "US", defaultLanguage: "en" }
      })
    ).json();
    const product = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: authHeaders,
        payload: { spu: "SPU-GC-001", nameZh: "GC Test Item", status: "active" }
      })
    ).json();
    const sku = (
      await runtime.app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/skus`,
        headers: authHeaders,
        payload: { code: "GC-SKU-1", name: "Default" }
      })
    ).json();
    const listing = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/v1/listings",
        headers: authHeaders,
        payload: {
          productId: product.id,
          storeId: store.id,
          displayName: "US GC Listing",
          language: "en",
          skuIds: [sku.id]
        }
      })
    ).json();

    const protectedAsset = await uploadAsset(runtime, authHeaders, {
      filename: "protected.png",
      data: await makePng(12, 34, 56, 800, 800),
      productId: product.id,
      approve: true
    });
    const orphanAsset = await uploadAsset(runtime, authHeaders, {
      filename: "orphan.png",
      data: await makePng(99, 88, 77, 800, 800),
      productId: product.id,
      approve: true
    });

    await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: {
        items: [{ assetVersionId: protectedAsset.currentVersionId }]
      }
    });

    // Create a draft package release referencing protectedAsset
    const relRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listing.id}/releases`,
      headers: authHeaders,
      payload: { isDraftPackage: true, note: "GC protection test" }
    });
    expect(relRes.statusCode).toBe(201);
    const release = relRes.json();

    // Generate an export ZIP for the release
    const expRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${release.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    const expId = expRes.json().exportRecord.id;
    const expJob = await waitForJob(runtime, authHeaders, expRes.json().job.id);
    expect(expJob.status).toBe("succeeded");

    // Soft-delete both assets and backdate purge_after + export expires_at to the past
    await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${protectedAsset.id}`,
      headers: authHeaders
    });
    await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${orphanAsset.id}`,
      headers: authHeaders
    });
    const pastIso = new Date(Date.now() - 40 * 86400_000).toISOString();
    runtime.db.raw
      .prepare("UPDATE assets SET deleted_at = ? WHERE id IN (?, ?)")
      .run(pastIso, protectedAsset.id, orphanAsset.id);
    runtime.db.raw
      .prepare("UPDATE exports SET expires_at = ? WHERE id = ?")
      .run(pastIso, expId);

    // Run GC job
    const gcRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/gc",
      headers: authHeaders,
      payload: {}
    });
    expect(gcRes.statusCode).toBe(202);
    const gcJob = await waitForJob(runtime, authHeaders, gcRes.json().job.id);
    expect(gcJob.status).toBe("succeeded");
    expect((gcJob.result as { expiredExportsCleaned: number }).expiredExportsCleaned).toBeGreaterThanOrEqual(1);

    // Orphan asset purged, protected asset still exists in DB (status='deleted', protected by release_assets)
    const orphanRow = runtime.db.raw
      .prepare("SELECT id FROM assets WHERE id = ?")
      .get(orphanAsset.id);
    const protectedRow = runtime.db.raw
      .prepare("SELECT id, deleted_at FROM assets WHERE id = ?")
      .get(protectedAsset.id) as { id: string; deleted_at: string | null } | undefined;
    expect(orphanRow).toBeUndefined();
    expect(protectedRow).toBeDefined();
    expect(protectedRow!.deleted_at).toBeTruthy();

    // Expired export ZIP download returns 409
    const expiredDownload = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/exports/${expId}/download`,
      headers: authHeaders
    });
    expect(expiredDownload.statusCode).toBe(409);

    // Immutable Release still intact and can regenerate a fresh ZIP cleanly
    const regenRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${release.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    expect(regenRes.statusCode).toBe(202);
    const regenJob = await waitForJob(runtime, authHeaders, regenRes.json().job.id);
    expect(regenJob.status).toBe("succeeded");
    const regenDl = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/exports/${regenRes.json().exportRecord.id}/download`,
      headers: authHeaders
    });
    expect(regenDl.statusCode).toBe(200);
  });

  it("AC-12: restores full multi-storage backup onto a clean instance with FTS reindex & release re-export, and rejects tampered/malicious backups without data loss", async () => {
    const s3ServerA = await startTestS3Server();
    remoteCleanups.push(() => s3ServerA.close());
    const instA = await bootApp({ s3Server: s3ServerA });

    // Populate Instance A with Local + S3 assets, product, SKU, store, listing, and immutable release
    const store = (
      await instA.runtime.app.inject({
        method: "POST",
        url: "/api/v1/stores",
        headers: instA.authHeaders,
        payload: { name: "Lazada TH 恢复测试店", platform: "lazada", market: "TH", defaultLanguage: "th" }
      })
    ).json();
    const product = (
      await instA.runtime.app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: instA.authHeaders,
        payload: { spu: "SPU-RESTORE-99", nameZh: "便携咖啡机 泰文测试", status: "active" }
      })
    ).json();
    const sku = (
      await instA.runtime.app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/skus`,
        headers: instA.authHeaders,
        payload: { code: "COFFEE-BLK", name: "曜石黑" }
      })
    ).json();

    const localAsset = await uploadAsset(instA.runtime, instA.authHeaders, {
      filename: "coffee-local.png",
      data: await makePng(40, 25, 15, 600, 600),
      productId: product.id,
      storageId: "local",
      approve: true
    });
    const s3Asset = await uploadAsset(instA.runtime, instA.authHeaders, {
      filename: "coffee-s3.png",
      data: await makePng(200, 150, 90, 600, 600),
      productId: product.id,
      storageId: "s3_main",
      approve: true
    });

    const listing = (
      await instA.runtime.app.inject({
        method: "POST",
        url: "/api/v1/listings",
        headers: instA.authHeaders,
        payload: {
          productId: product.id,
          storeId: store.id,
          displayName: "Lazada TH 恢复测试上架",
          language: "th",
          skuIds: [sku.id]
        }
      })
    ).json();
    await instA.runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/carousel`,
      headers: instA.authHeaders,
      payload: {
        items: [
          { assetVersionId: localAsset.currentVersionId },
          { assetVersionId: s3Asset.currentVersionId }
        ]
      }
    });
    const relA = (
      await instA.runtime.app.inject({
        method: "POST",
        url: `/api/v1/listings/${listing.id}/releases`,
        headers: instA.authHeaders,
        payload: { isDraftPackage: true, note: "Restore verification release" }
      })
    ).json();

    // Create Full Backup on Instance A
    const bkCreateRes = await instA.runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups",
      headers: instA.authHeaders,
      payload: { kind: "full" }
    });
    expect(bkCreateRes.statusCode).toBe(202);
    const bkJob = await waitForJob(instA.runtime, instA.authHeaders, bkCreateRes.json().job.id);
    expect(bkJob.status).toBe("succeeded");
    const bkDlRes = await instA.runtime.app.inject({
      method: "GET",
      url: `/api/v1/backups/${bkCreateRes.json().backup.id}/download`,
      headers: instA.authHeaders
    });
    expect(bkDlRes.statusCode).toBe(200);
    const fullBackupZip = bkDlRes.rawPayload;

    // Boot brand-new clean Instance B with its own fresh S3 server & empty data dir
    const s3ServerB = await startTestS3Server();
    remoteCleanups.push(() => s3ServerB.close());
    const instB = await bootApp({ s3Server: s3ServerB });

    // Restore Full Backup ZIP onto Instance B via multipart upload
    const restoreMp = buildMultipartPayload([
      { name: "file", filename: "full-backup.zip", contentType: "application/zip", data: fullBackupZip }
    ]);
    const restoreRes = await instB.runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { ...instB.authHeaders, "content-type": restoreMp.contentType },
      payload: restoreMp.body
    });
    expect(restoreRes.statusCode).toBe(200);
    const restoreBody = restoreRes.json();
    expect(restoreBody.kind).toBe("full");
    expect(restoreBody.restoredFileCount).toBeGreaterThanOrEqual(2);
    expect(restoreBody.reindexed.products).toBeGreaterThanOrEqual(1);
    expect(restoreBody.reindexed.assets).toBeGreaterThanOrEqual(2);

    // Re-login on Instance B (since restored DB has Instance A's user/session records)
    const loginB = await instB.runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "test-access-code" }
    });
    expect(loginB.statusCode).toBe(200);
    const headersB = {
      cookie: extractCookie(loginB.headers["set-cookie"]),
      "x-assetnest-request": "1"
    };

    // Verify FTS search works after restore
    const searchProdB = await instB.runtime.app.inject({
      method: "GET",
      url: `/api/v1/products?q=${encodeURIComponent("咖啡机")}`,
      headers: headersB
    });
    expect(searchProdB.statusCode).toBe(200);
    expect(searchProdB.json().items.some((p: { spu: string }) => p.spu === "SPU-RESTORE-99")).toBe(true);

    // Verify both Local and S3 asset files download with exact SHA-256 on Instance B
    const dlLocalB = await instB.runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${localAsset.id}/versions/${localAsset.currentVersionId}/content`,
      headers: headersB
    });
    expect(dlLocalB.statusCode).toBe(200);
    expect(sha256Hex(dlLocalB.rawPayload)).toBe(localAsset.sha256);

    const dlS3B = await instB.runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${s3Asset.id}/versions/${s3Asset.currentVersionId}/content`,
      headers: headersB
    });
    expect(dlS3B.statusCode).toBe(200);
    expect(sha256Hex(dlS3B.rawPayload)).toBe(s3Asset.sha256);

    // Verify historical Release from Instance A can be re-exported on Instance B
    const reExportB = await instB.runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${relA.id}/exports`,
      headers: headersB,
      payload: {}
    });
    expect(reExportB.statusCode).toBe(202);
    const reJobB = await waitForJob(instB.runtime, headersB, reExportB.json().job.id);
    expect(reJobB.status).toBe("succeeded");

    // Corrupt / malicious backups must be rejected cleanly with zero impact on live Instance B data
    const origEntries = await readZipEntries(fullBackupZip);

    // (a) Tampered DB bytes (SHA-256 mismatch)
    const tamperedDbEntries = Array.from(origEntries.entries()).map(([name, data]) => {
      if (name === "assetnest.db") {
        const copy = Buffer.from(data);
        copy[0] = (copy[0]! + 1) % 256;
        return { name, data: copy };
      }
      return { name, data };
    });
    const tamperedDbZip = await buildZipBuffer(tamperedDbEntries);
    const mpTamperedDb = buildMultipartPayload([
      { name: "file", filename: "tampered-db.zip", contentType: "application/zip", data: tamperedDbZip }
    ]);
    const resTamperedDb = await instB.runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { ...headersB, "content-type": mpTamperedDb.contentType },
      payload: mpTamperedDb.body
    });
    expect(resTamperedDb.statusCode).toBeGreaterThanOrEqual(400);
    expect(resTamperedDb.statusCode).toBeLessThan(500);

    // (b) Tampered physical file bytes inside backup ZIP
    const tamperedFileEntries = Array.from(origEntries.entries()).map(([name, data]) => {
      if (name.startsWith("files/")) {
        const copy = Buffer.from(data);
        copy[0] = (copy[0]! + 7) % 256;
        return { name, data: copy };
      }
      return { name, data };
    });
    const tamperedFileZip = await buildZipBuffer(tamperedFileEntries);
    const mpTamperedFile = buildMultipartPayload([
      { name: "file", filename: "tampered-file.zip", contentType: "application/zip", data: tamperedFileZip }
    ]);
    const resTamperedFile = await instB.runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { ...headersB, "content-type": mpTamperedFile.contentType },
      payload: mpTamperedFile.body
    });
    expect(resTamperedFile.statusCode).toBeGreaterThanOrEqual(400);
    expect(resTamperedFile.statusCode).toBeLessThan(500);

    // (c) ZIP-Slip traversal entry (patch placeholder "AA/evil.txt" -> "../evil.txt" in raw ZIP headers)
    const rawSlipZip = await buildZipBuffer([
      { name: "AA/evil.txt", data: Buffer.from("pwned") },
      ...Array.from(origEntries.entries()).map(([name, data]) => ({ name, data }))
    ]);
    const zipSlipBuf = Buffer.from(rawSlipZip);
    const needle = Buffer.from("AA/evil.txt");
    const replacement = Buffer.from("../evil.txt");
    let offset = 0;
    while ((offset = zipSlipBuf.indexOf(needle, offset)) !== -1) {
      replacement.copy(zipSlipBuf, offset);
      offset += replacement.length;
    }
    const mpSlip = buildMultipartPayload([
      { name: "file", filename: "slip.zip", contentType: "application/zip", data: zipSlipBuf }
    ]);
    const resSlip = await instB.runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { ...headersB, "content-type": mpSlip.contentType },
      payload: mpSlip.body
    });
    expect(resSlip.statusCode).toBe(400);

    // (d) Symlink entry inside ZIP (POSIX S_IFLNK = 0o120777)
    const symlinkZipBuf = await buildZipBuffer([
      { name: "files/evil-link", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
      ...Array.from(origEntries.entries()).map(([name, data]) => ({ name, data }))
    ]);
    const mpSymlink = buildMultipartPayload([
      { name: "file", filename: "symlink.zip", contentType: "application/zip", data: symlinkZipBuf }
    ]);
    const resSymlink = await instB.runtime.app.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { ...headersB, "content-type": mpSymlink.contentType },
      payload: mpSymlink.body
    });
    expect(resSymlink.statusCode).toBe(400);

    // Live Instance B data must remain completely intact after all rejected restores
    const verifyProdB = await instB.runtime.app.inject({
      method: "GET",
      url: "/api/v1/products",
      headers: headersB
    });
    expect(verifyProdB.statusCode).toBe(200);
    expect(verifyProdB.json().items.some((p: { spu: string }) => p.spu === "SPU-RESTORE-99")).toBe(true);
  });

  it("AC-13 & AC-14: enforces auth/CSRF on M4 routes, blocks/recovers cleanly when remote storage goes offline, rejects oversized uploads with 413, and regenerates thumbnails after cache clear", async () => {
    const s3Server = await startTestS3Server();
    remoteCleanups.push(() => s3Server.close());
    const { runtime, cookie, authHeaders, dataDir } = await bootApp({
      s3Server,
      maxFileSizeMb: 1
    });

    // AC-13: Unauthenticated access blocked (401)
    const unauthRoutes = [
      { method: "GET" as const, url: "/api/v1/export-templates" },
      { method: "POST" as const, url: "/api/v1/assets/export-standard" },
      { method: "POST" as const, url: "/api/v1/backups/restore" }
    ];
    for (const r of unauthRoutes) {
      const res = await runtime.app.inject({
        method: r.method,
        url: r.url,
        headers: { "x-assetnest-request": "1" },
        payload: r.method === "POST" ? {} : undefined
      });
      expect(res.statusCode).toBe(401);
    }

    // AC-13: Missing CSRF header on state-changing M4 route blocked (403)
    const csrfRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/export-standard",
      headers: { cookie },
      payload: {}
    });
    expect(csrfRes.statusCode).toBe(403);

    // AC-14: Oversized upload (> 1MB) returns 413
    const oversizedMp = buildMultipartPayload([
      {
        name: "file",
        filename: "too-big.bin",
        contentType: "application/octet-stream",
        data: Buffer.alloc(1.5 * 1024 * 1024, 0x42)
      }
    ]);
    const oversizedRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/upload",
      headers: { ...authHeaders, "content-type": oversizedMp.contentType },
      payload: oversizedMp.body
    });
    expect(oversizedRes.statusCode).toBe(413);

    // AC-14: Remote storage offline during validation & export, then recovers when online
    const store = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/v1/stores",
        headers: authHeaders,
        payload: { name: "S3 Offline Test Store", platform: "shopee", market: "SG", defaultLanguage: "en" }
      })
    ).json();
    const product = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: authHeaders,
        payload: { spu: "SPU-OFFLINE-1", nameZh: "Offline Resilient Item", status: "active" }
      })
    ).json();
    const sku = (
      await runtime.app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/skus`,
        headers: authHeaders,
        payload: { code: "OFF-1", name: "Default" }
      })
    ).json();
    const s3Asset = await uploadAsset(runtime, authHeaders, {
      filename: "remote-pic.png",
      data: await makePng(60, 120, 180, 800, 800),
      productId: product.id,
      storageId: "s3_main",
      approve: true
    });
    const listing = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/v1/listings",
        headers: authHeaders,
        payload: {
          productId: product.id,
          storeId: store.id,
          displayName: "S3 Offline Listing",
          language: "en",
          skuIds: [sku.id]
        }
      })
    ).json();
    await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listing.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: { items: [{ assetVersionId: s3Asset.currentVersionId }] }
    });

    const rel = (
      await runtime.app.inject({
        method: "POST",
        url: `/api/v1/listings/${listing.id}/releases`,
        headers: authHeaders,
        payload: { isDraftPackage: true, note: "S3 release before outage" }
      })
    ).json();

    // Take S3 offline
    s3Server.setOffline(true);

    // Validation detects offline storage and flags blocker
    const valOffline = (
      await runtime.app.inject({
        method: "POST",
        url: `/api/v1/listings/${listing.id}/validate`,
        headers: authHeaders,
        payload: {}
      })
    ).json();
    expect(valOffline.canCreateFormalRelease).toBe(false);
    const offlineCodes = valOffline.blockers.map((b: { code: string }) => b.code);
    expect(
      offlineCodes.includes("STORAGE_OFFLINE") || offlineCodes.includes("STORAGE_READ_FAILED")
    ).toBe(true);

    // Export job fails cleanly with no leftover .tmp files
    const expFailRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${rel.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    expect(expFailRes.statusCode).toBe(202);
    const failJob = await waitForJob(runtime, authHeaders, expFailRes.json().job.id);
    expect(failJob.status).toBe("failed");
    expect(failJob.lastError).toBeTruthy();

    const exportsDir = path.join(dataDir, "exports");
    if (fs.existsSync(exportsDir)) {
      const tmpFiles = fs.readdirSync(exportsDir).filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    }

    // Bring S3 back online -> export succeeds & cache clear + lazy thumbnail regen works
    s3Server.setOffline(false);
    const expOkRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/releases/${rel.id}/exports`,
      headers: authHeaders,
      payload: {}
    });
    const okJob = await waitForJob(runtime, authHeaders, expOkRes.json().job.id);
    expect(okJob.status).toBe("succeeded");

    const clearCacheRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/cache/clear",
      headers: authHeaders,
      payload: {}
    });
    expect(clearCacheRes.statusCode).toBe(200);

    const thumbRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${s3Asset.id}/versions/${s3Asset.currentVersionId}/thumbnail`,
      headers: authHeaders
    });
    expect(thumbRes.statusCode).toBe(200);
    expect(thumbRes.headers["content-type"]).toContain("image/webp");
  }, 30000);
});
