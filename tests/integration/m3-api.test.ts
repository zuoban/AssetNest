import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-m3-"));
  tempDirs.push(dir);
  return dir;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) return "";
  const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return first ? first.split(";")[0] ?? "" : "";
}

function buildMultipartPayload(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer }
  >
): { body: Buffer; contentType: string } {
  const boundary = `----AssetNestM3Test${crypto.randomUUID().replace(/-/g, "")}`;
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

async function makePngBuffer(r: number, g: number, b: number, width = 80, height = 80): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r, g, b, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

async function bootAuthedApp() {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const config = loadConfig({
    cwd: dir,
    env: { ASSETNEST_DATA_DIR: dataDir, ASSETNEST_ACCESS_CODE: "test-access-code" }
  });
  const runtime = await createApp({ config, logger: false });
  runtimes.push(runtime);

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

async function uploadSingleImage(
  runtime: AppRuntime,
  cookie: string,
  filename: string,
  data: Buffer,
  productId?: string
) {
  const parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer }
  > = [];
  if (productId) {
    parts.push({ name: "productId", value: productId });
  }
  parts.push({ name: "files", filename, contentType: "image/png", data });
  const mp = buildMultipartPayload(parts);
  const res = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/assets/upload",
    headers: {
      cookie,
      "x-assetnest-request": "1",
      "content-type": mp.contentType
    },
    payload: mp.body
  });
  expect(res.statusCode).toBe(201);
  return res.json().items[0];
}

