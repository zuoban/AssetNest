# AssetNest 系统架构与技术设计

> 文档版本：v1.0  
> 基线需求：`docs/PRD.md`（P0 范围，M0–M4）

## 1. PRD 冲突分析与关键技术风险

在编码前对 `docs/PRD.md` 进行完整性与边界核对，识别出 8 项核心冲突点或高风险区域及既定解决策略：

| # | 风险 / 需求张力 | 影响范围 | 架构解决方案 |
|---|---|---|---|
| 1 | **配置文件（`config.yaml`）与 SQLite 默认存储的权威边界** | 存储管理 / 启动检查 | `config.yaml` 是连接参数唯一来源；首次初始化读取配置默认存储，此后 SQLite `settings.default_storage_id` 为唯一默认权威。若配置文件移除仍有文件引用的 Provider，启动时**不删除** DB 记录，而是将其运行态标为 `missing_config`（只读离线），禁止静默回退写入其他存储。 |
| 2 | **同存储去重 `UNIQUE(storage_id, sha256)` 与跨存储迁移冲突** | 存储迁移（M2） | 迁移单文件时若目标存储已存在同 `sha256` 的 `ready` 物理记录 `B`，短事务内将所有 `asset_versions.file_id` 从 `A` 重指到 `B`（保持 `asset_version_id` 与 `release_id` 不变），旧物理对象登记到 `storage_cleanup_queue`（默认 `awaiting_confirmation`），避免触发唯一约束冲突或误删回滚副本。 |
| 3 | **循环外键与版本不可变性** | 素材版本 / 母图 / Release | `assets.current_version_id` 允许插入瞬间为 `NULL`，事务内写入 `v1` 后立即更新指针，并用 SQLite `BEFORE UPDATE` 触发器校验指针必须归属同一 `asset_id`。`releases` 与 `release_assets` 通过 SQLite 触发器禁止 `UPDATE/DELETE`（仅恢复模式重建库）。 |
| 4 | **软删除保护 vs 物理垃圾回收（GC）** | 回收站 / 存储清理 | 用户删除仅置 `deleted_at`。物理清理仅由 `gc` 任务执行，必须同时校验：非过期软删除版本、未解锁母图、`asset_set_items`、`release_assets`、进行中的任务（含迁移/备份/导出）均无引用，且超过保留期。先置 `pending_delete`，远程删除成功后再提交 DB，失败保留 `delete_failed` 供重试。 |
| 5 | **全量备份与维护模式恢复下的 SQLite WAL 锁冲突** | 备份与恢复（M2/M4） | 备份采用 SQLite `VACUUM INTO` 生成事务一致快照，不直接拷贝 WAL/SHM 文件；备份任务活跃期间锁定 GC。恢复时进入全局 `maintenanceMode`（拦截写 API 返回 `503`、暂停 Worker 并等待在途任务结束），在临时目录完成校验与文件落盘后，关闭 DB 连接、原子替换数据库文件并重新打开；任一步骤失败回滚至 `.pre-restore` 且不破坏现网数据。 |
| 6 | **中文/泰文/英文子串检索与 5 万素材性能目标** | 搜索系统（M1/M4） | FTS5 `unicode61` 无法切分中文与泰文，而 `trigram` 分词器原生支持 CJK/泰文 >=3 字符子串，但对 1–2 字符查询无召回。方案：维护可重建的 `search_documents` + `search_fts(tokenize='trigram')`，对 >=3 字符词条走 FTS5，对 1–2 字符或 FTS 无结果时自动回退至带索引过滤条件的 `instr(lower(search_text), lower(?))`。 |
| 7 | **不可信文件安全（SVG/HTML/图片炸弹/路径穿越/SSRF）** | 上传 / 预览 / 导出 / WebDAV | 禁止同源直接执行 SVG/HTML/脚本（响应头强制 `Content-Security-Policy: default-src 'none'; sandbox` + `X-Content-Type-Options: nosniff`，原文件下载用 `Content-Disposition: attachment`）；Sharp 强制 `limitInputPixels`；流式上传限制单文件大小与临时磁盘配额；WebDAV 适配器限定 `http/https` 且禁用跨源自动重定向。 |
| 8 | **WebDAV / S3 能力差异** | 存储适配器（M2） | 适配器显式暴露 `capabilities`（`rangeRead` / `presignedUrl` / `multipartUpload`）。Local/S3 支持 Range；WebDAV 默认降级为全量流式读取/下载，不强行假设服务支持 Range 或原子重命名，并以真实 S3/WebDAV 服务做集成测试。 |

