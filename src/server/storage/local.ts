import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../http/errors.js";
import {
  assertSafeObjectKey,
  type ConnectionResult,
  type FileStat,
  type GetOptions,
  type GetResult,
  type PutOptions,
  type StorageCapabilities,
  type StorageProvider
} from "./types.js";

export interface LocalStorageOptions {
  id: string;
  name: string;
  rootDir: string;
}

export class LocalStorageProvider implements StorageProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly type = "local" as const;
  public readonly capabilities: StorageCapabilities = {
    rangeRead: true,
    presignedUrl: false,
    multipartUpload: false
  };

  private readonly rootDir: string;
  private readonly tmpDir: string;

  constructor(options: LocalStorageOptions) {
    this.id = options.id;
    this.name = options.name;
    this.rootDir = path.resolve(options.rootDir);
    this.tmpDir = path.join(this.rootDir, ".tmp");
  }

  private async ensureBaseDirectories(): Promise<string> {
    await fsp.mkdir(this.rootDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    return await fsp.realpath(this.rootDir);
  }

  private async resolveSafePath(key: string, createParents = false): Promise<string> {
    assertSafeObjectKey(key);
    const realRoot = await this.ensureBaseDirectories();
    const resolvedTarget = path.resolve(realRoot, key);
    const relative = path.relative(realRoot, resolvedTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new AppError(400, "PATH_TRAVERSAL", "目标路径越界，已拒绝访问");
    }

    const parentDir = path.dirname(resolvedTarget);
    if (createParents) {
      await fsp.mkdir(parentDir, { recursive: true });
    }

    if (fs.existsSync(parentDir)) {
      const realParent = await fsp.realpath(parentDir);
      const relParent = path.relative(realRoot, realParent);
      if (relParent.startsWith("..") || path.isAbsolute(relParent)) {
        throw new AppError(400, "PATH_TRAVERSAL", "检测到父目录符号链接越界，已拒绝访问");
      }
    }

    try {
      const lstat = await fsp.lstat(resolvedTarget);
      if (lstat.isSymbolicLink()) {
        throw new AppError(400, "PATH_TRAVERSAL", "目标对象禁止为符号链接");
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") {
        throw err;
      }
    }

    return resolvedTarget;
  }

  public async put(key: string, body: Readable, options?: PutOptions): Promise<void> {
    const targetPath = await this.resolveSafePath(key, true);
    const tempPath = path.join(this.tmpDir, `${crypto.randomUUID()}.part`);

    try {
      const writeStream = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o640 });
      await pipeline(body, writeStream, { signal: options?.signal });

      const handle = await fsp.open(tempPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      if (fs.existsSync(targetPath)) {
        const existingStat = await fsp.lstat(targetPath);
        if (existingStat.isSymbolicLink()) {
          throw new AppError(400, "PATH_TRAVERSAL", "目标对象为符号链接，已拒绝覆盖");
        }
        const tempStat = await fsp.stat(tempPath);
        if (existingStat.size === tempStat.size) {
          await fsp.rm(tempPath, { force: true });
          return;
        }
      }

      await fsp.rename(tempPath, targetPath);
    } catch (err) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  public async get(key: string, options?: GetOptions): Promise<GetResult> {
    const targetPath = await this.resolveSafePath(key, false);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", "底层存储对象不存在");
      }
      throw err;
    }

    if (!stat.isFile()) {
      throw new AppError(400, "STORAGE_INVALID_OBJECT", "目标存储对象不是常规文件");
    }

    const total = stat.size;
    if (options?.range) {
      const start = Math.max(0, options.range.start);
      const end =
        options.range.end !== undefined
          ? Math.min(options.range.end, Math.max(total - 1, 0))
          : Math.max(total - 1, 0);

      if (total === 0 || start > end || start >= total) {
        throw new AppError(416, "RANGE_NOT_SATISFIABLE", "请求字节区间超出文件范围");
      }

      const stream = fs.createReadStream(targetPath, { start, end });
      return {
        stream,
        size: end - start + 1,
        contentRange: { start, end, total }
      };
    }

    return {
      stream: fs.createReadStream(targetPath),
      size: total
    };
  }

  public async stat(key: string): Promise<FileStat> {
    const targetPath = await this.resolveSafePath(key, false);
    try {
      const info = await fsp.stat(targetPath);
      return {
        size: info.size,
        lastModified: info.mtime
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", "底层存储对象不存在");
      }
      throw err;
    }
  }

  public async exists(key: string): Promise<boolean> {
    const targetPath = await this.resolveSafePath(key, false);
    try {
      const info = await fsp.lstat(targetPath);
      return info.isFile() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  public async delete(key: string): Promise<void> {
    const targetPath = await this.resolveSafePath(key, false);
    try {
      await fsp.unlink(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  public async testConnection(): Promise<ConnectionResult> {
    const startedAt = Date.now();
    const probeKey = `_assetnest_probe/${crypto.randomUUID()}.tmp`;
    const payload = Buffer.from(`assetnest-probe-${crypto.randomUUID()}`);
    const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

    try {
      await this.put(probeKey, Readable.from(payload), {
        contentLength: payload.length,
        sha256: expectedHash
      });

      const info = await this.stat(probeKey);
      if (info.size !== payload.length) {
        await this.delete(probeKey).catch(() => {});
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          code: "INTEGRITY_MISMATCH",
          message: `探针文件大小不匹配（预期 ${payload.length}，实际 ${info.size}）`
        };
      }

      const readRes = await this.get(probeKey);
      const hash = crypto.createHash("sha256");
      for await (const chunk of readRes.stream) {
        hash.update(chunk as Buffer);
      }
      const actualHash = hash.digest("hex");
      await this.delete(probeKey);

      if (actualHash !== expectedHash) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          code: "INTEGRITY_MISMATCH",
          message: "探针文件读取内容哈希校验不一致"
        };
      }

      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        code: "OK",
        message: "本地存储读写与完整性探针验证通过"
      };
    } catch (err) {
      await this.delete(probeKey).catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        code: code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "本地存储探针测试失败"
      };
    }
  }
}
