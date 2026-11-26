# AssetNest 可插拔存储系统设计

## 1. 统一接口契约（`StorageProvider`）

所有业务层（上传、下载、缩略图生成、迁移、导出 ZIP、备份/恢复、GC）仅通过 `StorageRegistry` 获取 `StorageProvider` 实例，禁止绕过接口直接调用 `fs`、AWS SDK 或 WebDAV HTTP。

```ts
import type { Readable } from "node:stream";

export type StorageProviderType = "local" | "s3" | "webdav";

export interface StorageCapabilities {
  rangeRead: boolean;       // 是否支持 HTTP Range 分段读取（视频拖拽）
  presignedUrl: boolean;    // 是否支持短时签名下载链接（可选）
  multipartUpload: boolean; // 是否支持大文件分片流式上传
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

export interface ConnectionResult {
  ok: boolean;
  latencyMs: number;
  code?:
    | "OK"
    | "AUTH_FAILED"
    | "PERMISSION_DENIED"
    | "NOT_FOUND"
    | "TIMEOUT"
    | "NETWORK_ERROR"
    | "INTEGRITY_MISMATCH"
    | "INVALID_CONFIG";
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
```

> **Stream 边界说明**：Node.js 服务端统一使用 `node:stream` `Readable`（与 Fastify 回复流、Sharp、`yazl`、`fs.createReadStream`、`@aws-sdk/lib-storage` 零转换对接）。WebDAV `fetch` 响应体通过 `Readable.fromWeb()` 转换。

## 2. 对象键规范与安全边界

- **原文件不可变内容寻址路径**：
  ```text
  originals/<sha256[0..2]>/<sha256>
  ```
- **连通性测试临时对象路径**：
  ```text
  _assetnest_probe/<uuid>.tmp
  ```
- **键校验规则**（所有适配器入口共享 `assertSafeObjectKey(key)`）：
  - 必须为相对路径，禁止以 `/` 或 `\` 开头；
  - 禁止包含 `..`、`.` 路径段、`\0` 或控制字符；
  - 仅允许 `[a-zA-Z0-9._/-]`；
  - 禁止操作非 `originals/` 与 `_assetnest_probe/` 命名空间（防止误删用户 bucket/NAS 中的其他文件）。

## 3. 三类适配器实现规范

### 3.1 Local 适配器（`src/server/storage/local.ts`）

- `capabilities`: `{ rangeRead: true, presignedUrl: false, multipartUpload: false }`
- **写入原子性**：先流式写入 `<root>/.tmp/<uuid>.part` → `fsync` → 原子 `rename` 到最终 `<root>/<object_key>`；若目标已存在且字节数匹配，删除临时文件并幂等返回成功。
- **路径与符号链接防御**：对解析后的绝对路径执行 `path.resolve` 前缀校验，并通过 `fs.realpath` 校验父目录未通过 symlink 逃逸出 `root`。
- **Range 读取**：通过 `fs.createReadStream(fullPath, { start, end })` 实现精确字节区间流式返回。

### 3.2 S3 Compatible 适配器（`src/server/storage/s3.ts`）

- `capabilities`: `{ rangeRead: true, presignedUrl: true, multipartUpload: true }`
- 使用 `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`（`Upload` 自动对大文件进行流式分片上传，内存恒定，不缓存整个 1 GiB 文件）。
- 支持自定义 `endpoint`、`region`、`bucket`、`prefix`、`forcePathStyle`、`accessKeyId`、`secretAccessKey`、可选 `sessionToken`。
- 规范化 `prefix`（去除多余前导斜杠，确保末尾 `/`）；所有对象默认私有，不设置 public ACL。
- 映射 AWS 错误码（`InvalidAccessKeyId`/`SignatureDoesNotMatch` → `AUTH_FAILED`，`AccessDenied` → `PERMISSION_DENIED`，`NoSuchBucket`/`NotFound` → `NOT_FOUND`，超时 → `TIMEOUT`）。

### 3.3 WebDAV 适配器（`src/server/storage/webdav.ts`）

- `capabilities`: `{ rangeRead: false, presignedUrl: false, multipartUpload: false }`（默认保守关闭 Range，避免不同 NAS 服务端实现差异导致视频拖动损坏；下载与播放自动降级为完整流式传输）。
- 基于 Node 22 原生 `fetch` 实现，零额外三方依赖：
  - 严格限定 `http:` / `https:` 协议；
  - 禁用跨源自动重定向（`redirect: "manual"`，仅允许同源目录尾部斜杠规范化，防 SSRF）；
  - 逐段 `encodeURIComponent` 拼接路径；
  - `put` 前按需递归执行 `MKCOL` 创建父目录（忽略 `405 Method Not Allowed` / `301` 表示已存在）；
  - `stat` 优先 `HEAD`，不可用时回退 `PROPFIND Depth: 0` 解析 `getcontentlength`；
  - `delete` 对 `404` 视为幂等成功。

### 3.4 连通性测试协议（`testConnection`）

所有适配器采用统一四步探针：
1. 生成 64 字节随机载荷并计算 SHA-256；
2. `put("_assetnest_probe/<uuid>.tmp", ...)`；
3. `get(...)` 流式读回并校验 SHA-256 完全一致；
4. `finally` 中 `delete("_assetnest_probe/<uuid>.tmp")` 确保不残留临时垃圾（删除失败亦记录明确错误）。

## 4. 上传、去重与一致性顺序

```text
1. HTTP multipart 流式写入 /data/imports/<upload_id>.part
   同时计算 SHA-256、字节数、嗅探魔数 MIME；超限立即中断并删除暂存文件
