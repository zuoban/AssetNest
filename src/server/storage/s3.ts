import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { AppError } from "../http/errors.js";
import {
  assertSafeObjectKey,
  type ConnectionErrorCode,
  type ConnectionResult,
  type FileStat,
  type GetOptions,
  type GetResult,
  type PutOptions,
  type StorageCapabilities,
  type StorageProvider
} from "./types.js";

export interface S3StorageOptions {
  id: string;
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  requestTimeoutMs?: number;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) {
    return "";
  }
  const cleaned = prefix
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (cleaned.length === 0) {
    return "";
  }
  return `${cleaned.join("/")}/`;
}

function parseContentRangeHeader(
  header: string | undefined
): { start: number; end: number; total: number } | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? end + 1 : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) {
    return undefined;
  }
  return { start, end, total };
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }
  if (body && typeof (body as { transformToWebStream?: () => WebReadableStream }).transformToWebStream === "function") {
    return Readable.fromWeb((body as { transformToWebStream: () => WebReadableStream }).transformToWebStream());
  }
  if (body && typeof (body as WebReadableStream).getReader === "function") {
    return Readable.fromWeb(body as WebReadableStream);
  }
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return Readable.from([Buffer.from(body)]);
  }
  throw new AppError(503, "STORAGE_OFFLINE", "S3 响应流格式异常，无法读取对象内容");
}

function classifyS3Error(err: unknown): { code: ConnectionErrorCode; status: number; message: string } {
  const e = err as {
    name?: string;
    Code?: string;
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = e?.name ?? e?.Code ?? "";
  const httpStatus = e?.$metadata?.httpStatusCode;
  const rawMessage = e?.message ?? "S3 存储操作失败";

  if (
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch" ||
    name === "ExpiredToken" ||
    httpStatus === 401
  ) {
    return {
      code: "AUTH_FAILED",
      status: 503,
      message: `S3 认证失败（${name || httpStatus}）：请检查 AccessKey / SecretKey`
    };
  }

  if (name === "AccessDenied" || httpStatus === 403) {
    return {
      code: "PERMISSION_DENIED",
      status: 503,
      message: "S3 权限不足（403 AccessDenied）：请检查存储桶读写删权限"
    };
  }

  if (name === "NoSuchBucket" || name === "NoSuchKey" || name === "NotFound" || httpStatus === 404) {
    return {
      code: "NOT_FOUND",
      status: 404,
      message: name === "NoSuchBucket" ? "S3 存储桶不存在（NoSuchBucket）" : "S3 存储对象不存在"
    };
  }

  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    e?.code === "ETIMEDOUT" ||
    rawMessage.toLowerCase().includes("timeout")
  ) {
    return {
      code: "TIMEOUT",
      status: 503,
      message: "S3 存储请求超时"
    };
  }

  return {
    code: "NETWORK_ERROR",
    status: 503,
    message: `S3 存储访问失败：${rawMessage}`
  };
}