## 2. 极简技术栈选型与论证

在 `docs/PRD.md` 允许“等效简化、优先评估运行时内置能力、不强制 ORM”的原则下，采用**单进程单体 TypeScript 架构（Fastify 5 + React 19 SPA + Node 22 内置 `node:sqlite`）**，放弃 Next.js App Router 的核心原因：

1. AssetNest 是 100% 需登录访问的桌面级工作台，无 SEO/SSR 需求；
2. 1 GiB 流式分片上传、视频 `Range` 流式代理、大文件流式 ZIP 打包在原生 Fastify/Node Stream 上天然零额外缓冲；
3. 内置 Worker 优雅停机与恢复时的**维护模式 DB 关闭/热切换**需要完全掌控 HTTP Server 与数据库句柄生命周期；
4. 依赖总量比 Next.js 方案减少一个数量级，Docker 多架构构建更快更稳。

| 层级 | 选型 | 理由与约束 |
|---|---|---|
| 运行时 | **Node.js 22 LTS**（ESM + TypeScript 5） | 内置 `node:sqlite`（SQLite 3.51+，含 WAL / FTS5 trigram / `VACUUM INTO`）、`node:crypto`（`scrypt` / SHA-256 / UUID）、`fetch`、Stream。零原生 SQLite 编译依赖，天然适配 `amd64`/`arm64`。 |
| 后端服务 | **Fastify 5** + `@fastify/cookie` + `@fastify/multipart` + `@fastify/static` + `@fastify/rate-limit` | 原生 busboy 磁盘流式上传、Pino 结构化日志（支持凭证脱敏）、低开销、统一 `onClose` 清理 Worker 与 DB。 |
| 参数校验 | **Zod** | 配置文件、API 入参、导出模板规则、PDP JSON、Manifest 统一运行时校验与类型推导。 |
| 配置解析 | **yaml** | 解析 `/config/config.yaml`，支持 `${ENV_VAR}` 安全展开且禁止将敏感值写入日志或数据库。 |
| 数据库 | **`node:sqlite`（`DatabaseSync`）** + 版本化 SQL 迁移 | 无 ORM 黑盒，显式 `BEGIN IMMEDIATE` 短事务、完整外键与触发器保护。 |
| 媒体与压缩 | **Sharp**（缩略图/元数据，限制最大像素）、**yazl** / **yauzl**（流式 ZIP 导出与安全解压校验） | 均为成熟轻量库；视频播放由浏览器原生态解码 + Range 代理，不强制引入 FFmpeg。 |
| 存储适配 | Local（`node:fs`）、S3（`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`）、WebDAV（基于 Node 原生 `fetch` 的精简流式实现） | 最小依赖集，全部隔离在 `StorageProvider` 接口之后。 |
| 前端 UI | **React 19 + Vite 6 + Tailwind CSS v4 + React Router v7 + Lucide React** | 打包为静态产物 `dist/web/` 由 Fastify 单端口托管；辅以 `@tanstack/react-virtual`（5 万素材虚拟滚动）和 `@dnd-kit/core` + `@dnd-kit/sortable`（轮播图拖拽排序）。 |
| 测试框架 | **Vitest**（单元/集成/API/真实存储测试）+ **Playwright**（开发依赖 E2E） | 仅存在于 `devDependencies`，不进入生产镜像。 |

