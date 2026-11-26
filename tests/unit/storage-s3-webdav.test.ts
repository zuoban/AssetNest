import crypto from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { S3StorageProvider } from "../../src/server/storage/s3.js";
import { buildOriginalObjectKey } from "../../src/server/storage/types.js";
import { WebDavStorageProvider } from "../../src/server/storage/webdav.js";
import {
  startTestS3Server,
  startTestWebDavServer,
  type TestS3Server,
  type TestWebDavServer
} from "../helpers/remote-storage-servers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("S3StorageProvider (real HTTP S3-compatible server)", () => {
  it("supports streaming put, stat, Range get, delete, 4-step probe, and error classification", async () => {
    const s3Server: TestS3Server = await startTestS3Server();
    cleanups.push(() => s3Server.close());

    const provider = new S3StorageProvider({
      id: "s3_test",
      name: "Test S3",
      endpoint: s3Server.endpoint,
      region: "auto",
      bucket: s3Server.bucket,
      prefix: "assetnest/",
      accessKeyId: s3Server.accessKeyId,
      secretAccessKey: s3Server.secretAccessKey,
      forcePathStyle: true
    });

    const probe = await provider.testConnection();
    expect(probe.ok).toBe(true);
    expect(probe.code).toBe("OK");
    // Probe must clean up temporary object
    expect(s3Server.objects.size).toBe(0);

    const payload = Buffer.from("AssetNest S3 streaming content 0123456789", "utf8");
    const sha = crypto.createHash("sha256").update(payload).digest("hex");
    const key = buildOriginalObjectKey(sha);

    await provider.put(key, Readable.from([payload]), {
      contentType: "text/plain",
      contentLength: payload.length,
      sha256: sha
    });

    expect(await provider.exists(key)).toBe(true);
    const info = await provider.stat(key);
    expect(info.size).toBe(payload.length);

    const full = await provider.get(key);
    expect((await readStream(full.stream)).equals(payload)).toBe(true);

    const ranged = await provider.get(key, { range: { start: 0, end: 8 } });
    expect(ranged.contentRange).toEqual({ start: 0, end: 8, total: payload.length });
    expect((await readStream(ranged.stream)).toString("utf8")).toBe("AssetNest");

    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
    // Idempotent delete
    await provider.delete(key);

    // Invalid credentials classify as AUTH_FAILED
    const badAuth = new S3StorageProvider({
      id: "s3_bad",
      name: "Bad Auth",
      endpoint: s3Server.endpoint,
      region: "auto",
      bucket: s3Server.bucket,
      accessKeyId: "wrong-key",
      secretAccessKey: "wrong-secret",
      forcePathStyle: true
    });
    const badProbe = await badAuth.testConnection();
    expect(badProbe.ok).toBe(false);
    expect(badProbe.code).toBe("AUTH_FAILED");
  });
});

describe("WebDavStorageProvider (real HTTP WebDAV server)", () => {
  it("supports recursive MKCOL, streaming put, HEAD/PROPFIND fallback, delete, probe, and SSRF redirect guard", async () => {
    const davServer: TestWebDavServer = await startTestWebDavServer();
    cleanups.push(() => davServer.close());

    const provider = new WebDavStorageProvider({
      id: "webdav_test",
      name: "Test WebDAV",
      endpoint: davServer.endpoint,
      root: "/assets-root",
      username: davServer.username,
      password: davServer.password
    });

    const probe = await provider.testConnection();
    expect(probe.ok).toBe(true);
    expect(probe.code).toBe("OK");
    expect(davServer.files.size).toBe(0);

    const payload = Buffer.from("WebDAV streaming payload สวัสดี 你好", "utf8");
    const sha = crypto.createHash("sha256").update(payload).digest("hex");
    const key = buildOriginalObjectKey(sha);

    await provider.put(key, Readable.from([payload]), {
      contentType: "text/plain; charset=utf-8",
      contentLength: payload.length,
      sha256: sha
    });

    expect(await provider.exists(key)).toBe(true);
    expect((await provider.stat(key)).size).toBe(payload.length);

    // Verify PROPFIND Depth: 0 fallback when HEAD returns 405
    davServer.setDisableHead(true);
    const propStat = await provider.stat(key);
    expect(propStat.size).toBe(payload.length);
    davServer.setDisableHead(false);

    const read = await provider.get(key);
    expect((await readStream(read.stream)).equals(payload)).toBe(true);

    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
    await provider.delete(key);

    // Cross-origin redirect SSRF protection
    davServer.setCrossOriginRedirect("http://169.254.169.254/latest/meta-data/");
    const redirectProbe = await provider.testConnection();
    expect(redirectProbe.ok).toBe(false);
    expect(redirectProbe.code).toBe("INVALID_CONFIG");
    davServer.setCrossOriginRedirect(null);

    // Wrong password classification
    const badCreds = new WebDavStorageProvider({
      id: "webdav_bad",
      name: "Bad Dav",
      endpoint: davServer.endpoint,
      root: "/assets-root",
      username: davServer.username,
      password: "wrong-password"
    });
    const authProbe = await badCreds.testConnection();
    expect(authProbe.ok).toBe(false);
    expect(authProbe.code).toBe("AUTH_FAILED");
  });
});
