import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestS3Server {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  objects: Map<string, { body: Buffer; contentType: string; etag: string; lastModified: Date }>;
  setOffline(offline: boolean): void;
  setFailNextPut(count: number): void;
  close(): Promise<void>;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function startTestS3Server(options?: {
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): Promise<TestS3Server> {
  const bucket = options?.bucket ?? "assetnest-test";
  const accessKeyId = options?.accessKeyId ?? "test-access-key";
  const secretAccessKey = options?.secretAccessKey ?? "test-secret-key";

  const objects = new Map<
    string,
    { body: Buffer; contentType: string; etag: string; lastModified: Date }
  >();
  const uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();
  let offline = false;
  let failNextPutCount = 0;

  const server = http.createServer(async (req, res) => {
    if (offline) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/xml");
      res.end("<Error><Code>ServiceUnavailable</Code><Message>Simulated S3 offline</Message></Error>");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.includes(`Credential=${accessKeyId}/`)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/xml");
      res.end("<Error><Code>InvalidAccessKeyId</Code><Message>Invalid access key</Message></Error>");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => decodeURIComponent(seg));
    const reqBucket = segments[0];
    const key = segments.slice(1).join("/");

    if (reqBucket !== bucket) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/xml");
      res.end("<Error><Code>NoSuchBucket</Code><Message>No such bucket</Message></Error>");
      return;
    }

    // Multipart upload initiate: POST /bucket/key?uploads
    if (req.method === "POST" && url.searchParams.has("uploads")) {
      if (failNextPutCount > 0) {
        failNextPutCount -= 1;
        res.statusCode = 500;
        res.end("<Error><Code>InternalError</Code><Message>Simulated failure</Message></Error>");
        return;
      }
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, {
        key,
        contentType: String(req.headers["content-type"] || "application/octet-stream"),
        parts: new Map()
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/xml");
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
      );
      return;
    }

    // Multipart upload part: PUT /bucket/key?partNumber=N&uploadId=ID
    if (req.method === "PUT" && url.searchParams.has("uploadId") && url.searchParams.has("partNumber")) {
      const uploadId = url.searchParams.get("uploadId")!;
      const partNumber = Number(url.searchParams.get("partNumber"));
      const entry = uploads.get(uploadId);
      if (!entry) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      const body = await readRequestBody(req);
      entry.parts.set(partNumber, body);
      const etag = `"${crypto.createHash("md5").update(body).digest("hex")}"`;
      res.statusCode = 200;
      res.setHeader("ETag", etag);
      res.end();
      return;
    }

    // Multipart upload complete: POST /bucket/key?uploadId=ID
    if (req.method === "POST" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId")!;
      const entry = uploads.get(uploadId);
      if (!entry) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      await readRequestBody(req);
      const sortedParts = Array.from(entry.parts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, buf]) => buf);
      const combined = Buffer.concat(sortedParts);
      const etag = `"${crypto.createHash("md5").update(combined).digest("hex")}"`;
      objects.set(entry.key, {
        body: combined,
        contentType: entry.contentType,
        etag,
        lastModified: new Date()
      });
      uploads.delete(uploadId);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/xml");
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${entry.key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`
      );
      return;
    }

    // Abort multipart upload: DELETE /bucket/key?uploadId=ID
    if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
      uploads.delete(url.searchParams.get("uploadId")!);
      res.statusCode = 204;
      res.end();
      return;
    }

    // Single-part PUT
    if (req.method === "PUT") {
      const body = await readRequestBody(req);
      if (failNextPutCount > 0) {
        failNextPutCount -= 1;
        res.statusCode = 500;
        res.end("<Error><Code>InternalError</Code><Message>Simulated PUT failure</Message></Error>");
        return;
      }
      const etag = `"${crypto.createHash("md5").update(body).digest("hex")}"`;
      objects.set(key, {
        body,
        contentType: String(req.headers["content-type"] || "application/octet-stream"),
        etag,
        lastModified: new Date()
      });
      res.statusCode = 200;
      res.setHeader("ETag", etag);
      res.end();
      return;
    }

    // HEAD
    if (req.method === "HEAD") {
      const obj = objects.get(key);
      if (!obj) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Length", String(obj.body.length));
      res.setHeader("Content-Type", obj.contentType);
      res.setHeader("ETag", obj.etag);
      res.setHeader("Last-Modified", obj.lastModified.toUTCString());
      res.end();
      return;
    }

    // GET (supports Range)
    if (req.method === "GET") {
      const obj = objects.get(key);
      if (!obj) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/xml");
        res.end("<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>");
        return;
      }
      const rangeHeader = req.headers.range;
      if (rangeHeader && rangeHeader.startsWith("bytes=")) {
        const [startStr, endStr] = rangeHeader.slice("bytes=".length).split("-");
        const start = Number(startStr);
        const end = endStr ? Math.min(Number(endStr), obj.body.length - 1) : obj.body.length - 1;
        const slice = obj.body.subarray(start, end + 1);
        res.statusCode = 206;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Range", `bytes ${start}-${end}/${obj.body.length}`);
        res.setHeader("Content-Length", String(slice.length));
        res.setHeader("Content-Type", obj.contentType);
        res.setHeader("ETag", obj.etag);
        res.end(slice);
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(obj.body.length));
      res.setHeader("Content-Type", obj.contentType);
      res.setHeader("ETag", obj.etag);
      res.end(obj.body);
      return;
    }

    // DELETE
    if (req.method === "DELETE") {
      objects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 405;
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${addr.port}`,
    bucket,
    accessKeyId,
    secretAccessKey,
    objects,
    setOffline(value: boolean) {
      offline = value;
    },
    setFailNextPut(count: number) {
      failNextPutCount = count;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

export interface TestWebDavServer {
  endpoint: string;
  username: string;
  password: string;
  files: Map<string, { body: Buffer; contentType: string; lastModified: Date }>;
  dirs: Set<string>;
  setOffline(offline: boolean): void;
  setDisableHead(disable: boolean): void;
  setCrossOriginRedirect(targetUrl: string | null): void;
  close(): Promise<void>;
}

export async function startTestWebDavServer(options?: {
  username?: string;
  password?: string;
}): Promise<TestWebDavServer> {
  const username = options?.username ?? "davuser";
  const password = options?.password ?? "davpass";
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

  const files = new Map<string, { body: Buffer; contentType: string; lastModified: Date }>();
  const dirs = new Set<string>(["/", "/dav"]);
  let offline = false;
  let disableHead = false;
  let crossOriginRedirect: string | null = null;

  function normalizePath(pathname: string): string {
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
    return `/${segments.join("/")}`;
  }

  function parentOf(p: string): string {
    const idx = p.lastIndexOf("/");
    if (idx <= 0) return "/";
    return p.slice(0, idx);
  }

  const server = http.createServer(async (req, res) => {
    if (offline) {
      res.statusCode = 503;
      res.end("WebDAV offline");
      return;
    }

    if (crossOriginRedirect) {
      res.statusCode = 302;
      res.setHeader("Location", crossOriginRedirect);
      res.end();
      return;
    }

    if (req.headers.authorization !== expectedAuth) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="AssetNestWebDAV"');
      res.end("Unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const normPath = normalizePath(url.pathname);

    if (req.method === "MKCOL") {
      if (dirs.has(normPath)) {
        res.statusCode = 405;
        res.end("Already exists");
        return;
      }
      const parent = parentOf(normPath);
      if (!dirs.has(parent)) {
        res.statusCode = 409;
        res.end("Parent missing");
        return;
      }
      dirs.add(normPath);
      res.statusCode = 201;
      res.end();
      return;
    }

    if (req.method === "PUT") {
      const parent = parentOf(normPath);
      if (!dirs.has(parent)) {
        res.statusCode = 409;
        res.end("Parent missing");
        return;
      }
      const body = await readRequestBody(req);
      files.set(normPath, {
        body,
        contentType: String(req.headers["content-type"] || "application/octet-stream"),
        lastModified: new Date()
      });
      res.statusCode = 201;
      res.end();
      return;
    }

    if (req.method === "HEAD") {
      if (disableHead) {
        res.statusCode = 405;
        res.end();
        return;
      }
      const file = files.get(normPath);
      if (!file) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Length", String(file.body.length));
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Last-Modified", file.lastModified.toUTCString());
      res.end();
      return;
    }

    if (req.method === "PROPFIND") {
      await readRequestBody(req);
      const file = files.get(normPath);
      if (!file) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 207;
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.end(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${url.pathname}</D:href><D:propstat><D:prop>` +
          `<D:getcontentlength>${file.body.length}</D:getcontentlength>` +
          `<D:getcontenttype>${file.contentType}</D:getcontenttype>` +
          `<D:getlastmodified>${file.lastModified.toUTCString()}</D:getlastmodified>` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
      );
      return;
    }

    if (req.method === "GET") {
      const file = files.get(normPath);
      if (!file) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Length", String(file.body.length));
      res.setHeader("Content-Type", file.contentType);
      res.end(file.body);
      return;
    }

    if (req.method === "DELETE") {
      if (!files.has(normPath)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      files.delete(normPath);
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 405;
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${addr.port}/dav`,
    username,
    password,
    files,
    dirs,
    setOffline(value: boolean) {
      offline = value;
    },
    setDisableHead(value: boolean) {
      disableHead = value;
    },
    setCrossOriginRedirect(targetUrl: string | null) {
      crossOriginRedirect = targetUrl;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}
