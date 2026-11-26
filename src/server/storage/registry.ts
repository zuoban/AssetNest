import type { ResolvedAppConfig } from "../config/schema.js";
import { AppError } from "../http/errors.js";
import { LocalStorageProvider } from "./local.js";
import { S3StorageProvider } from "./s3.js";
import type { StorageProvider } from "./types.js";
import { WebDavStorageProvider } from "./webdav.js";

export class StorageRegistry {
  private readonly providers = new Map<string, StorageProvider>();

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
}
