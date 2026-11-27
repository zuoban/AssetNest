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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-folders-"));
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
  const boundary = `----AssetNestFolderTest${crypto.randomUUID().replace(/-/g, "")}`;
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
  return { runtime, cookie };
}

async function makeTestPng(seedColor: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: seedColor
    }
  })
    .png()
    .toBuffer();
}

async function uploadImageToFolder(
  runtime: AppRuntime,
  cookie: string,
  filename: string,
  folderId: string,
  color: { r: number; g: number; b: number }
): Promise<string> {
  const png = await makeTestPng(color);
  const mp = buildMultipartPayload([
    { name: "folderId", value: folderId },
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
  return res.json().items[0].id as string;
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Multi-level folder tree API integration", () => {
  it("supports nested CRUD, recursive asset listing, ancestor search indexing, cycle protection, and recursive deletion", async () => {
    const { runtime, cookie } = await bootAuthedApp();
    const authHeaders = { cookie, "x-assetnest-request": "1" };

    // 1. Create a 3-level hierarchy: 品牌库 -> 东南亚 -> 泰语主图
    const rootRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders,
      payload: { name: "品牌库" }
    });
    expect(rootRes.statusCode).toBe(201);
    const rootFolder = rootRes.json();

    const childRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders,
      payload: { name: "东南亚", parentId: rootFolder.id }
    });
    expect(childRes.statusCode).toBe(201);
    const childFolder = childRes.json();
    expect(childFolder.parentId).toBe(rootFolder.id);

    const grandRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders,
      payload: { name: "泰语主图", parentId: childFolder.id }
    });
    expect(grandRes.statusCode).toBe(201);
    const grandFolder = grandRes.json();

    // Same name allowed under a different parent, but rejected at the same level
    const siblingSameName = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders,
      payload: { name: "泰语主图", parentId: rootFolder.id }
    });
    expect(siblingSameName.statusCode).toBe(201);
    const siblingFolder = siblingSameName.json();

    const duplicateSameParent = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders,
      payload: { name: "泰语主图", parentId: childFolder.id }
    });
    expect(duplicateSameParent.statusCode).toBe(409);

    // 2. Upload assets into each level
    const assetRootId = await uploadImageToFolder(runtime, cookie, "root.png", rootFolder.id, {
      r: 200,
      g: 40,
      b: 40
    });
    const assetChildId = await uploadImageToFolder(runtime, cookie, "child.png", childFolder.id, {
      r: 40,
      g: 200,
      b: 40
    });
    const assetGrandId = await uploadImageToFolder(runtime, cookie, "grand.png", grandFolder.id, {
      r: 40,
      g: 40,
      b: 200
    });

    // 3. Listing by parent folder includes subfolders by default
    const recursiveListRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?folderId=${rootFolder.id}`,
      headers: { cookie }
    });
    expect(recursiveListRes.statusCode).toBe(200);
    const recursiveIds = (recursiveListRes.json().items as Array<{ id: string }>).map((i) => i.id);
    expect(recursiveIds.sort()).toEqual([assetRootId, assetChildId, assetGrandId].sort());

    // Listing with includeSubfolders=0 returns only direct assets in that folder
    const directOnlyRes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?folderId=${rootFolder.id}&includeSubfolders=0`,
      headers: { cookie }
    });
    expect(directOnlyRes.statusCode).toBe(200);
    const directIds = (directOnlyRes.json().items as Array<{ id: string }>).map((i) => i.id);
    expect(directIds).toEqual([assetRootId]);

    // 4. Full-text search matches ancestor folder names for deeply nested assets
    const searchByRootName = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?q=${encodeURIComponent("品牌库")}`,
      headers: { cookie }
    });
    expect(searchByRootName.statusCode).toBe(200);
    expect(
      (searchByRootName.json().items as Array<{ id: string }>).map((i) => i.id).sort()
    ).toEqual([assetRootId, assetChildId, assetGrandId].sort());

    // 5. Reject moving a folder into itself or its own descendant
    const selfMove = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/folders/${rootFolder.id}`,
      headers: authHeaders,
      payload: { parentId: rootFolder.id }
    });
    expect(selfMove.statusCode).toBe(400);

    const cycleMove = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/folders/${rootFolder.id}`,
      headers: authHeaders,
      payload: { parentId: grandFolder.id }
    });
    expect(cycleMove.statusCode).toBe(400);

    // 6. Rename root folder and verify descendant search documents are updated
    const renameRoot = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/folders/${rootFolder.id}`,
      headers: authHeaders,
      payload: { name: "跨境素材总库" }
    });
    expect(renameRoot.statusCode).toBe(200);
    expect(renameRoot.json().name).toBe("跨境素材总库");

    const searchAfterRename = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?q=${encodeURIComponent("跨境素材总库")}`,
      headers: { cookie }
    });
    expect(searchAfterRename.statusCode).toBe(200);
    expect(
      (searchAfterRename.json().items as Array<{ id: string }>).map((i) => i.id).sort()
    ).toEqual([assetRootId, assetChildId, assetGrandId].sort());

    // 7. Move grandchild directly to root
    const moveToRoot = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/folders/${grandFolder.id}`,
      headers: authHeaders,
      payload: { parentId: null }
    });
    expect(moveToRoot.statusCode).toBe(200);
    expect(moveToRoot.json().parentId).toBeNull();

    // After moving out of rootFolder, rootFolder subtree no longer contains assetGrandId
    const afterMoveList = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/assets?folderId=${rootFolder.id}`,
      headers: { cookie }
    });
    expect(
      (afterMoveList.json().items as Array<{ id: string }>).map((i) => i.id).sort()
    ).toEqual([assetRootId, assetChildId].sort());

    // Move grandchild back under childFolder to test recursive delete
    const moveBack = await runtime.app.inject({
      method: "PATCH",
      url: `/api/v1/folders/${grandFolder.id}`,
      headers: authHeaders,
      payload: { parentId: childFolder.id }
    });
    expect(moveBack.statusCode).toBe(200);

    // 8. Deleting a parent without recursive=1 fails with 409 CONFLICT
    const nonRecursiveDelete = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/folders/${rootFolder.id}`,
      headers: authHeaders
    });
    expect(nonRecursiveDelete.statusCode).toBe(409);

    // 9. Deleting with recursive=1 removes the whole subtree and unfiles assets without deleting them
    const recursiveDelete = await runtime.app.inject({
      method: "DELETE",
      url: `/api/v1/folders/${rootFolder.id}?recursive=1`,
      headers: authHeaders
    });
    expect(recursiveDelete.statusCode).toBe(200);
    const deleteBody = recursiveDelete.json();
    expect(deleteBody.deleted).toBe(true);
    expect((deleteBody.deletedIds as string[]).sort()).toEqual(
      [rootFolder.id, childFolder.id, grandFolder.id, siblingFolder.id].sort()
    );

    const foldersAfterDelete = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/folders",
      headers: { cookie }
    });
    expect(foldersAfterDelete.json().items).toEqual([]);

    const unfiledRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/assets?unfiled=1",
      headers: { cookie }
    });
    expect(unfiledRes.statusCode).toBe(200);
    expect(
      (unfiledRes.json().items as Array<{ id: string; folderId: string | null }>).map((i) => i.id).sort()
    ).toEqual([assetRootId, assetChildId, assetGrandId].sort());
  });
});
