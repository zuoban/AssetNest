import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";
import {
  buildThumbnailRelPath,
  resolveThumbnailAbsPath
} from "../../src/server/modules/media/thumbnail.js";

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-m1-"));
  tempDirs.push(dir);
  return dir;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) return "";
  const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return first ? first.split(";")[0] ?? "" : "";
}

function buildMultipartPayload(parts: Array<
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; data: Buffer }
>): { body: Buffer; contentType: string } {
  const boundary = `----AssetNestTest${crypto.randomUUID().replace(/-/g, "")}`;
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

  return { dir, dataDir, config, runtime, cookie };
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("M1 API integration (Products, SKUs, Assets, Deduplication, Search, Security, Trash)", () => {
  it("enforces Product/SKU uniqueness and supports content-addressed deduplication with independent asset lifecycles", async () => {
    const { runtime, cookie } = await bootAuthedApp();
    const authHeaders = { cookie, "x-assetnest-request": "1" };

    // Create two products
    const p1Res = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: {
        spu: "SPU-CUP-01",
        nameZh: "304不锈钢保温水杯",
        nameEn: "Insulated Stainless Tumbler",
        category: "Drinkware",
        specs: [
          { specKey: "材质", specValue: "304不锈钢", unit: "", position: 0 },
          { specKey: "容量", specValue: "500", unit: "ml", position: 1 }
        ],
        appearanceConstraints: { color: "磨砂白", forbiddenChanges: "保留正面LOGO" }
      }
    });
    expect(p1Res.statusCode).toBe(201);
    const p1 = p1Res.json();

    const p2Res = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: {
        spu: "SPU-CUP-02",
        nameZh: "便携咖啡随行杯",
        nameEn: "Travel Coffee Mug"
      }
    });
    expect(p2Res.statusCode).toBe(201);
    const p2 = p2Res.json();

    // SKU creation & canonical attribute + global code uniqueness
    const sku1 = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${p1.id}/skus`,
      headers: authHeaders,
      payload: {
        code: "SKU-CUP-01-WHT",
        name: "象牙白 500ml",
        attributes: { 颜色: "象牙白", 容量: "500ml" }
      }
    });
    expect(sku1.statusCode).toBe(201);

    // Same attribute combo in reversed key order must be rejected
    const skuDupAttrs = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${p1.id}/skus`,
      headers: authHeaders,
      payload: {
        code: "SKU-CUP-01-WHT-2",
        name: "重复组合",
        attributes: { 容量: "500ml", 颜色: "象牙白" }
      }
    });
    expect(skuDupAttrs.statusCode).toBe(409);

    // Global SKU code uniqueness across different products
    const skuDupGlobal = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${p2.id}/skus`,
      headers: authHeaders,
      payload: {
        code: "SKU-CUP-01-WHT",
        name: "跨商品重码",
        attributes: { 颜色: "黑色" }
      }
    });
    expect(skuDupGlobal.statusCode).toBe(409);

    // Upload the exact same PNG to two different products
    const pngBuf = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 136, b: 229 } }
    })
      .png()
      .toBuffer();

    const mp1 = buildMultipartPayload([
      { name: "productId", value: p1.id },
      { name: "purpose", value: "main" },
      { name: "files", filename: "tumbler-hero.png", contentType: "image/png", data: pngBuf }
    ]);
    const up1 = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/upload",
      headers: { ...authHeaders, "content-type": mp1.contentType },
      payload: mp1.body
    });
    expect(up1.statusCode).toBe(201);
    expect(up1.json().deduplicatedCount).toBe(0);
    const asset1 = up1.json().items[0];

    const mp2 = buildMultipartPayload([
      { name: "productId", value: p2.id },
      { name: "purpose", value: "detail" },
      { name: "files", filename: "coffee-hero.png", contentType: "image/png", data: pngBuf }
    ]);
    const up2 = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/upload",
      headers: { ...authHeaders, "content-type": mp2.contentType },
      payload: mp2.body
    });
    expect(up2.statusCode).toBe(201);
    expect(up2.json().deduplicatedCount).toBe(1);
    const asset2 = up2.json().items[0];

    expect(asset1.id).not.toBe(asset2.id);
    expect(asset1.sha256).toBe(asset2.sha256);

    // Only 1 row in `files` table for that sha256
    const fileCount = runtime.db.raw
      .prepare("SELECT COUNT(*) AS count FROM files WHERE sha256 = ?")
      .get(asset1.sha256) as { count: number };
    expect(fileCount.count).toBe(1);

    // Editing and soft-deleting asset1 does not affect asset2 or its physical file
    const edit1 = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${asset1.id}`,
      headers: authHeaders,
      payload: { name: "Renamed Hero 1", notes: "仅资产1备注" }
    });
    expect(edit1.statusCode).toBe(200);

    const del1 = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: { assetIds: [asset1.id], action: "soft_delete" }
    });
    expect(del1.statusCode).toBe(200);

    const check2 = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${asset2.id}`,
      headers: { cookie }
    });
    expect(check2.statusCode).toBe(200);
    expect(check2.json().name).toBe("coffee-hero");
    expect(check2.json().originalFilename).toBe("coffee-hero.png");
    expect(check2.json().notes).toBe("");

    const content2 = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${asset2.id}/versions/${asset2.currentVersionId}/content`,
      headers: { cookie }
    });
    expect(content2.statusCode).toBe(200);
    expect(content2.rawPayload.equals(pngBuf)).toBe(true);
  });

  it("supports combined filters, Chinese/Thai/English search (including 1-2 char fallback), and trash restore", async () => {
    const { runtime, cookie } = await bootAuthedApp();
    const authHeaders = { cookie, "x-assetnest-request": "1" };

    const prodRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: {
        spu: "SPU-TH-88",
        nameZh: "泰式冰霸水杯",
        nameEn: "Thai Iced Tumbler"
      }
    });
    const prod = prodRes.json();

    const tagsRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/tags",
      headers: { cookie }
    });
    const allTags = tagsRes.json().items as Array<{ id: string; dimension: string; name: string }>;
    const thTag = allTags.find((t) => t.dimension === "market" && t.name === "TH")!;
    const shopeeTag = allTags.find((t) => t.dimension === "platform" && t.name === "Shopee")!;
    const sceneTag = allTags.find((t) => t.dimension === "scene" && t.name === "居家")!;
    expect(thTag && shopeeTag && sceneTag).toBeTruthy();

    const pngBuf = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 90, g: 180, b: 120 } }
    })
      .png()
      .toBuffer();

    const mp = buildMultipartPayload([
      { name: "productId", value: prod.id },
      { name: "tagIds", value: JSON.stringify([thTag.id, shopeeTag.id, sceneTag.id]) },
      { name: "notes", value: "แก้วเก็บความเย็น ชาเย็น 冰霸杯 Tumbler" },
      { name: "files", filename: "thai-cup-01.png", contentType: "image/png", data: pngBuf }
    ]);
    const upRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/upload",
      headers: { ...authHeaders, "content-type": mp.contentType },
      payload: mp.body
    });
    expect(upRes.statusCode).toBe(201);
    const asset = upRes.json().items[0];

    const removedBatchAction = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: { assetIds: [asset.id], action: "set_review_status", reviewStatus: "approved" }
    });

    expect(removedBatchAction.statusCode).toBe(400);
    expect(asset).not.toHaveProperty("reviewStatus");

    // The combined filter still works when an older client sends the retired review filter.
    const comboRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?productId=${prod.id}&market=TH&platform=Shopee&scene=${encodeURIComponent("居家")}&reviewStatus=rejected`,
      headers: { cookie }
    });
    expect(comboRes.statusCode).toBe(200);
    expect(comboRes.json().total).toBe(1);
    expect(comboRes.json().items[0].id).toBe(asset.id);

    // Multilingual search: 2-char Chinese ("水杯"), Thai ("แก้ว" and 2-char "ชา"), English ("Tumbler")
    for (const term of ["水杯", "แก้ว", "ชา", "Tumbler"]) {
      const searchRes = await runtime.app.inject({
        method: "GET",
        url: `/api/v1/assets?q=${encodeURIComponent(term)}`,
        headers: { cookie }
      });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().total, `Expected match for query "${term}"`).toBe(1);
    }

    // Soft-delete asset & product, verify trash listing, restore both, verify links & search intact
    await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: { assetIds: [asset.id], action: "soft_delete" }
    });
    await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/products/${prod.id}`,
      headers: authHeaders
    });

    const trashRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/trash",
      headers: { cookie }
    });
    expect(trashRes.statusCode).toBe(200);
    expect(trashRes.json().assets).toHaveLength(1);
    expect(trashRes.json().products).toHaveLength(1);

    const restoreProd = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/restore",
      headers: authHeaders,
      payload: { type: "product", ids: [prod.id] }
    });
    expect(restoreProd.statusCode).toBe(200);
    expect(restoreProd.json().restoredCount).toBe(1);

    const restoreAsset = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/trash/restore",
      headers: authHeaders,
      payload: { type: "asset", ids: [asset.id] }
    });
    expect(restoreAsset.statusCode).toBe(200);
    expect(restoreAsset.json().restoredCount).toBe(1);

    const afterRestore = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${asset.id}`,
      headers: { cookie }
    });
    expect(afterRestore.statusCode).toBe(200);
    expect(afterRestore.json().products.map((p: { id: string }) => p.id)).toContain(prod.id);
    expect(afterRestore.json().tags.length).toBe(3);

    // Search index rebuilt after restore
    const postRestoreSearch = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?q=${encodeURIComponent("แก้ว")}`,
      headers: { cookie }
    });
    expect(postRestoreSearch.json().total).toBe(1);
  });

  it("enforces secure preview/download headers (Range 206, SVG/HTML sandbox, plain text, PSD/ZIP) and recovers corrupted thumbnails", async () => {
    const { config, runtime, cookie } = await bootAuthedApp();
    const authHeaders = { cookie, "x-assetnest-request": "1" };

    const pngBuf = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 50, b: 90 } }
    })
      .png()
      .toBuffer();
    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const htmlBuf = Buffer.from("<!doctype html><html><body><script>alert(2)</script></body></html>");
    const txtBuf = Buffer.from("Line 1\nไทย 中文 UTF-8");
    // Minimal MP4 ftyp header + payload for Range test
    const mp4Buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      Buffer.alloc(64, 0x41)
    ]);
    // Minimal ZIP header
    const zipBuf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0x00)]);

    const mp = buildMultipartPayload([
      { name: "files", filename: "photo.png", contentType: "image/png", data: pngBuf },
      { name: "files", filename: "vector.svg", contentType: "image/svg+xml", data: svgBuf },
      { name: "files", filename: "spec.html", contentType: "text/html", data: htmlBuf },
      { name: "files", filename: "readme.txt", contentType: "text/plain", data: txtBuf },
      { name: "files", filename: "demo.mp4", contentType: "video/mp4", data: mp4Buf },
      { name: "files", filename: "design.zip", contentType: "application/zip", data: zipBuf }
    ]);
    const upRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/upload",
      headers: { ...authHeaders, "content-type": mp.contentType },
      payload: mp.body
    });
    expect(upRes.statusCode).toBe(201);
    const uploaded = upRes.json().items as Array<{
      id: string;
      currentVersionId: string;
      originalFilename: string;
      sha256: string;
    }>;
    const byName = (name: string) => uploaded.find((i) => i.originalFilename === name)!;

    // 1. SVG & HTML forced sandbox + nosniff + attachment even with ?preview=1
    for (const activeName of ["vector.svg", "spec.html"]) {
      const item = byName(activeName);
      const res = await runtime.app.inject({
        method: "GET",
        url: `/api/v1/assets/${item.id}/versions/${item.currentVersionId}/content?preview=1`,
        headers: { cookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("sandbox");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/i);
    }

    // 2. Plain text preview returns text/plain inline
    const txtItem = byName("readme.txt");
    const txtRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${txtItem.id}/versions/${txtItem.currentVersionId}/content?preview=1`,
      headers: { cookie }
    });
    expect(txtRes.statusCode).toBe(200);
    expect(String(txtRes.headers["content-type"])).toContain("text/plain");
    expect(txtRes.body).toBe("Line 1\nไทย 中文 UTF-8");

    // 3. Video Range 206
    const mp4Item = byName("demo.mp4");
    const rangeRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${mp4Item.id}/versions/${mp4Item.currentVersionId}/content?preview=1`,
      headers: { cookie, range: "bytes=0-15" }
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers["content-range"]).toBe(`bytes 0-15/${mp4Buf.length}`);
    expect(rangeRes.rawPayload.length).toBe(16);

    // 4. ZIP safe attachment download
    const zipItem = byName("design.zip");
    const zipRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${zipItem.id}/versions/${zipItem.currentVersionId}/content?preview=1`,
      headers: { cookie }
    });
    expect(zipRes.statusCode).toBe(200);
    expect(String(zipRes.headers["content-disposition"])).toMatch(/^attachment;/i);

    // 5. Corrupt cached WebP thumbnail and verify lazy recovery on GET + manual regenerate
    const pngItem = byName("photo.png");
    const thumbAbs = resolveThumbnailAbsPath(
      config.cache.path,
      buildThumbnailRelPath(pngItem.sha256)
    );
    expect(fs.existsSync(thumbAbs)).toBe(true);

    // Corrupt the cached thumbnail
    fs.writeFileSync(thumbAbs, "BROKEN_THUMB_DATA");
    const lazyThumbRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${pngItem.id}/versions/${pngItem.currentVersionId}/thumbnail`,
      headers: { cookie }
    });
    expect(lazyThumbRes.statusCode).toBe(200);
    expect(String(lazyThumbRes.headers["content-type"])).toBe("image/webp");
    expect(lazyThumbRes.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");

    // Delete cached thumbnail and test explicit regenerate endpoint
    fs.rmSync(thumbAbs, { force: true });
    const regenRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/assets/${pngItem.id}/versions/${pngItem.currentVersionId}/regenerate-thumbnail`,
      headers: authHeaders,
      payload: {}
    });
    expect(regenRes.statusCode).toBe(200);
    expect(regenRes.json().thumbStatus).toBe("ready");
    expect(fs.existsSync(thumbAbs)).toBe(true);
  });
});
