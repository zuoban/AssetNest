import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
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

export interface WebDavStorageOptions {
  id: string;
  name: string;
  endpoint: string;
  root?: string;
  username: string;
  password: string;
  requestTimeoutMs?: number;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getcontentlength/>
    <D:getetag/>
    <D:getlastmodified/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>`;

function extractXmlTag(xml: string, tagName: string): string | undefined {
  const pattern = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${tagName}[^>]*>([^<]*)</(?:[a-zA-Z0-9_-]+:)?${tagName}>`,
    "i"
  );
  const match = pattern.exec(xml);
  return match ? match[1]!.trim() : undefined;
}

function mapHttpStatusToError(status: number): { code: ConnectionErrorCode; message: string } {
  if (status === 401) {
    return { code: "AUTH_FAILED", message: "WebDAV 认证失败，请检查用户名与密码" };
  }
  if (status === 403) {
    return { code: "PERMISSION_DENIED", message: "WebDAV 权限不足，拒绝访问目标目录" };
  }
  if (status === 404 || status === 409) {
    return { code: "NOT_FOUND", message: "WebDAV 目标路径或父目录不存在" };
  }
  return { code: "NETWORK_ERROR", message: `WebDAV 服务端返回异常状态码 HTTP ${status}` };
}

export class WebDavStorageProvider implements StorageProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly type = "webdav" as const;
  public readonly capabilities: StorageCapabilities = {
    rangeRead: false,
    presignedUrl: false,
    multipartUpload: false
  };

  private readonly baseUrl: URL;
  private readonly endpointSegments: string[];
  private readonly rootSegments: string[];
  private readonly baseSegments: string[];
  private readonly authHeader: string;
  private readonly requestTimeoutMs: number;

  constructor(options: WebDavStorageOptions) {
    this.id = options.id;
    this.name = options.name;
    const parsed = new URL(options.endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError(400, "VALIDATION_ERROR", "WebDAV endpoint 仅允许 http:// 或 https:// 协议");
    }
    this.baseUrl = parsed;
    const endpointSegments = parsed.pathname.split("/").filter(Boolean);
    const rootSegments = (options.root || "/")
      .split("/")
      .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
    this.endpointSegments = endpointSegments;
    this.rootSegments = rootSegments;
    this.baseSegments = [...endpointSegments, ...rootSegments];
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private buildUrlFromAbsoluteSegments(allSegments: string[], trailingSlash = false): string {
    const encoded = allSegments.map((segment) => encodeURIComponent(segment));
    const pathname = `/${encoded.join("/")}${trailingSlash && encoded.length > 0 ? "/" : ""}`;
    return `${this.baseUrl.origin}${pathname}`;
  }

  private buildUrlForSegments(relativeSegments: string[], trailingSlash = false): string {
    return this.buildUrlFromAbsoluteSegments(
      [...this.baseSegments, ...relativeSegments],
      trailingSlash
    );
  }

  private buildObjectUrl(key: string): string {
    assertSafeObjectKey(key);
    return this.buildUrlForSegments(key.split("/"), false);
  }

  private buildSignal(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  private async safeFetch(
    url: string,
    init: RequestInit & { duplex?: "half" },
    signal?: AbortSignal,
    allowTrailingSlashRedirect = true
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.authHeader);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: this.buildSignal(signal)
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new AppError(503, "STORAGE_OFFLINE", "WebDAV 请求超时或已取消");
      }
      throw new AppError(503, "STORAGE_OFFLINE", `WebDAV 网络请求失败：${e?.message ?? "未知错误"}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new AppError(503, "STORAGE_OFFLINE", "WebDAV 返回了无效的重定向响应");
      }
      const current = new URL(url);
      const target = new URL(location, current);
      const isSameOriginTrailingSlash =
        allowTrailingSlashRedirect &&
        target.origin === current.origin &&
        target.search === current.search &&
        (target.pathname === `${current.pathname}/` || `${target.pathname}/` === current.pathname);

      if (!isSameOriginTrailingSlash) {
        throw new AppError(
          503,
          "STORAGE_OFFLINE",
          `WebDAV 禁止跨源或非目录斜杠重定向（拒绝跳转至 ${target.origin}${target.pathname}）`
        );
      }

      return this.safeFetch(target.toString(), init, signal, false);
    }

    return response;
  }

  private async ensureParentDirectories(key: string, signal?: AbortSignal): Promise<void> {
    const segments = key.split("/");
    const parentSegments = segments.slice(0, -1);

    const mkcolOk = (status: number) =>
      status === 200 || status === 201 || status === 204 || status === 405 || status === 301;

    // Progressively ensure configured root segments exist under the endpoint mount
    const currentRootSegments: string[] = [...this.endpointSegments];
    for (let index = 0; index < this.rootSegments.length; index += 1) {
      currentRootSegments.push(this.rootSegments[index]!);
      const dirUrl = this.buildUrlFromAbsoluteSegments(currentRootSegments, true);
      let res = await this.safeFetch(dirUrl, { method: "MKCOL" }, signal);
      if (res.status === 409 && index === 0 && this.endpointSegments.length > 0) {
        const epWalk: string[] = [];
        for (const epSeg of this.endpointSegments) {
          epWalk.push(epSeg);
          await this.safeFetch(
            this.buildUrlFromAbsoluteSegments(epWalk, true),
            { method: "MKCOL" },
            signal
          );
        }
        res = await this.safeFetch(dirUrl, { method: "MKCOL" }, signal);
      }
      if (!mkcolOk(res.status)) {
        const mapped = mapHttpStatusToError(res.status);
        throw new AppError(
          503,
          "STORAGE_OFFLINE",
          `${mapped.message}（MKCOL ${this.rootSegments.slice(0, index + 1).join("/")}）`
        );
      }
    }

    const prefixParts: string[] = [];
    for (const part of parentSegments) {
      prefixParts.push(part);
      const dirUrl = this.buildUrlForSegments(prefixParts, true);
      const res = await this.safeFetch(dirUrl, { method: "MKCOL" }, signal);
      if (mkcolOk(res.status)) {
        continue;
      }
      const mapped = mapHttpStatusToError(res.status);
      throw new AppError(503, "STORAGE_OFFLINE", `${mapped.message}（MKCOL ${prefixParts.join("/")}）`);
    }
  }

  public async put(key: string, body: Readable, options?: PutOptions): Promise<void> {
    const objectUrl = this.buildObjectUrl(key);
    await this.ensureParentDirectories(key, options?.signal);

    const headers: Record<string, string> = {
      "Content-Type": options?.contentType || "application/octet-stream"
    };
    if (options?.contentLength !== undefined && Number.isFinite(options.contentLength)) {
      headers["Content-Length"] = String(options.contentLength);
    }

    const webStream = Readable.toWeb(body) as unknown as BodyInit;
    const response = await this.safeFetch(
      objectUrl,
      {
        method: "PUT",
        headers,
        body: webStream,
        duplex: "half"
      },
      options?.signal,
      false
    );

    if (!response.ok) {
      const mapped = mapHttpStatusToError(response.status);
      throw new AppError(503, "STORAGE_OFFLINE", mapped.message);
    }
  }

  public async get(key: string, options?: GetOptions): Promise<GetResult> {
    const objectUrl = this.buildObjectUrl(key);
    const response = await this.safeFetch(
      objectUrl,
      {
        method: "GET"
      },
      options?.signal
    );

    if (response.status === 404) {
      throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", "WebDAV 存储对象不存在");
    }
    if (!response.ok || !response.body) {
      const mapped = mapHttpStatusToError(response.status);
      throw new AppError(503, "STORAGE_OFFLINE", mapped.message);
    }

    const contentLengthHeader = response.headers.get("content-length");
    const size =
      contentLengthHeader && /^\d+$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : undefined;

    return {
      stream: Readable.fromWeb(response.body as unknown as WebReadableStream),
      size,
      contentType: response.headers.get("content-type") ?? undefined
    };
  }

  public async stat(key: string): Promise<FileStat> {
    const objectUrl = this.buildObjectUrl(key);
    const headRes = await this.safeFetch(objectUrl, { method: "HEAD" });
    if (headRes.status === 404) {
      throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", "WebDAV 存储对象不存在");
    }
    if (headRes.ok) {
      const lenHeader = headRes.headers.get("content-length");
      if (lenHeader && /^\d+$/.test(lenHeader)) {
        const lastMod = headRes.headers.get("last-modified");
        return {
          size: Number(lenHeader),
          etag: headRes.headers.get("etag")?.replace(/^"|"$/g, "") ?? undefined,
          lastModified: lastMod ? new Date(lastMod) : undefined,
          contentType: headRes.headers.get("content-type") ?? undefined
        };
      }
    } else if (headRes.status !== 405 && headRes.status !== 501) {
      const mapped = mapHttpStatusToError(headRes.status);
      throw new AppError(503, "STORAGE_OFFLINE", mapped.message);
    }

    const propRes = await this.safeFetch(objectUrl, {
      method: "PROPFIND",
      headers: {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8"
      },
      body: PROPFIND_BODY
    });

    if (propRes.status === 404) {
      throw new AppError(404, "STORAGE_OBJECT_NOT_FOUND", "WebDAV 存储对象不存在");
    }
    if (propRes.status !== 200 && propRes.status !== 207) {
      const mapped = mapHttpStatusToError(propRes.status);
      throw new AppError(503, "STORAGE_OFFLINE", mapped.message);
    }

    const xml = await propRes.text();
    const lenText = extractXmlTag(xml, "getcontentlength");
    const etag = extractXmlTag(xml, "getetag")?.replace(/^"|"$/g, "");
    const lastModText = extractXmlTag(xml, "getlastmodified");
    const contentType = extractXmlTag(xml, "getcontenttype");

    return {
      size: lenText && /^\d+$/.test(lenText) ? Number(lenText) : 0,
      etag,
      lastModified: lastModText ? new Date(lastModText) : undefined,
      contentType
    };
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
    const objectUrl = this.buildObjectUrl(key);
    const response = await this.safeFetch(objectUrl, { method: "DELETE" }, undefined, false);
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      const mapped = mapHttpStatusToError(response.status);
      throw new AppError(503, "STORAGE_OFFLINE", mapped.message);
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
          message: `WebDAV 探针对象大小不匹配（预期 ${payload.length}，实际 ${info.size}）`
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
          message: "WebDAV 探针对象读回 SHA-256 校验不一致"
        };
      }

      await this.delete(probeKey);
      probePutSucceeded = false;

      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        code: "OK",
        message: "WebDAV 存储四步读写删与完整性探针验证通过"
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "WebDAV 探针测试失败";
      const code: ConnectionErrorCode = message.includes("认证")
        ? "AUTH_FAILED"
        : message.includes("权限")
          ? "PERMISSION_DENIED"
          : message.includes("不存在")
            ? "NOT_FOUND"
            : message.includes("超时")
              ? "TIMEOUT"
              : message.includes("重定向")
                ? "INVALID_CONFIG"
                : "NETWORK_ERROR";
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        code,
        message
      };
    } finally {
      if (probePutSucceeded) {
        await this.delete(probeKey).catch(() => {});
      }
    }
  }
}