## 3. 系统总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                    Browser (Desktop Web UI)                  │
│   React 19 SPA · Virtual Grid · Lightbox · DnD · Polling     │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP / HTTPS (Cookie + CSRF)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│            AssetNest Single Container (Node.js 22)           │
│                                                              │
│  ┌───────────────────────┐   ┌────────────────────────────┐  │
│  │ Fastify HTTP Layer    │   │ Static SPA (/dist/web)     │  │
│  │ Auth · CSRF · RateLim │   │ Range / Attachment Proxy   │  │
│  └───────────┬───────────┘   └────────────────────────────┘  │
│              ▼                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Domain Modules                                         │  │
│  │ Setup/Auth · Products/SKU · Assets/Tags/Folders        │  │
│  │ Master/Review · Stores/Listings · AssetSets · PDP      │  │
│  │ Templates/Release/Export · Trash/GC · Backup/Restore   │  │
│  └───────────┬──────────────────────────┬─────────────────┘  │
│              ▼                          ▼                    │
│  ┌───────────────────────┐   ┌────────────────────────────┐  │
│  │ SQLite Repository     │   │ In-Process Worker (cap=2)  │  │
│  │ WAL · FTS5 · Jobs     │◄──┤ Lease · Heartbeat · Retry  │  │
│  └───────────┬───────────┘   └─────────────┬──────────────┘  │
│              │                             ▼                 │
│              │               ┌────────────────────────────┐  │
│              │               │ StorageRegistry & Adapters │  │
│              │               │  Local  │  S3  │  WebDAV   │  │
│              │               └─────────────┬──────────────┘  │
└──────────────┼─────────────────────────────┼─────────────────┘
               ▼                             ▼
   /data/db/assetnest.db        /data/assets | S3 Bucket | NAS
   /data/cache /imports /exports /backups
