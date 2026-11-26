import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  parseStorageProviderConfig,
  rawAppConfigSchema,
  type ResolvedAppConfig,
  type StorageProviderConfig
} from "./schema.js";

const ENV_REF_REGEX = /\$\{([A-Z0-9_]+)\}/g;

function interpolateEnvStrings(
  value: unknown,
  env: NodeJS.ProcessEnv,
  keyPath: string
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF_REGEX, (_match, varName: string) => {
      const resolved = env[varName];
      if (resolved === undefined || resolved === "") {
        throw new Error(`配置项 "${keyPath}" 引用的环境变量 ${varName} 未设置`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => interpolateEnvStrings(item, env, `${keyPath}[${idx}]`));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      output[k] = interpolateEnvStrings(v, env, keyPath ? `${keyPath}.${k}` : k);
    }
    return output;
  }
  return value;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveConfigFilePath(options: LoadConfigOptions = {}): string | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (options.configPath) {
    return path.resolve(cwd, options.configPath);
  }
  if (env.ASSETNEST_CONFIG_PATH) {
    const explicit = path.resolve(cwd, env.ASSETNEST_CONFIG_PATH);
    if (fs.existsSync(explicit)) {
      return explicit;
    }
    if (env.ASSETNEST_CONFIG_PATH !== "/config/config.yaml") {
      throw new Error(`指定的配置文件不存在: ${explicit}`);
    }
    return null;
  }

  const candidates = ["/config/config.yaml", path.resolve(cwd, "config/config.yaml")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedAppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigFilePath(options);

  let rawParsed: Record<string, unknown> = {};
  if (configPath) {
    const content = fs.readFileSync(configPath, "utf8");
    const doc = parseYaml(content, { uniqueKeys: true });
    if (doc !== null && doc !== undefined) {
      if (typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error(`配置文件根结构必须为 YAML 对象: ${configPath}`);
      }
      rawParsed = doc as Record<string, unknown>;
    }
  }

  const rawWithoutProviders: Record<string, unknown> = { ...rawParsed };
  const rawStorageObj =
    rawParsed.storage && typeof rawParsed.storage === "object" && !Array.isArray(rawParsed.storage)
      ? (rawParsed.storage as Record<string, unknown>)
      : {};
  const rawProvidersMap =
    rawStorageObj.providers &&
    typeof rawStorageObj.providers === "object" &&
    !Array.isArray(rawStorageObj.providers)
      ? (rawStorageObj.providers as Record<string, unknown>)
      : undefined;

  if (rawParsed.storage) {
    rawWithoutProviders.storage = {
      ...rawStorageObj,
      providers: undefined
    };
  }

  const interpolatedBase = interpolateEnvStrings(rawWithoutProviders, env, "") as Record<
    string,
    unknown
  >;
  const base = rawAppConfigSchema.parse(interpolatedBase);

  const dataDir = path.resolve(cwd, env.ASSETNEST_DATA_DIR || base.app.dataDir);
  const dbPath = base.database.path
    ? path.resolve(cwd, base.database.path)
    : path.join(dataDir, "db", "assetnest.db");
  const cachePath = base.cache.path
    ? path.resolve(cwd, base.cache.path)
    : path.join(dataDir, "cache");
  const tempDir = base.uploads.tempDir
    ? path.resolve(cwd, base.uploads.tempDir)
    : path.join(dataDir, "imports");

  const resolvedProviders: Record<string, StorageProviderConfig> = {};

  if (!rawProvidersMap || Object.keys(rawProvidersMap).length === 0) {
    resolvedProviders.local = {
      name: "本地存储",
      type: "local",
      enabled: true,
      root: path.join(dataDir, "assets")
    };
  } else {
    for (const [providerId, rawProvider] of Object.entries(rawProvidersMap)) {
      if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) {
        throw new Error(`存储 Provider "${providerId}" 必须是对象`);
      }
      const record = rawProvider as Record<string, unknown>;
      if (record.enabled === false) {
        resolvedProviders[providerId] = parseStorageProviderConfig(providerId, record);
      } else {
        const interpolated = interpolateEnvStrings(
          record,
          env,
          `storage.providers.${providerId}`
        ) as Record<string, unknown>;
        const parsed = parseStorageProviderConfig(providerId, interpolated);
        if (parsed.enabled && parsed.type === "local") {
          resolvedProviders[providerId] = {
            ...parsed,
            root: path.resolve(cwd, parsed.root)
          };
        } else {
          resolvedProviders[providerId] = parsed;
        }
      }
    }
  }

  const defaultId = base.storage.default;
  const defaultProvider = resolvedProviders[defaultId];
  if (!defaultProvider) {
    throw new Error(`默认存储 "${defaultId}" 未在 storage.providers 中定义`);
  }
  if (!defaultProvider.enabled) {
    throw new Error(`默认存储 "${defaultId}" 已被禁用，请指定一个已启用的存储作为默认存储`);
  }

  const host = env.ASSETNEST_HOST || base.app.host;
  const port = env.ASSETNEST_PORT ? Number(env.ASSETNEST_PORT) : base.app.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效监听端口: ${String(port)}`);
  }

  const rawAccessCode = env.ASSETNEST_ACCESS_CODE?.trim();
  const accessCode = rawAccessCode && rawAccessCode.length > 0 ? rawAccessCode : null;

  return {
    configPath,
    app: {
      name: base.app.name,
      host,
      port,
      locale: base.app.locale,
      timezone: base.app.timezone,
      dataDir,
      cookieSecure: env.ASSETNEST_COOKIE_SECURE === "true",
      accessCode
    },
    database: {
      path: dbPath,
      wal: base.database.wal
    },
    storage: {
      default: defaultId,
      providers: resolvedProviders
    },
    cache: {
      path: cachePath,
      maxSizeMB: base.cache.maxSizeMB
    },
    uploads: {
      maxFileSizeMB: base.uploads.maxFileSizeMB,
      maxConcurrency: base.uploads.maxConcurrency,
      tempDir
    },
    worker: {
      concurrency: base.worker.concurrency
    }
  };
}

export function ensureRuntimeDirectories(config: ResolvedAppConfig): void {
  const dirs = [
    config.app.dataDir,
    path.dirname(config.database.path),
    config.cache.path,
    config.uploads.tempDir,
    path.join(config.app.dataDir, "exports"),
    path.join(config.app.dataDir, "backups")
  ];
  for (const provider of Object.values(config.storage.providers)) {
    if (provider.enabled && provider.type === "local") {
      dirs.push(provider.root);
    }
  }
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
