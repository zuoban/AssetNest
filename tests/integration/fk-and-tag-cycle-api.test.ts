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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-fk-tag-"));
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
  const boundary = `----AssetNestFkTest${crypto.randomUUID().replace(/-/g, "")}`;
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
  return { runtime, cookie, authHeaders: { cookie, "x-assetnest-request": "1" } };
}

async function uploadTestImage(
  runtime: AppRuntime,
  cookie: string,
  filename: string,
  color: { r: number; g: number; b: number }
): Promise<{ id: string; currentVersionId: string }> {
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: color }
  })
    .png()
    .toBuffer();

  const mp = buildMultipartPayload([
    { name: "file", filename, contentType: "image/png", data: png }
  ]);
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
  const item = res.json().items[0] as { id: string; currentVersionId: string };
  return item;
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Backend foreign key validation and tag cycle protection", () => {
  it("prevents tag parent cycles, missing parents, and cross-dimension reparenting while supporting system parent tags", async () => {
    const { runtime, authHeaders } = await bootAuthedApp();
    const missingId = crypto.randomUUID();

    // 1. Allow creating a child tag under a non-UUID system tag
    const sysChildRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: authHeaders,
      payload: { dimension: "market", name: "马尼拉大区", parentId: "sys-market-ph" }
    });
    expect(sysChildRes.statusCode).toBe(201);
    expect(sysChildRes.json().parentId).toBe("sys-market-ph");

    // 2. Reject creating tag with non-existent parent or mismatched dimension
    const createMissingParent = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: authHeaders,
      payload: { dimension: "custom", name: "孤儿标签", parentId: missingId }
    });
    expect(createMissingParent.statusCode).toBe(404);

    const createCrossDim = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: authHeaders,
      payload: { dimension: "color", name: "跨维度子标签", parentId: "sys-market-ph" }
    });
    expect(createCrossDim.statusCode).toBe(400);

    // 3. Build 3-level hierarchy: root -> mid -> leaf
    const rootRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: authHeaders,
      payload: { dimension: "custom", name: "一级标签" }
    });
    expect(rootRes.statusCode).toBe(201);
    const rootTag = rootRes.json() as { id: string };

    const midRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: authHeaders,
      payload: { dimension: "custom", name: "二级标签", parentId: rootTag.id }
    });
    expect(midRes.statusCode).toBe(201);
    const midTag = midRes.json() as { id: string };

    const leafRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: authHeaders,
      payload: { dimension: "custom", name: "三级标签", parentId: midTag.id }
    });
    expect(leafRes.statusCode).toBe(201);
    const leafTag = leafRes.json() as { id: string };

    // 4. Reject self-parenting, 2-node cycle, and 3-node cycle
    const selfCycle = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${rootTag.id}`,
      headers: authHeaders,
      payload: { parentId: rootTag.id }
    });
    expect(selfCycle.statusCode).toBe(400);

    const directCycle = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${rootTag.id}`,
      headers: authHeaders,
      payload: { parentId: midTag.id }
    });
    expect(directCycle.statusCode).toBe(400);
    expect(directCycle.json().error.code).toBe("VALIDATION_ERROR");

    const deepCycle = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${rootTag.id}`,
      headers: authHeaders,
      payload: { parentId: leafTag.id }
    });
    expect(deepCycle.statusCode).toBe(400);
    expect(deepCycle.json().error.code).toBe("VALIDATION_ERROR");

    // 5. Reject non-existent parentId (404, never 500) and cross-dimension parentId (400)
    const missingParentUpdate = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${leafTag.id}`,
      headers: authHeaders,
      payload: { parentId: missingId }
    });
    expect(missingParentUpdate.statusCode).toBe(404);
    expect(missingParentUpdate.json().error.code).toBe("NOT_FOUND");

    const crossDimUpdate = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${leafTag.id}`,
      headers: authHeaders,
      payload: { parentId: "sys-color-black" }
    });
    expect(crossDimUpdate.statusCode).toBe(400);
    expect(crossDimUpdate.json().error.code).toBe("VALIDATION_ERROR");

    // 6. Valid reparenting succeeds
    const validReparent = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${leafTag.id}`,
      headers: authHeaders,
      payload: { parentId: rootTag.id }
    });
    expect(validReparent.statusCode).toBe(200);
    expect(validReparent.json().parentId).toBe(rootTag.id);

    const detachToRoot = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${leafTag.id}`,
      headers: authHeaders,
      payload: { parentId: null }
    });
    expect(detachToRoot.statusCode).toBe(200);
    expect(detachToRoot.json().parentId).toBeNull();
  });

  it("validates product cover and SKU primaryAssetVersionId foreign keys and active product state", async () => {
    const { runtime, cookie, authHeaders } = await bootAuthedApp();
    const missingVersionId = crypto.randomUUID();

    const prodRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: { spu: "SPU-FK-01", nameZh: "外键校验测试商品" }
    });
    expect(prodRes.statusCode).toBe(201);
    const product = prodRes.json() as { id: string };

    const activeAsset = await uploadTestImage(runtime, cookie, "active.png", { r: 20, g: 120, b: 220 });
    const trashedAsset = await uploadTestImage(runtime, cookie, "trashed.png", { r: 220, g: 80, b: 40 });

    const trashRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: { assetIds: [trashedAsset.id], action: "soft_delete" }
    });
    expect(trashRes.statusCode).toBe(200);

    // Reject trashed asset as product cover
    const badCoverRes = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}`,
      headers: authHeaders,
      payload: { coverVersionId: trashedAsset.currentVersionId }
    });
    expect(badCoverRes.statusCode).toBe(400);

    // Reject non-existent or trashed primaryAssetVersionId on SKU create (never 500)
    const skuMissingVer = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/skus`,
      headers: authHeaders,
      payload: {
        code: "SKU-FK-MISS",
        name: "不存在素材SKU",
        attributes: { Color: "Black" },
        primaryAssetVersionId: missingVersionId
      }
    });
    expect(skuMissingVer.statusCode).toBe(404);
    expect(skuMissingVer.json().error.code).toBe("NOT_FOUND");

    const skuTrashedVer = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/skus`,
      headers: authHeaders,
      payload: {
        code: "SKU-FK-TRASH",
        name: "回收站素材SKU",
        attributes: { Color: "Red" },
        primaryAssetVersionId: trashedAsset.currentVersionId
      }
    });
    expect(skuTrashedVer.statusCode).toBe(404);

    // Valid SKU create with active asset version
    const skuCreateRes = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/skus`,
      headers: authHeaders,
      payload: {
        code: "SKU-FK-OK",
        name: "正常SKU",
        attributes: { Color: "Blue" },
        primaryAssetVersionId: activeAsset.currentVersionId
      }
    });
    expect(skuCreateRes.statusCode).toBe(201);
    const sku = skuCreateRes.json() as { id: string; primaryAssetVersionId: string };
    expect(sku.primaryAssetVersionId).toBe(activeAsset.currentVersionId);

    // Reject invalid primaryAssetVersionId on SKU update
    const skuUpdateMissing = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}/skus/${sku.id}`,
      headers: authHeaders,
      payload: { primaryAssetVersionId: missingVersionId }
    });
    expect(skuUpdateMissing.statusCode).toBe(404);

    const skuUpdateTrashed = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}/skus/${sku.id}`,
      headers: authHeaders,
      payload: { primaryAssetVersionId: trashedAsset.currentVersionId }
    });
    expect(skuUpdateTrashed.statusCode).toBe(404);

    // Clearing primaryAssetVersionId to null still works
    const skuClearPrimary = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}/skus/${sku.id}`,
      headers: authHeaders,
      payload: { primaryAssetVersionId: null }
    });
    expect(skuClearPrimary.statusCode).toBe(200);
    expect(skuClearPrimary.json().primaryAssetVersionId).toBeNull();

    // Soft-deleting product blocks SKU update/delete with 404
    const delProd = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/products/${product.id}`,
      headers: authHeaders
    });
    expect(delProd.statusCode).toBe(200);

    const skuUpdateOnDeletedProd = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/products/${product.id}/skus/${sku.id}`,
      headers: authHeaders,
      payload: { name: "已删除商品下的SKU" }
    });
    expect(skuUpdateOnDeletedProd.statusCode).toBe(404);

    const skuDeleteOnDeletedProd = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/products/${product.id}/skus/${sku.id}`,
      headers: authHeaders
    });
    expect(skuDeleteOnDeletedProd.statusCode).toBe(404);
  });

  it("validates batch asset foreign keys and excludes missing or soft-deleted assets from mutations", async () => {
    const { runtime, cookie, authHeaders } = await bootAuthedApp();
    const missingAssetId = crypto.randomUUID();
    const missingProductId = crypto.randomUUID();

    const activeAsset = await uploadTestImage(runtime, cookie, "batch-active.png", { r: 10, g: 200, b: 80 });
    const trashedAsset = await uploadTestImage(runtime, cookie, "batch-trashed.png", { r: 180, g: 30, b: 120 });

    const activeProdRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: { spu: "SPU-BATCH-ACTIVE", nameZh: "活跃商品" }
    });
    const activeProd = activeProdRes.json() as { id: string };

    const trashedProdRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/products",
      headers: authHeaders,
      payload: { spu: "SPU-BATCH-TRASH", nameZh: "回收站商品" }
    });
    const trashedProd = trashedProdRes.json() as { id: string };

    await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: { assetIds: [trashedAsset.id], action: "soft_delete" }
    });
    await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/products/${trashedProd.id}`,
      headers: authHeaders
    });

    // 1. add_tags rejects non-existent tagId with 404 (no partial writes)
    const badTagBatch = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id],
        action: "add_tags",
        tagIds: ["sys-market-ph", "non-existent-tag"]
      }
    });
    expect(badTagBatch.statusCode).toBe(404);

    // Ensure transaction rolled back and did not attach sys-market-ph
    const afterBadTag = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets/${activeAsset.id}`,
      headers: { cookie }
    });
    expect(afterBadTag.json().tags).toEqual([]);

    // 2. link_products rejects missing or soft-deleted productId with 404
    const badMissingProdBatch = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id],
        action: "link_products",
        productIds: [activeProd.id, missingProductId]
      }
    });
    expect(badMissingProdBatch.statusCode).toBe(404);

    const badTrashedProdBatch = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id],
        action: "link_products",
        productIds: [trashedProd.id]
      }
    });
    expect(badTrashedProdBatch.statusCode).toBe(404);

    // 3. Batch mutations only affect active assets (ignoring trashed and missing asset IDs)
    const addTagsOk = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id, trashedAsset.id, missingAssetId],
        action: "add_tags",
        tagIds: ["sys-market-ph"]
      }
    });
    expect(addTagsOk.statusCode).toBe(200);
    expect(addTagsOk.json().affectedCount).toBe(1);

    // Trashed asset must NOT have gained the tag
    const trashedTagRow = runtime.db.raw
      .prepare("SELECT COUNT(*) AS count FROM asset_tags WHERE asset_id = ?")
      .get(trashedAsset.id) as { count: number };
    expect(Number(trashedTagRow.count)).toBe(0);

    const linkProdOk = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id, trashedAsset.id, missingAssetId],
        action: "link_products",
        productIds: [activeProd.id]
      }
    });
    expect(linkProdOk.statusCode).toBe(200);
    expect(linkProdOk.json().affectedCount).toBe(1);

    const trashedProdLinkRow = runtime.db.raw
      .prepare("SELECT COUNT(*) AS count FROM product_assets WHERE asset_id = ?")
      .get(trashedAsset.id) as { count: number };
    expect(Number(trashedProdLinkRow.count)).toBe(0);

    // Empty tagIds/productIds does not falsely claim affectedCount > 0
    const emptyTagsRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id],
        action: "add_tags",
        tagIds: []
      }
    });
    expect(emptyTagsRes.statusCode).toBe(200);
    expect(emptyTagsRes.json().affectedCount).toBe(0);

    // remove_tags & unlink_products only count active assets
    const removeTagsRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id, trashedAsset.id, missingAssetId],
        action: "remove_tags",
        tagIds: ["sys-market-ph"]
      }
    });
    expect(removeTagsRes.statusCode).toBe(200);
    expect(removeTagsRes.json().affectedCount).toBe(1);

    const unlinkProdRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/assets/batch",
      headers: authHeaders,
      payload: {
        assetIds: [activeAsset.id, trashedAsset.id, missingAssetId],
        action: "unlink_products",
        productIds: [activeProd.id]
      }
    });
    expect(unlinkProdRes.statusCode).toBe(200);
    expect(unlinkProdRes.json().affectedCount).toBe(1);
  });
});
