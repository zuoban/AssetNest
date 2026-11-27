import type { ResolvedAppConfig } from "../config/schema.js";
import { AppError } from "../http/errors.js";
import { LocalStorageProvider } from "./local.js";
import { S3StorageProvider } from "./s3.js";
import type { StorageProvider } from "./types.js";
import { WebDavStorageProvider } from "./webdav.js";

export interface StorageObjectLockTarget {
  storageId: string;
  objectKey: string;
}

interface ObjectLockQueue {
  locked: boolean;
  waiters: Array<() => void>;
}

export function buildStorageObjectJobLockKey(storageId: string, objectKey: string): string {
  return `object:${storageId}:${objectKey}`;
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const err = new Error("操作已取消");
  err.name = "AbortError";
  return err;
}

export class StorageRegistry {
  private readonly providers = new Map<string, StorageProvider>();
  private readonly objectLocks = new Map<string, ObjectLockQueue>();

  constructor(config: ResolvedAppConfig) {
    for (const [providerId, providerCfg] of Object.entries(config.storage.providers)) {
      if (!providerCfg.enabled) {
        continue;
      }
      if (providerCfg.type === "local") {
        this.providers.set(
          providerId,
          new LocalStorageProvider({
            id: providerId,
            name: providerCfg.name ?? (providerId === "local" ? "本地存储" : providerId),
            rootDir: providerCfg.root
          })
        );
      } else if (providerCfg.type === "s3") {
        this.providers.set(
          providerId,
          new S3StorageProvider({
            id: providerId,
            name: providerCfg.name ?? providerId,
            endpoint: providerCfg.endpoint,
            region: providerCfg.region,
            bucket: providerCfg.bucket,
            prefix: providerCfg.prefix,
            accessKeyId: providerCfg.accessKeyId,
            secretAccessKey: providerCfg.secretAccessKey,
            sessionToken: providerCfg.sessionToken,
            forcePathStyle: providerCfg.forcePathStyle
          })
        );
      } else if (providerCfg.type === "webdav") {
        this.providers.set(
          providerId,
          new WebDavStorageProvider({
            id: providerId,
            name: providerCfg.name ?? providerId,
            endpoint: providerCfg.endpoint,
            root: providerCfg.root,
            username: providerCfg.username,
            password: providerCfg.password
          })
        );
      }
    }
  }

  public get(providerId: string): StorageProvider | null {
    return this.providers.get(providerId) ?? null;
  }

  public require(providerId: string): StorageProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppError(
        503,
        "STORAGE_OFFLINE",
        `存储空间 "${providerId}" 当前不可用或尚未配置适配器`
      );
    }
    return provider;
  }

  public listIds(): string[] {
    return Array.from(this.providers.keys());
  }

  public register(provider: StorageProvider): void {
    this.providers.set(provider.id, provider);
  }

  private buildMemoryLockKey(storageId: string, objectKey: string): string {
    return `${storageId}\0${objectKey}`;
  }

  private async acquireMemoryLock(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }

    let entry = this.objectLocks.get(key);
    if (!entry) {
      entry = { locked: false, waiters: [] };
      this.objectLocks.set(key, entry);
    }

    if (!entry.locked) {
      entry.locked = true;
    } else {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onGrant = () => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          if (settled) {
            return;
          }
          settled = true;
          const idx = entry!.waiters.indexOf(onGrant);
          if (idx >= 0) {
            entry!.waiters.splice(idx, 1);
          }
          if (!entry!.locked && entry!.waiters.length === 0) {
            this.objectLocks.delete(key);
          }
          reject(createAbortError(signal));
        };

        entry!.waiters.push(onGrant);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const current = this.objectLocks.get(key);
      if (!current) {
        return;
      }
      const next = current.waiters.shift();
      if (next) {
        next();
      } else {
        current.locked = false;
        this.objectLocks.delete(key);
      }
    };
  }

  public async withObjectLock<T>(
    storageId: string,
    objectKey: string,
    fn: () => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    return this.withObjectLocks([{ storageId, objectKey }], fn, options);
  }

  public async withObjectLocks<T>(
    targets: ReadonlyArray<StorageObjectLockTarget>,
    fn: () => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    const keys = Array.from(
      new Set(targets.map((target) => this.buildMemoryLockKey(target.storageId, target.objectKey)))
    ).sort();

    const releases: Array<() => void> = [];
    try {
      for (const key of keys) {
        const release = await this.acquireMemoryLock(key, options?.signal);
        releases.push(release);
      }
      if (options?.signal?.aborted) {
        throw createAbortError(options.signal);
      }
      return await fn();
    } finally {
      while (releases.length > 0) {
        releases.pop()!();
      }
    }
  }
}