```

## 4. 运行时、任务队列与优雅生命周期

### 4.1 持久化目录布局（容器内）

- `/config/config.yaml`（只读挂载）：非敏感应用/存储连接配置，密钥仅通过 `${ENV_VAR}` 引用。
- `/data/db/assetnest.db`：唯一 SQLite 主库（附带 `-wal`、`-shm`），严格位于本地持久化卷。
- `/data/assets`：默认 Local 存储根目录，内容寻址布局 `originals/<sha256[0..2]>/<sha256>`。
- `/data/cache`：可随时重建的缩略图缓存（支持容量上限与 LRU 淘汰，绝不触碰原文件）。
- `/data/imports`：流式上传与恢复时的有界暂存目录（启动时扫描清理过期孤儿临时文件）。
- `/data/exports`：已生成的 Release ZIP 文件目录（带过期时间，可清理并随时重建）。
- `/data/backups`：持久化备份包存储目录。

### 4.2 内置持久化任务队列（Worker）

- 任务持久化在 SQLite `jobs` 表，支持类型：`thumbnail`、`search_reindex`、`export_zip`、`storage_migrate`、`storage_cleanup`、`gc`、`backup`、`restore`。
- **租约与恢复**：Worker 每次通过短事务 `BEGIN IMMEDIATE` 认领 `status = 'queued'`（或 `status = 'running' AND lease_until < now()`）的任务，设置 `lease_until = now + 60s`，每 20s 续约心跳。容器崩溃重启后，过期租约自动回收重试。
- **受限并发**：默认并发 `worker.concurrency = 2`（可配置 1–4）。文件级互斥（同一 `file_id` 不得并发执行迁移与清理）通过 `job_locks(resource_key PRIMARY KEY)` 或事务状态检查保障。
- **短事务纪律**：下载远程对象、Sharp 缩略图生成、ZIP 打包、SHA-256 校验全部在数据库事务**之外**流式执行，仅在阶段切换与状态提交时执行毫秒级 SQLite 事务。
- **协作取消**：取消请求将任务标记 `cancel_requested = 1`，Worker 在每个文件/分块边界检查并安全退出，清理自身临时文件。

### 4.3 维护模式与优雅停机

- **优雅停机（`SIGINT`/`SIGTERM`）**：停止接收新 HTTP 请求 → 停止 Worker 认领新任务并等待在途任务优雅完成（上限 15s）→ 执行 `PRAGMA wal_checkpoint(PASSIVE)` → 关闭 SQLite 连接 → 退出进程。
- **维护模式（恢复备份期间）**：内存状态 `appState.maintenance = true`，所有非健康检查/恢复状态请求返回 `503`；Worker 暂停并排空后执行原子数据库替换。

## 5. 安全设计

- **身份认证**：首版单管理员账号；密码采用 `crypto.scrypt`（随机 16 字节盐 + 固定参数 `N=16384, r=8, p=1` + `timingSafeEqual`）；会话 Token 为 32 字节密码学随机数，仅在 SQLite `sessions` 中存储其 `SHA-256` 哈希，浏览器通过 `HttpOnly; SameSite=Lax; Path=/`（HTTPS 下启用 `Secure`）Cookie 持有。
- **初始化保护与宿主机恢复**：`users` 表非空时，`/api/setup/init` 永久返回 `409 Conflict`。管理员遗忘密码通过宿主机执行 CLI 命令：`node dist/server/cli.js reset-admin --username admin --password-stdin` 完成受控重置并吊销全部旧会话。
- **全路由服务端鉴权**：除 `/healthz`、`/api/setup/status`、`/api/setup/init`（仅未初始化时）、`/api/auth/login` 与前端静态外壳外，全部 `/api/*` 均经过 Fastify `onRequest` 鉴权钩子校验有效会话。
- **CSRF 与限流**：所有非 `GET/HEAD/OPTIONS` API 请求校验 `Origin` / `Referer` 与当前站点同源，同时要求自定义请求头 `X-AssetNest-Request: 1`；登录接口按 IP 实施滑动窗口限流（默认 10 次 / 15 分钟）。
- **文件与媒体安全**：魔数检测真实文件类型；规范化文件名与 ZIP 条目路径，拒绝 `..`、绝对路径、控制字符与符号链接；原图下载统一 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`；SVG/HTML 不在主站同源内联渲染。
- **审计日志脱敏**：`activity_events` 与 Pino 日志均对 `password`、`secretAccessKey`、`token`、`cookie`、`authorization`、`signedUrl` 等字段强制脱敏。

## 6. 备份与恢复机制

- **元数据备份（`metadata`）**：`VACUUM INTO` 一致性 SQLite 快照 + `manifest.json`（含 schema 版本、所有 `files` 清单与 SHA-256、Provider ID 列表，不含密钥）。
- **完整备份（`full`）**：元数据备份 + 打包全部有效引用的物理原文件（通过 `StorageProvider.get()` 流式读取写入 tar/zip，跳过缓存与过期导出包）。备份执行期间向 GC 注册快照保护锁。
- **恢复流程**：上传或指定宿主机备份包 → 进入维护模式 → 临时目录解包与完整校验（manifest 版本、SQLite `PRAGMA integrity_check`、Schema 兼容性、逐文件 SHA-256、目标存储写入权限）→ 流式写入目标存储（已存在同哈希对象校验复用）→ 关闭现网 DB → 备份旧库至 `.pre-restore` → 原子切入新库并重新打开 → 映射存储 Provider → 入队重建缩略图与 FTS5 索引 → 退出维护模式。任一校验失败直接中止，现网零受损。

## 7. 部署架构

- **单 Docker 容器**：多阶段构建（`node:22-bookworm-slim`），构建阶段编译 TypeScript 服务端与 Vite 前端，运行阶段仅保留生产依赖与产物，以非 root 用户 `assetnest`（UID 1000）运行。
- **单实例约束**：应用启动时在 `/data/db/.instance.lock` 获取独占锁，防止误配置多副本共享同一 SQLite 写入卷造成数据库损坏。
- **健康检查**：`GET /healthz` 返回轻量状态（仅暴露 `status: "ok" | "maintenance"`、`initialized`、`dbReady`、`version`，不泄露任何内部路径、配置或业务数据）。