export class S3StorageProvider implements StorageProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly type = "s3" as const;
  public readonly capabilities: StorageCapabilities = {
    rangeRead: true,
    presignedUrl: true,
    multipartUpload: true
  };

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly requestTimeoutMs: number;

  constructor(options: S3StorageOptions) {
    this.id = options.id;
    this.name = options.name;
    this.bucket = options.bucket;
    this.prefix = normalizePrefix(options.prefix);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

    const parsed = new URL(options.endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError(400, "VALIDATION_ERROR", "S3 endpoint 仅允许 http:// 或 https:// 协议");
    }

    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region || "auto",
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken
      },
      maxAttempts: 2
    });
  }

  private resolveKey(key: string): string {
    assertSafeObjectKey(key);
    return `${this.prefix}${key}`;
  }

  private buildSignal(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  public async put(key: string, body: Readable, options?: PutOptions): Promise<void> {
    const s3Key = this.resolveKey(key);
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: s3Key,
          Body: body,
          ContentType: options?.contentType || "application/octet-stream",
          Metadata: options?.sha256 ? { sha256: options.sha256 } : undefined
        },
        partSize: 8 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false
      });

      const abortHandler = () => {
        void upload.abort();
      };
      if (options?.signal) {
        if (options.signal.aborted) {
          await upload.abort();
          throw new AppError(503, "STORAGE_OFFLINE", "S3 上传已取消");
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        await upload.done();
      } finally {
        options?.signal?.removeEventListener("abort", abortHandler);
      }
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      const classified = classifyS3Error(err);
      throw new AppError(classified.status, "STORAGE_OFFLINE", classified.message);
    }
  }

  public async get(key: string, options?: GetOptions): Promise<GetResult> {
    const s3Key = this.resolveKey(key);
    const rangeHeader = options?.range
      ? options.range.end !== undefined
        ? `bytes=${options.range.start}-${options.range.end}`
        : `bytes=${options.range.start}-`
      : undefined;

    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Range: rangeHeader
        }),
        { abortSignal: this.buildSignal(options?.signal) }
      );
      if (!res.Body) {
        throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", "S3 存储对象内容为空");
      }
      return {
        stream: toNodeReadable(res.Body),
        size: res.ContentLength !== undefined ? Number(res.ContentLength) : undefined,
        contentRange: parseContentRangeHeader(res.ContentRange),
        contentType: res.ContentType
      };
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      const classified = classifyS3Error(err);
      if (classified.code === "NOT_FOUND") {
        throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", classified.message);
      }
      throw new AppError(503, "STORAGE_OFFLINE", classified.message);
    }
  }

  public async stat(key: string): Promise<FileStat> {
    const s3Key = this.resolveKey(key);
    try {
      const res = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: s3Key
        }),
        { abortSignal: this.buildSignal() }
      );
      return {
        size: res.ContentLength !== undefined ? Number(res.ContentLength) : 0,
        etag: res.ETag?.replace(/^"|"$/g, ""),
        lastModified: res.LastModified,
        contentType: res.ContentType
      };
    } catch (err) {
      const classified = classifyS3Error(err);
      if (classified.code === "NOT_FOUND") {
        throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", classified.message);
      }
      throw new AppError(503, "STORAGE_OFFLINE", classified.message);
    }
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await this.stat(key);
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === "STORAGE_OBJECT_NOT_FOUND") {
        return false;
      }
      throw err;
    }
  }

  public async delete(key: string): Promise<void> {
    const s3Key = this.resolveKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: s3Key
        }),
        { abortSignal: this.buildSignal() }
      );
    } catch (err) {
      const classified = classifyS3Error(err);
      if (classified.code === "NOT_FOUND") {
        return;
      }
      throw new AppError(503, "STORAGE_OFFLINE", classified.message);
    }
  }

  public async testConnection(): Promise<ConnectionResult> {
    const startedAt = Date.now();
    const probeKey = `_assetnest_probe/${crypto.randomUUID()}.tmp`;
    const payload = crypto.randomBytes(64);
    const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

    let probePutSucceeded = false;
    try {
      await this.put(probeKey, Readable.from([payload]), {
        contentType: "application/octet-stream",
        contentLength: payload.length,
        sha256: expectedHash
      });
      probePutSucceeded = true;

      const info = await this.stat(probeKey);
      if (info.size !== payload.length) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          code: "INTEGRITY_MISMATCH",
          message: `S3 探针对象大小不匹配（预期 ${payload.length}，实际 ${info.size}）`
        };
      }

      const readRes = await this.get(probeKey);
      const hash = crypto.createHash("sha256");
      for await (const chunk of readRes.stream) {
        hash.update(chunk as Buffer);
      }
      const actualHash = hash.digest("hex");
      if (actualHash !== expectedHash) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          code: "INTEGRITY_MISMATCH",
          message: "S3 探针对象读回 SHA-256 校验不一致"
        };
      }

      await this.delete(probeKey);
      probePutSucceeded = false;

      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        code: "OK",
        message: "S3 存储四步读写删与完整性探针验证通过"
      };
    } catch (err) {
      if (err instanceof AppError) {
        const msg = err.message;
        const code: ConnectionErrorCode = msg.includes("认证")
          ? "AUTH_FAILED"
          : msg.includes("权限")
            ? "PERMISSION_DENIED"
            : msg.includes("不存在")
              ? "NOT_FOUND"
              : msg.includes("超时")
                ? "TIMEOUT"
                : "NETWORK_ERROR";
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          code,
          message: msg
        };
      }
      const classified = classifyS3Error(err);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        code: classified.code,
        message: classified.message
      };
    } finally {
      if (probePutSucceeded) {
        await this.delete(probeKey).catch(() => {});
      }
    }
  }
}