2. 查询目标 storage_id 的 (storage_id, sha256) 是否已有 state = 'ready' 的 files 记录
   ├─ 若存在：跳过对象上传，复用该 file_id
   └─ 若不存在：
       a) 短事务插入 files(state = 'staging')（若唯一冲突则重新查询复用）
       b) 通过 StorageProvider.put() 流式写入 originals/<sha256[0..2]>/<sha256>
       c) StorageProvider.stat() 校验字节数与目标一致
       d) 短事务更新 files.state = 'ready'
3. 短事务创建 assets + asset_versions(v1) + product_assets / tags + 更新 assets.current_version_id
4. 清理暂存文件，入队异步 thumbnail 与 search_reindex 任务
```

## 5. 跨存储迁移状态机

1. **预览（Dry-run）**：根据所选来源/目标与筛选范围，去重汇总物理 `files` 列表、总字节数，并列出所有受共享引用影响的 `assets`/`products`。
2. **建任务**：校验目标 Provider 已启用且 `testConnection()` 通过；创建 `storage_migrate` 任务和 `storage_migration_items` 明细。
3. **逐文件迁移（可中断恢复、幂等重试）**：
   - 对 `file_id` 获取 `job_locks("file:<file_id>")`，与 GC/清理互斥；
   - 检查目标是否已存在同 `sha256` 对象：
     - 若不存在：从源 `provider.get()` 流式管道到暂存或直接流式写入目标 `provider.put()`，随后从目标读回或流式校验 `sha256` + `size_bytes`；
     - 若目标已存在：流式读取目标校验 `sha256` + `size_bytes` 无误；
   - **短事务切换**：
     - 若 SQLite 中 `(target_storage_id, sha256)` 已有物理记录 `B`：**合并路径**——重指所有 `asset_versions.file_id`（以及 `release_assets.file_id` 若同表关联，注意遵循不变量：`release_assets` 仅引用 `asset_version_id` 或在允许物理位置迁移时不改动 Release 语义，具体在 M2/M4 设计中 `release_assets` 通过 `asset_version_id -> asset_versions.file_id` 定位物理文件，避免修改不可变 `release_assets` 表！），原对象登记入 `storage_cleanup_queue(status='awaiting_confirmation')`；
     - 若无冲突：**移动路径**——更新 `files.storage_id = target_storage_id`，原 `(source_storage_id, object_key)` 登记入 `storage_cleanup_queue(status='awaiting_confirmation')`。
4. **来源对象清理**：迁移完成后默认保留来源对象，用户核对无误后在存储管理页手动点击确认，触发 `storage_cleanup` 任务安全删除来源物理对象。

> **关键修正（与 `docs/SCHEMA.md` 对齐）**：为了确保 `release_assets` 绝对不可变且存储迁移无需修改 `release_assets`，Release 下载重导出时通过 `release_assets.asset_version_id -> asset_versions.file_id -> files` 解析当前物理存储位置，同时校验 `files.sha256 === release_assets.sha256`，既保证物理迁移完全透明，又保证 Release 快照与内容哈希不可篡改。