async function waitForJob(
  runtime: AppRuntime,
  authHeaders: Record<string, string>,
  jobId: string,
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}`,
      headers: authHeaders
    });
    expect(res.statusCode).toBe(200);
    const job = res.json();
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("M3 API integration (Master Images, Versions, Multi-Store Listings, Asset Sets, Multilingual PDP)", () => {
  it("AC-05: locks multi-angle master images to immutable versions, preserves history on new version upload, supports independent per-version review, and enforces unlock reason", async () => {
    const { runtime, cookie, authHeaders } = await bootAuthedApp();

    const prodRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: {
        spu: "SPU-M3-MASTER",
        nameZh: "陶瓷内胆保温杯",
        nameEn: "Ceramic Liner Tumbler",
        appearanceConstraints: {
          structure: "直饮翻盖+硅胶提绳",
          proportion: "高宽比 2.4:1",
          color: "磨砂象牙白",
          forbiddenChanges: "禁止修改杯口结构",
          referenceNotes: "核对正面与侧面母图"
        }
      }
    });
    expect(prodRes.statusCode).toBe(201);
    const product = prodRes.json();

    const frontImgV1 = await uploadSingleImage(
      runtime,
      cookie,
      "front-v1.png",
      await makePngBuffer(220, 210, 200, 100, 120),
      product.id
    );
    const sideImgV1 = await uploadSingleImage(
      runtime,
      cookie,
      "side-v1.png",
      await makePngBuffer(180, 190, 200, 100, 120),
      product.id
    );

    // Lock V1 as primary front master image + side master image
    const lockFrontRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/master-images`,
      headers: authHeaders,
      payload: {
        assetVersionId: frontImgV1.currentVersionId,
        angle: "front",
        isPrimary: true,
        lockNote: "正面实拍标准色母图"
      }
    });
    expect(lockFrontRes.statusCode).toBe(201);
    const frontMaster = lockFrontRes.json();
    expect(frontMaster.isPrimary).toBe(true);
    expect(frontMaster.versionNo).toBe(1);

    const lockSideRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/master-images`,
      headers: authHeaders,
      payload: {
        assetVersionId: sideImgV1.currentVersionId,
        angle: "side",
        isPrimary: false,
        lockNote: "侧面提绳结构基准"
      }
    });
    expect(lockSideRes.statusCode).toBe(201);
    const sideMaster = lockSideRes.json();
    expect(sideMaster.isPrimary).toBe(false);

    // Append V2 to front asset
    const v2Payload = buildMultipartPayload([
      { name: "changeNote", value: "AI 场景图重新打光" },
      { name: "promptText", value: "soft morning sunlight on wooden desk" },
      { name: "setAsCurrent", value: "true" },
      {
        name: "file",
        filename: "front-v2.png",
        contentType: "image/png",
        data: await makePngBuffer(240, 225, 210, 120, 120)
      }
    ]);
    const appendRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/assets/${frontImgV1.id}/versions`,
      headers: {
        cookie,
        "x-assetnest-request": "1",
        "content-type": v2Payload.contentType
      },
      payload: v2Payload.body
    });
    expect(appendRes.statusCode).toBe(201);
    const appendBody = appendRes.json();
    expect(appendBody.version.versionNo).toBe(2);
    expect(appendBody.version.reviewStatus).toBe("pending");
    expect(appendBody.asset.currentVersionId).toBe(appendBody.version.id);
    expect(appendBody.asset.versions).toHaveLength(2);

    // Verify front master image STILL pins V1 and reports latestVersionNo = 2
    const mastersRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/products/${product.id}/master-images`,
      headers: authHeaders
    });
    expect(mastersRes.statusCode).toBe(200);
    const activeMasters = mastersRes.json().items;
    const pinnedFront = activeMasters.find((m: { id: string }) => m.id === frontMaster.id);
    expect(pinnedFront.assetVersionId).toBe(frontImgV1.currentVersionId);
    expect(pinnedFront.versionNo).toBe(1);
    expect(pinnedFront.latestVersionNo).toBe(2);

    // Review V2 independently without mutating V1
    const reviewV2Approve = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/asset-versions/${appendBody.version.id}/review`,
      headers: authHeaders,
      payload: { reviewStatus: "approved", reviewNote: "与母图比例一致" }
    });
    expect(reviewV2Approve.statusCode).toBe(200);
    expect(reviewV2Approve.json().reviewStatus).toBe("approved");

    const reviewV2Reject = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/asset-versions/${appendBody.version.id}/review`,
      headers: authHeaders,
      payload: { reviewStatus: "rejected", reviewNote: "杯盖颜色偏暖" }
    });
    expect(reviewV2Reject.statusCode).toBe(200);
    expect(reviewV2Reject.json().reviewStatus).toBe("rejected");

    // Verify V1 is still pending & carries lockedMasterProducts metadata
    const assetDetailRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${frontImgV1.id}`,
      headers: authHeaders
    });
    expect(assetDetailRes.statusCode).toBe(200);
    const assetDetail = assetDetailRes.json();
    const v1Record = assetDetail.versions.find((v: { versionNo: number }) => v.versionNo === 1);
    const v2Record = assetDetail.versions.find((v: { versionNo: number }) => v.versionNo === 2);
    expect(v1Record.reviewStatus).toBe("pending");
    expect(v1Record.lockedMasterProducts).toHaveLength(1);
    expect(v1Record.lockedMasterProducts[0].angle).toBe("front");
    expect(v2Record.reviewStatus).toBe("rejected");
    expect(v2Record.reviewNote).toBe("杯盖颜色偏暖");

    // Switch current version back to V1 without losing V2
    const switchRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/assets/${frontImgV1.id}/current-version`,
      headers: authHeaders,
      payload: { versionId: v1Record.id }
    });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json().currentVersionId).toBe(v1Record.id);
    expect(switchRes.json().versions).toHaveLength(2);

    // Unlock master image with empty unlockNote must fail (400)
    const badUnlockRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/master-images/${frontMaster.id}/unlock`,
      headers: authHeaders,
      payload: { unlockNote: "   " }
    });
    expect(badUnlockRes.statusCode).toBe(400);

    // Unlock & atomically replace front master with V2
    const replaceRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/master-images/${frontMaster.id}/unlock`,
      headers: authHeaders,
      payload: {
        unlockNote: "确认换用新版实拍校色图",
        replacementAssetVersionId: v2Record.id,
        replacementAngle: "front",
        replacementLockNote: "V2 校色版主母图"
      }
    });
    expect(replaceRes.statusCode).toBe(200);
    const replaceBody = replaceRes.json();
    expect(replaceBody.unlocked.unlockedAt).toBeTruthy();
    expect(replaceBody.unlocked.unlockNote).toBe("确认换用新版实拍校色图");
    expect(replaceBody.replacement.assetVersionId).toBe(v2Record.id);
    expect(replaceBody.replacement.isPrimary).toBe(true);

    // History query returns unlocked + active masters
    const historyRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/products/${product.id}/master-images?includeHistory=1`,
      headers: authHeaders
    });
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.json().items).toHaveLength(3);
  });

  it("AC-02 & AC-06: manages multi-store listings, SKU subsets, 9-image carousel reorder, per-SKU isolation, multilingual EN/TH PDP versions, immutability, trash restore, and GC protection", async () => {
    const { runtime, cookie, authHeaders } = await bootAuthedApp();

    // Dictionaries default & custom upsert
    const dictRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/dictionaries",
      headers: authHeaders
    });
    expect(dictRes.statusCode).toBe(200);
    expect(dictRes.json().platforms.length).toBeGreaterThanOrEqual(3);

    const upsertDictRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/dictionaries",
      headers: authHeaders,
      payload: { category: "platform", code: "temu", label: "Temu", isActive: true, position: 99 }
    });
    expect(upsertDictRes.statusCode).toBe(201);

    // 1 SPU + 3 SKUs
    const prodRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: {
        spu: "SPU-M3-MULTI",
        nameZh: "便携随行保温杯",
        nameEn: "Portable Vacuum Tumbler",
        specs: [
          { specKey: "容量", specValue: "500", unit: "ml", position: 0 },
          { specKey: "材质", specValue: "316不锈钢", unit: "", position: 1 }
        ]
      }
    });
    expect(prodRes.statusCode).toBe(201);
    const product = prodRes.json();

    const createSku = async (code: string, name: string, color: string) => {
      const res = await runtime.app.inject({
        method: "POST",
        url: `/api/v1/products/${product.id}/skus`,
        headers: authHeaders,
        payload: { code, name, attributes: { 颜色: color, 容量: "500ml" } }
      });
      expect(res.statusCode).toBe(201);
      return res.json();
    };
    const skuWht = await createSku("M3-WHT-500", "象牙白 500ml", "象牙白");
    const skuBlk = await createSku("M3-BLK-500", "曜石黑 500ml", "曜石黑");
    const skuPnk = await createSku("M3-PNK-500", "樱花粉 500ml", "樱花粉");

    // Create 3 Stores: PH Shopee, PH TikTok, TH Shopee
    const createStore = async (name: string, platform: string, market: string, defaultLanguage: string) => {
      const res = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/stores",
        headers: authHeaders,
        payload: { name, platform, market, defaultLanguage }
      });
      expect(res.statusCode).toBe(201);
      return res.json();
    };
    const storePhShopee = await createStore("PH Shopee 旗舰店", "shopee", "PH", "en");
    const storePhTiktok = await createStore("PH TikTok 自营店", "tiktok_shop", "PH", "en");
    const storeThShopee = await createStore("TH Shopee 泰国店", "shopee", "TH", "th");

    // Create 3 Listings for the same SPU
    const createListing = async (storeId: string, displayName: string, language: string, skuIds: string[]) => {
      const res = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/listings",
        headers: authHeaders,
        payload: { productId: product.id, storeId, displayName, language, skuIds }
      });
      expect(res.statusCode).toBe(201);
      return res.json();
    };
    const listingPhShopee = await createListing(
      storePhShopee.id,
      "PH Shopee Vacuum Tumbler 500ml",
      "en",
      [skuWht.id, skuBlk.id, skuPnk.id]
    );
    const listingPhTiktok = await createListing(
      storePhTiktok.id,
      "PH TikTok Tumbler Hot Sale",
      "en",
      [skuWht.id, skuBlk.id]
    );
    const listingThShopee = await createListing(
      storeThShopee.id,
      "TH Shopee กระบอกน้ำ 500ml",
      "th",
      [skuWht.id, skuPnk.id]
    );

    // Sync channel codes on PH Shopee
    const syncSkuRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/skus`,
      headers: authHeaders,
      payload: {
        items: [
          { skuId: skuWht.id, channelCode: "SHP-PH-WHT", displayName: "Ivory White" },
          { skuId: skuBlk.id, channelCode: "SHP-PH-BLK", displayName: "Obsidian Black" },
          { skuId: skuPnk.id, channelCode: "SHP-PH-PNK", displayName: "Sakura Pink" }
        ]
      }
    });
    expect(syncSkuRes.statusCode).toBe(200);
    const phShopeeDetail = syncSkuRes.json();
    expect(phShopeeDetail.skus).toHaveLength(3);
    expect(phShopeeDetail.skus[0].channelCode).toBe("SHP-PH-WHT");

    // SKU referenced by listing_skus cannot be deleted (409)
    const delSkuBlocked = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/products/${product.id}/skus/${skuWht.id}`,
      headers: authHeaders
    });
    expect(delSkuBlocked.statusCode).toBe(409);

    // Store referenced by active listings cannot be hard-deleted (409)
    const delStoreBlocked = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/stores/${storePhShopee.id}`,
      headers: authHeaders
    });
    expect(delStoreBlocked.statusCode).toBe(409);

    // Upload 9 distinct images for carousel + 3 for SKU binding
    const carouselAssets = [];
    for (let i = 0; i < 9; i += 1) {
      const img = await uploadSingleImage(
        runtime,
        cookie,
        `carousel-${i + 1}.png`,
        await makePngBuffer(20 + i * 22, 80 + i * 10, 150 + i * 8, 100, 100),
        product.id
      );
      carouselAssets.push(img);
    }

    // Save 9-item carousel on PH Shopee, then reverse order and verify persistence
    const initialSetRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: {
        items: carouselAssets.map((a) => ({ assetVersionId: a.currentVersionId }))
      }
    });
    expect(initialSetRes.statusCode).toBe(200);
    expect(initialSetRes.json().sets.carousel.items).toHaveLength(9);

    const reversed = [...carouselAssets].reverse();
    const reorderRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: {
        items: reversed.map((a) => ({ assetVersionId: a.currentVersionId }))
      }
    });
    expect(reorderRes.statusCode).toBe(200);
    const reorderedItems = reorderRes.json().sets.carousel.items;
    expect(reorderedItems.map((it: { assetVersionId: string }) => it.assetVersionId)).toEqual(
      reversed.map((a) => a.currentVersionId)
    );

    // Append V2 to first carousel image -> carousel must stay on V1 and set hasNewerVersion = true
    const firstAsset = reversed[0];
    const v2Mp = buildMultipartPayload([
      { name: "changeNote", value: "优化卖点标注" },
      { name: "setAsCurrent", value: "true" },
      {
        name: "file",
        filename: "carousel-9-v2.png",
        contentType: "image/png",
        data: await makePngBuffer(250, 250, 20, 100, 100)
      }
    ]);
    const v2Res = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/assets/${firstAsset.id}/versions`,
      headers: {
        cookie,
        "x-assetnest-request": "1",
        "content-type": v2Mp.contentType
      },
      payload: v2Mp.body
    });
    expect(v2Res.statusCode).toBe(201);
    const firstAssetV2Id = v2Res.json().version.id;

    const afterV2SetsRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets`,
      headers: authHeaders
    });
    expect(afterV2SetsRes.statusCode).toBe(200);
    const slot0 = afterV2SetsRes.json().sets.carousel.items[0];
    expect(slot0.assetVersionId).toBe(firstAsset.currentVersionId);
    expect(slot0.versionNo).toBe(1);
    expect(slot0.latestVersionNo).toBe(2);
    expect(slot0.hasNewerVersion).toBe(true);

    // Verify storeId asset filter returns assets used by PH Shopee store
    const storeFilteredAssets = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?storeId=${storePhShopee.id}`,
      headers: authHeaders
    });
    expect(storeFilteredAssets.statusCode).toBe(200);
    expect(storeFilteredAssets.json().total).toBe(9);

    // Per-SKU image binding & replacement isolation
    const phListingSku0 = phShopeeDetail.skus[0];
    const phListingSku1 = phShopeeDetail.skus[1];
    const skuSet1 = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets/sku`,
      headers: authHeaders,
      payload: {
        items: [
          { assetVersionId: carouselAssets[0].currentVersionId, listingSkuId: phListingSku0.id },
          { assetVersionId: carouselAssets[1].currentVersionId, listingSkuId: phListingSku1.id }
        ]
      }
    });
    expect(skuSet1.statusCode).toBe(200);

    // Replace only sku0's image with firstAssetV2Id
    const skuSet2 = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets/sku`,
      headers: authHeaders,
      payload: {
        items: [
          { assetVersionId: firstAssetV2Id, listingSkuId: phListingSku0.id },
          { assetVersionId: carouselAssets[1].currentVersionId, listingSkuId: phListingSku1.id }
        ]
      }
    });
    expect(skuSet2.statusCode).toBe(200);
    const skuItems = skuSet2.json().sets.sku.items;
    expect(skuItems.find((i: { listingSkuId: string }) => i.listingSkuId === phListingSku0.id).assetVersionId).toBe(
      firstAssetV2Id
    );
    expect(skuItems.find((i: { listingSkuId: string }) => i.listingSkuId === phListingSku1.id).assetVersionId).toBe(
      carouselAssets[1].currentVersionId
    );

    // Cross-listing listing_sku_id must be rejected
    const tiktokListingSku0 = listingPhTiktok.skus[0];
    const crossSkuRes = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets/sku`,
      headers: authHeaders,
      payload: {
        items: [{ assetVersionId: carouselAssets[0].currentVersionId, listingSkuId: tiktokListingSku0.id }]
      }
    });
    expect(crossSkuRes.statusCode).toBe(400);

    // Multilingual PDP: English on PH Shopee & Thai (with tone marks) on TH Shopee
    const enPdpSave = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingPhShopee.id}/pdp/draft`,
      headers: authHeaders,
      payload: {
        language: "en",
        content: {
          title: "Portable 316 Stainless Vacuum Tumbler 500ml",
          subtitle: "12h Cold / 8h Hot",
          bullets: ["Food-grade 316 liner", "Leakproof flip lid"],
          description: "Ideal for daily commute and office use.",
          specs: [{ specKey: "容量", specValue: "500", unit: "ml" }],
          keywords: ["tumbler", "insulated", "500ml"],
          notes: "PH Shopee EN copy"
        }
      }
    });
    expect(enPdpSave.statusCode).toBe(200);

    const thaiTitle = "กระบอกน้ำสุญญากาศ 500 มล. เก็บความเย็น 12 ชม.";
    const thPdpSave = await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingThShopee.id}/pdp/draft`,
      headers: authHeaders,
      payload: {
        language: "th",
        content: {
          title: thaiTitle,
          subtitle: "สแตนเลส 316 ไม่เป็นสนิม",
          bullets: ["เก็บความเย็นยาวนาน 12 ชั่วโมง", "ฝาปิดสนิทไม่รั่วซึม"],
          description: "เหมาะสำหรับพกพาไปทำงานและออกกำลังกาย",
          specs: [{ specKey: "容量", specValue: "500", unit: "ml" }],
          keywords: ["กระบอกน้ำ", "เก็บความเย็น"],
          notes: "TH Shopee draft"
        }
      }
    });
    expect(thPdpSave.statusCode).toBe(200);
    expect(thPdpSave.json().draft.titleCodePoints).toBe(Array.from(thaiTitle).length);

    // Update product spec (500 -> 550ml) -> PDP reports specDiff WITHOUT auto-overwriting draft
    const updateSpecRes = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}`,
      headers: authHeaders,
      payload: {
        specs: [
          { specKey: "容量", specValue: "550", unit: "ml", position: 0 },
          { specKey: "材质", specValue: "316不锈钢", unit: "", position: 1 }
        ]
      }
    });
    expect(updateSpecRes.statusCode).toBe(200);

    const thPdpCheck = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/listings/${listingThShopee.id}/pdp`,
      headers: authHeaders
    });
    expect(thPdpCheck.statusCode).toBe(200);
    const thPdpData = thPdpCheck.json();
    expect(thPdpData.draft.content.specs[0].specValue).toBe("500");
    expect(
      thPdpData.specDiff.some(
        (d: { specKey: string; kind: string }) => d.specKey === "容量" && d.kind === "changed_in_product"
      )
    ).toBe(true);

    // Freeze TH PDP V1 and verify SQLite immutability triggers block UPDATE & DELETE
    const freezeV1Res = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listingThShopee.id}/pdp/versions`,
      headers: authHeaders,
      payload: { note: "首版泰语定稿" }
    });
    expect(freezeV1Res.statusCode).toBe(201);
    const thPdpV1 = freezeV1Res.json().version;
    expect(thPdpV1.versionNo).toBe(1);
    expect(thPdpV1.content.title).toBe(thaiTitle);

    expect(() => {
      runtime.db.raw.prepare("UPDATE pdp_versions SET note = 'tampered' WHERE id = ?").run(thPdpV1.id);
    }).toThrow(/immutable/i);
    expect(() => {
      runtime.db.raw.prepare("DELETE FROM pdp_versions WHERE id = ?").run(thPdpV1.id);
    }).toThrow(/cannot be deleted/i);

    // Edit TH draft, freeze V2, restore V1 into draft, edit again -> V1 & PH Shopee unchanged
    const editedThaiTitle = "กระบอกน้ำสุญญากาศ รุ่นใหม่ 500 มล.";
    await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${listingThShopee.id}/pdp/draft`,
      headers: authHeaders,
      payload: {
        language: "th",
        content: { ...thPdpData.draft.content, title: editedThaiTitle }
      }
    });
    const freezeV2Res = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listingThShopee.id}/pdp/versions`,
      headers: authHeaders,
      payload: { note: "第二版泰语" }
    });
    expect(freezeV2Res.statusCode).toBe(201);

    const restoreV1Res = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listingThShopee.id}/pdp/restore/${thPdpV1.id}`,
      headers: authHeaders,
      payload: {}
    });
    expect(restoreV1Res.statusCode).toBe(200);
    expect(restoreV1Res.json().draft.content.title).toBe(thaiTitle);

    // Copy EN PDP from PH Shopee to PH TikTok
    const copyPdpRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listingPhShopee.id}/pdp/copy-to`,
      headers: authHeaders,
      payload: { targetListingId: listingPhTiktok.id, keepTargetLanguage: true }
    });
    expect(copyPdpRes.statusCode).toBe(200);
    expect(copyPdpRes.json().draft.content.title).toBe("Portable 316 Stainless Vacuum Tumbler 500ml");

    // Duplicate PH Shopee as independent draft and verify edits don't affect original
    const dupRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/listings/${listingPhShopee.id}/duplicate`,
      headers: authHeaders,
      payload: { displayName: "PH Shopee Copy Draft" }
    });
    expect(dupRes.statusCode).toBe(201);
    const dupListing = dupRes.json();
    expect(dupListing.status).toBe("draft");
    expect(dupListing.carouselCount).toBe(9);

    await runtime.app.inject({
      method: "PUT",
      url: `/api/v1/listings/${dupListing.id}/asset-sets/carousel`,
      headers: authHeaders,
      payload: { items: [{ assetVersionId: carouselAssets[0].currentVersionId }] }
    });
    const origSetsAfterDupEdit = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/listings/${listingPhShopee.id}/asset-sets`,
      headers: authHeaders
    });
    expect(origSetsAfterDupEdit.json().sets.carousel.items).toHaveLength(9);

    // Listing soft-delete -> Trash -> Restore
    const delListingRes = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/listings/${dupListing.id}`,
      headers: authHeaders
    });
    expect(delListingRes.statusCode).toBe(200);

    const trashRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/trash",
      headers: authHeaders
    });
    expect(trashRes.statusCode).toBe(200);
    expect(trashRes.json().listings.some((l: { id: string }) => l.id === dupListing.id)).toBe(true);

    const restoreListingRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/restore",
      headers: authHeaders,
      payload: { type: "listing", ids: [dupListing.id] }
    });
    expect(restoreListingRes.statusCode).toBe(200);
    expect(restoreListingRes.json().restoredCount).toBe(1);

    const restoredListingRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/listings/${dupListing.id}`,
      headers: authHeaders
    });
    expect(restoredListingRes.statusCode).toBe(200);
    expect(restoredListingRes.json().displayName).toBe("PH Shopee Copy Draft");

    // GC Reference Protection: soft-delete an asset referenced by PH Shopee's carousel,
    // run forced GC, and verify the underlying file is protected (NOT deleted)
    const referencedAsset = carouselAssets[2];
    const softDelAssetRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: { assetIds: [referencedAsset.id], action: "soft_delete" }
    });
    expect(softDelAssetRes.statusCode).toBe(200);

    const gcRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/gc",
      headers: authHeaders,
      payload: { forceIgnoreRetention: true }
    });
    expect(gcRes.statusCode).toBe(202);
    const gcJob = await waitForJob(runtime, authHeaders, gcRes.json().job.id);
    expect(gcJob.status).toBe("succeeded");

    // File row for referencedAsset's current version must still exist because asset_set_items references it
    const fileCheck = runtime.db.raw
      .prepare(
        `SELECT f.id FROM asset_versions av JOIN files f ON f.id = av.file_id WHERE av.id = ?`
      )
      .get(referencedAsset.currentVersionId) as { id: string } | undefined;
    expect(fileCheck).toBeDefined();
  });
});
