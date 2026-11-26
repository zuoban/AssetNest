import { z } from "zod";

const safeProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Provider ID 仅允许字母、数字、下划线和短横线");

const localProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.literal("local"),
  enabled: z.boolean().default(true),
  root: z.string().min(1)
});

const s3ProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.literal("s3"),
  enabled: z.boolean().default(true),
  endpoint: z.string().url(),
  region: z.string().min(1).default("auto"),
  bucket: z.string().min(1),
  prefix: z.string().default(""),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
  forcePathStyle: z.boolean().default(false)
});

const webdavProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.literal("webdav"),
  enabled: z.boolean().default(true),
  endpoint: z
    .string()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "WebDAV endpoint 仅允许 http:// 或 https:// 协议"
    }),
  root: z.string().default("/"),
  username: z.string().min(1),
  password: z.string().min(1)
});

const disabledProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(["local", "s3", "webdav"]),
  enabled: z.literal(false)
});

export type LocalProviderConfig = z.infer<typeof localProviderSchema>;
export type S3ProviderConfig = z.infer<typeof s3ProviderSchema>;
export type WebDavProviderConfig = z.infer<typeof webdavProviderSchema>;
export type DisabledProviderConfig = z.infer<typeof disabledProviderSchema>;
export type StorageProviderConfig =
  | LocalProviderConfig
  | S3ProviderConfig
  | WebDavProviderConfig
  | DisabledProviderConfig;

export const rawAppConfigSchema = z.object({
  app: z
    .object({
      name: z.string().min(1).max(80).default("AssetNest"),
      host: z.string().min(1).default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(3000),
      locale: z.string().default("zh-CN"),
      timezone: z.string().default("Asia/Shanghai"),
      dataDir: z.string().min(1).default("./data")
    })
    .default({}),
  database: z
    .object({
      path: z.string().min(1).optional(),
      wal: z.boolean().default(true)
    })
    .default({}),
  storage: z
    .object({
      default: safeProviderIdSchema.default("local"),
      providers: z.record(safeProviderIdSchema, z.record(z.unknown())).optional()
    })
    .default({}),
  cache: z
    .object({
      path: z.string().min(1).optional(),
      maxSizeMB: z.number().int().min(64).max(1048576).default(2048)
    })
    .default({}),
  uploads: z
    .object({
      maxFileSizeMB: z.number().int().min(1).max(10240).default(1024),
      maxConcurrency: z.number().int().min(1).max(16).default(4),
      tempDir: z.string().min(1).optional()
    })
    .default({}),
  worker: z
    .object({
      concurrency: z.number().int().min(1).max(8).default(2)
    })
    .default({})
});

export interface ResolvedAppConfig {
  configPath: string | null;
  app: {
    name: string;
    host: string;
    port: number;
    locale: string;
    timezone: string;
    dataDir: string;
    cookieSecure: boolean;
    accessCode: string | null;
  };
  database: {
    path: string;
    wal: boolean;
  };
  storage: {
    default: string;
    providers: Record<string, StorageProviderConfig>;
  };
  cache: {
    path: string;
    maxSizeMB: number;
  };
  uploads: {
    maxFileSizeMB: number;
    maxConcurrency: number;
    tempDir: string;
  };
  worker: {
    concurrency: number;
  };
}

export function parseStorageProviderConfig(
  providerId: string,
  raw: Record<string, unknown>
): StorageProviderConfig {
  const enabledValue = raw.enabled === undefined ? true : raw.enabled;
  if (enabledValue === false) {
    const parsed = disabledProviderSchema.safeParse({
      name: raw.name,
      type: raw.type,
      enabled: false
    });
    if (!parsed.success) {
      throw new Error(`存储 Provider "${providerId}" 配置无效: ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
  }

  const type = raw.type;
  if (type === "local") {
    return localProviderSchema.parse(raw);
  }
  if (type === "s3") {
    return s3ProviderSchema.parse(raw);
  }
  if (type === "webdav") {
    return webdavProviderSchema.parse(raw);
  }
  throw new Error(`存储 Provider "${providerId}" 的协议类型无效: ${String(type)}`);
}
