import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "../../src/server/storage/local.js";
import { assertSafeObjectKey, buildOriginalObjectKey } from "../../src/server/storage/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-local-store-"));
  tempDirs.push(dir);
  return dir;
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("LocalStorageProvider", () => {
  it("supports atomic put, stat, full/range get, delete, and 4-step testConnection", async () => {
    const dir = makeTempDir();
    const provider = new LocalStorageProvider({
      id: "local-default",
      name: "本地存储",
      rootDir: path.join(dir, "objects")
    });

    const conn = await provider.testConnection();
    expect(conn.ok).toBe(true);
    expect(conn.latencyMs).toBeGreaterThanOrEqual(0);

    const payload = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const sha = crypto.createHash("sha256").update(payload).digest("hex");
    const key = buildOriginalObjectKey(sha);

    await provider.put(key, Readable.from([payload]), {
      contentLength: payload.length,
      contentType: "application/octet-stream",
      sha256: sha
    });
    const stat = await provider.stat(key);
    expect(stat?.size).toBe(payload.length);
    expect(await provider.exists(key)).toBe(true);

    const full = await provider.get(key);
    expect((await readStreamToBuffer(full.stream)).equals(payload)).toBe(true);

    const range = await provider.get(key, { range: { start: 10, end: 15 } });
    const rangeBuf = await readStreamToBuffer(range.stream);
    expect(range.contentRange).toEqual({ start: 10, end: 15, total: payload.length });
    expect(range.size).toBe(6);
    expect(rangeBuf.toString("utf8")).toBe("abcdef");

    await expect(provider.get(key, { range: { start: 999, end: 1000 } })).rejects.toThrow();

    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
  });

  it("rejects path traversal keys and symlink escapes", async () => {
    expect(() => assertSafeObjectKey("../etc/passwd")).toThrow();
    expect(() => assertSafeObjectKey("/etc/passwd")).toThrow();
    expect(() => assertSafeObjectKey("originals\\aa\\bb")).toThrow();
    expect(() => assertSafeObjectKey("originals/a\u0000b")).toThrow();

    const dir = makeTempDir();
    const objectsRoot = path.join(dir, "objects");
    const outsideDir = path.join(dir, "outside");
    fs.mkdirSync(path.join(objectsRoot, "originals"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top-secret");
    fs.symlinkSync(outsideDir, path.join(objectsRoot, "originals", "escape"));

    const provider = new LocalStorageProvider({
      id: "local-default",
      name: "本地存储",
      rootDir: objectsRoot
    });

    await expect(provider.get("originals/escape/secret.txt")).rejects.toThrow(/符号链接|越界|PATH_TRAVERSAL/i);
    await expect(
      provider.put("originals/escape/pwn.txt", Readable.from([Buffer.from("x")]), {
        contentLength: 1,
        contentType: "text/plain"
      })
    ).rejects.toThrow(/符号链接|越界|PATH_TRAVERSAL/i);
  });
});
