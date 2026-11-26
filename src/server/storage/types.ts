import type { Readable } from "node:stream";
import type { StorageProviderType } from "../../shared/types.js";
import { AppError } from "../http/errors.js";

export interface StorageCapabilities {
  rangeRead: boolean;
  presignedUrl: boolean;
  multipartUpload: boolean;
}

export interface PutOptions {
  contentType?: string;
  contentLength?: number;
  sha256?: string;
  signal?: AbortSignal;
}

export interface GetOptions {
  range?: { start: number; end?: number };
  signal?: AbortSignal;
}

export interface FileStat {
  size: number;
  etag?: string;
  lastModified?: Date;
  contentType?: string;
}

export interface GetResult {
  stream: Readable;
  size?: number;
  contentRange?: { start: number; end: number; total: number };
  contentType?: string;
}

export type ConnectionErrorCode =
  | "OK"
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "INTEGRITY_MISMATCH"
  | "INVALID_CONFIG";

export interface ConnectionResult {
  ok: boolean;
  latencyMs: number;
  code: ConnectionErrorCode;
  message: string;
}

export interface StorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageProviderType;
  readonly capabilities: StorageCapabilities;

  put(key: string, body: Readable, options?: PutOptions): Promise<void>;
  get(key: string, options?: GetOptions): Promise<GetResult>;
  stat(key: string): Promise<FileStat>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  testConnection(): Promise<ConnectionResult>;
}

const ALLOWED_KEY_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const ALLOWED_PREFIXES = ["originals/", "_assetnest_probe/"];

export function assertSafeObjectKey(key: string): void {
  if (!key || typeof key !== "string") {
    throw new AppError(400, "INVALID_OBJECT_KEY", "存储对象键不能为空");
  }
  if (key.startsWith("/") || key.startsWith("\\") || key.includes("\\") || key.includes("\0")) {
    throw new AppError(400, "INVALID_OBJECT_KEY", "存储对象键包含非法路径前缀或控制字符");
  }
  if (!ALLOWED_KEY_PATTERN.test(key)) {
    throw new AppError(400, "INVALID_OBJECT_KEY", "存储对象键包含不被允许的字符");
  }
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AppError(400, "INVALID_OBJECT_KEY", "存储对象键禁止包含空段或路径穿越段");
  }
  if (!ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    throw new AppError(
      400,
      "INVALID_OBJECT_KEY",
      "存储对象键必须位于受控命名空间 originals/ 或 _assetnest_probe/ 下"
    );
  }
}

export function buildOriginalObjectKey(sha256: string): string {
  const normalized = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new AppError(400, "VALIDATION_ERROR", "无效的 SHA-256 哈希值");
  }
  const prefix = normalized.slice(0, 2);
  const key = `originals/${prefix}/${normalized}`;
  assertSafeObjectKey(key);
  return key;
}
