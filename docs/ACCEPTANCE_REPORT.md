# AssetNest v1.0（M0–M4）验收报告

> 验收日期：2026-11-26
> 版本：`0.1.0`（M0–M4 全量交付）
> 基线提交：`98136ed`（M0）→ `76d6165`（M1）→ `1fc5e4c`（M2）→ `7b7aad7`（M3）→ 当前工作区（M4）

---

## 1. 架构原则核验

| 原则 | 实际情况 | 结论 |
|---|---|---|
| SQLite 单体架构 | 使用 Node.js 22 原生 `node:sqlite`（WAL + `foreign_keys = ON` + FTS5 trigram），无 PostgreSQL/Redis/Elasticsearch | 通过 |
| 可插拔资源存储 | `StorageProvider` 统一接口支持 Local、S3 兼容（AWS SDK v3）、WebDAV（HTTP/PROPFIND/MKCOL/PUT/GET/DELETE） | 通过 |
| 单 Docker 容器部署 | `Dockerfile` 多阶段构建单镜像 `assetnest:0.1.0`（96.8 MB），非 root `node` 运行，内置 `/healthz` 探针 | 通过 |
| 无 Mock / 无占位 | 全部前后端功能均落地真实数据库事务、文件存储、流式 ZIP 导出与真实本地/HTTP S3/WebDAV 协议测试 | 通过 |
| 类型安全与数据完整性 | 前后端严格 TypeScript、SQL 迁移版本管理（`0001`–`0006`）、不可变 Release 触发器、SHA-256 端到端校验 | 通过 |

---

## 2. 构建与自动化测试汇总

执行命令：

```bash
pnpm typecheck && pnpm build && pnpm test
```

执行结果：**12 个测试文件、28 项测试全部通过（0 失败，耗时 14.75s）**。

| 测试文件 | 用例数 | 覆盖范围 | 结果 |
|---|---:|---|---|
| `tests/unit/config.test.ts` | 4 | YAML 配置解析、环境变量引用替换、非法路径与缺省降级 | PASS |
| `tests/unit/migrator.test.ts` | 1 | SQL 迁移顺序执行、幂等性与最新版本校验 | PASS |
| `tests/unit/password.test.ts` | 2 | scrypt 独立盐值哈希、校验与审计脱敏 | PASS |
| `tests/unit/media.test.ts` | 2 | 图片解码尺寸探测、缩略图生成与像素超限保护 | PASS |
| `tests/unit/storage-local.test.ts` | 2 | Local 原子写入、`stat`、Range 读取、删除与 4 步连通性检测 | PASS |
| `tests/unit/storage-s3-webdav.test.ts` | 2 | 真实 HTTP S3 兼容服务与 WebDAV 协议流式读写、Range、探活与错误分类 | PASS |
| `tests/unit/job-worker.test.ts` | 1 | 持久化任务队列并发上限、指数退避重试、取消与租约过期恢复 | PASS |
| `tests/integration/m0-api.test.ts` | 2 | `/healthz`、首次初始化锁、鉴权、CSRF、重启持久化、CLI 重置管理员、登录限速 | PASS |
| `tests/integration/m1-api.test.ts` | 3 | 商品/SKU 唯一性、内容寻址去重、独立软删除、Range 206、SVG/HTML 沙箱头、损坏缩略图自愈 | PASS |
| `tests/integration/m2-api.test.ts` | 3 | 三类存储探活脱敏、默认存储切换、删除保护、Local↔S3↔WebDAV 迁移链与二次清理、断网降级、GC、备份 | PASS |
| `tests/integration/m3-api.test.ts` | 2 | 多角度母图锁定与版本历史、独立版本审核、解锁审计原因、3 店铺独立 Listing/SKU 子集/轮播排序/中英泰 PDP 版本 | PASS |
| `tests/integration/m4-api.test.ts` | 4 | 版本化模板、阻断/告警校验、草稿包与正式 Release（9+3+1+PDP）、不可变触发器、历史重导出与开放标准包、GC 保护与过期导出清理、跨实例完整备份恢复与恶意 ZIP 拦截、M4 权限/CSRF/413/断网/缓存重建 | PASS |

---

## 3. 首版验收清单（AC-01 至 AC-15）逐项结果

| ID | 验收场景 | 核心实现位置 | 验证方式与实际结果 | 状态 |
|---|---|---|---|---|
| AC-01 | 新实例部署 | `Dockerfile`, `compose.yaml`, `src/server/db/migrator.ts` | 单容器 `assetnest:0.1.0` 空卷启动，`/healthz` 返回健康，`/api/v1/setup/init` 完成初始化，自动执行全部 6 个迁移，无外部数据库/缓存服务 | **PASS** |
| AC-02 | 商品多渠道管理 | `src/server/modules/products/`, `src/server/modules/listings/` | `m3-api.test.ts` 实测 1 SPU、3 SKU、3 店铺 Listing（Shopee TH / TikTok TH / Shopee MY）独立维护素材、SKU 子集与 PDP | **PASS** |
| AC-03 | 素材导入与去重 | `src/server/modules/assets/service.ts` | `m1-api.test.ts` 实测同存储重复上传仅落盘一份物理对象，多业务引用互不干扰，批量操作事务一致 | **PASS** |
| AC-04 | 搜索与预览 | `src/server/modules/search/service.ts`, `src/server/modules/assets/routes.ts` | `m1-api.test.ts` + `benchmark-m4.ts` 实测中/英/泰及 2 字符短词搜索、组合过滤、Range 206、SVG/HTML `Content-Security-Policy` 沙箱、PSD/ZIP 回退下载与损坏缩略图重建 | **PASS** |
| AC-05 | 母图与版本 | `src/server/modules/assets/master.ts` | `m3-api.test.ts` 实测锁定 V1 不可变、上传 V2 保留 V1 历史、版本级独立审核状态与强制填写解锁原因 | **PASS** |
| AC-06 | 轮播/SKU/PDP | `src/server/modules/listings/service.ts`, `src/web/pages/ListingWorkbenchPage.tsx` | `m3-api.test.ts` 实测 9 图轮播拖拽重排持久化、SKU 绑定隔离、EN/TH 多语言 PDP 不可变版本历史与一键恢复 | **PASS** |
| AC-07 | 正式上架包 | `src/server/modules/releases/` (`templates.ts`, `validator.ts`, `service.ts`, `exporter.ts`) | `m4-api.test.ts` 实测版本化模板、阻断项拦截正式发布、显式允许草稿包（含 `DRAFT_NOTICE.txt`）、正式 Release 导出验证 9+3+1+TH/EN PDP ZIP 与 `manifest.json`、数据库触发器防篡改、`restore-draft` 与开放标准包导出 | **PASS** |
| AC-08 | 三类存储 | `src/server/storage/` (`local.ts`, `s3.ts`, `webdav.ts`) | `storage-local.test.ts`, `storage-s3-webdav.test.ts`, `m2-api.test.ts` 实测 Local、真实 HTTP S3、真实 HTTP WebDAV 的上传、读取、Range 下载、4 步连通性检测（零密钥泄漏）与引用删除保护 | **PASS** |
| AC-09 | 默认切换 | `src/server/modules/storage/service.ts` | `m2-api.test.ts` 实测切换默认存储后新上传落入新存储，旧文件继续按 `files.storage_id` 从原存储读取 | **PASS** |
| AC-10 | 安全迁移 | `src/server/modules/migrations/service.ts`, `src/server/modules/jobs/worker.ts` | `m2-api.test.ts` 实测 Local→S3→WebDAV→Local 完整迁移链、SHA-256 校验、共享文件 Dry-Run、二次确认清理、失败/中断重试与去重合并 | **PASS** |
| AC-11 | 软删除保护 | `src/server/modules/trash/gc.ts` | `m1/m2/m3/m4-api.test.ts` 实测被草稿或不可变 Release 引用的回收站素材不被 GC 物理删除；过期导出 ZIP 清理后返回 `409` 且不破坏历史 Release 重导出 | **PASS** |
| AC-12 | 备份恢复 | `src/server/modules/backups/service.ts`, `src/server/modules/backups/restore.ts` | `m2/m4-api.test.ts` 实测 Local+S3 完整备份在全新干净实例上进入维护模式校验恢复、重建 FTS 并重导出历史 Release；篡改 DB、篡改文件哈希、ZIP-Slip（`../evil.txt`）及 POSIX 符号链接均被拒绝且零覆盖现有数据 | **PASS** |
| AC-13 | 权限安全 | `src/server/http/security.ts`, `src/server/modules/auth/` | `m0/m1/m4-api.test.ts` 实测未登录访问素材/设置/模板/Release/恢复全部返回 `401`，缺少 `x-assetnest-request: 1` 的写请求返回 `403`，登录限速、路径穿越与 ZIP-Slip 均被阻断 | **PASS** |
| AC-14 | 故障与资源限制 | `src/server/modules/releases/exporter.ts`, `src/server/modules/assets/routes.ts` | `m2/m4-api.test.ts` 实测单文件超限返回 `413`、S3 离线时校验给出阻断提示且导出任务优雅失败（无 `.tmp` 残留，无流挂死）、恢复在线后可重导出成功、清空缓存后按需重建缩略图 | **PASS** |
| AC-15 | 性能与部署 | `scripts/benchmark-m4.ts`, `src/server/db/migrations/0006_m4_perf_indexes.sql`, `Dockerfile` | 完成 1,000 商品 / 5,000 SKU / 50,000 素材基准压测，全部 8 项查询 Warm P95 ≤ 188.95 ms（优于 ≤ 500 ms 目标）；单容器构建与运行通过 | **PASS** |

---

## 4. AC-15 性能与容量基准实测（PRD 第 9.3 节）

### 测试环境与数据规模
- **宿主机**：Apple M1（8 核 ARM64）、16 GB RAM、本地 SSD、macOS
- **运行时**：Node.js `v22.22.3`、`node:sqlite`（WAL 模式）、pnpm `12.21.0`
- **数据规模**：1,000 个商品（SPU）、5,000 个 SKU、50,000 条素材记录（每商品 50 条素材，含中文/英文/泰文名称与关联 SPU/SKU 搜索文档），压测库体积 **163.3 MB**
- **压测脚本**：`pnpm tsx scripts/benchmark-m4.ts`（每项执行 1 次冷查询 + 20 次温缓存查询）

### 优化前后对比

针对首次基准中暴露的 6 项超标查询，定位并修复了三个根因：
1. 新增 `0006_m4_perf_indexes.sql` 覆盖/部分索引（`idx_assets_current_version`、`idx_assets_active_created`、`idx_assets_active_type_created`、`idx_assets_active_folder_created`、`idx_assets_active_favorite_created`、`idx_asset_versions_id_review`）。
2. 在 `src/server/modules/search/service.ts` 新增 `buildEntitySearchClause()`，将 FTS5 与 2 字符短词筛选直接下推为 SQL 子查询，消除大命中集（8k–9k 条）往返 JS 数组拼接 `IN (?, ?, ...)` 参数的开销与 `SQLITE_MAX_VARIABLE_NUMBER` 风险。
3. 重构 `listAssets()` 为两阶段查询：`COUNT(*)` 与分页 ID 查询仅按需关联必要表，最后只对当前页（≤ 60 条）ID 执行完整 5 表 JOIN 补全。

| 压测场景 | 命中条数 | 优化前 Warm P95 | 优化后 Cold | 优化后 Warm P50 | 优化后 Warm P95 | 优化后 Max | 目标（≤ 500 ms） |
|---|---:|---:|---:|---:|---:|---:|---|
| 1. 素材库首页浏览（50k，无过滤，pageSize=60） | 50,000 | 1,174.90 ms | 4.69 ms | 2.94 ms | **3.86 ms** | 4.16 ms | **PASS** |
| 2. 中文关键词搜索（`无线降噪耳机`） | 8,350 | 610.20 ms | 51.49 ms | 51.33 ms | **63.27 ms** | 87.75 ms | **PASS** |
| 3. 英文精确 SPU 搜索（`SPU-0420`） | 50 | 18.04 ms | 1.80 ms | 1.30 ms | **2.98 ms** | 3.07 ms | **PASS** |
| 4. 泰文关键词搜索（`หูฟังไร้สายตัดเสียงรบกวน`） | 8,350 | 1,220.95 ms | 66.47 ms | 66.50 ms | **79.97 ms** | 84.70 ms | **PASS** |
| 5. 2 字符短词回退搜索（`TH`） | 9,000 | 1,475.81 ms | 108.58 ms | 97.68 ms | **137.04 ms** | 160.53 ms | **PASS** |
| 6. 组合过滤（中文 + 标签 + 已通过审核 + 图片） | 1,503 | 533.58 ms | 108.39 ms | 81.75 ms | **188.95 ms** | 365.91 ms | **PASS** |
| 7. 商品筛选 + 审核状态（`productId` + `approved`） | 17 | 3,449.81 ms | 15.42 ms | 0.59 ms | **0.78 ms** | 1.44 ms | **PASS** |
| 8. 商品列表中文搜索（1,000 商品） | 167 | 74.75 ms | 76.22 ms | 18.01 ms | **58.67 ms** | 63.73 ms | **PASS** |

- **最差 Warm P95**：**188.95 ms**（达标，留有 62% 余量）
- **压测进程内存占用**：RSS `105.2 MB` / Heap Used `13.5 MB` / External `4.4 MB`

---

## 5. 单容器 Docker 与本地实机验证

### Docker 单容器实测（`linux/arm64`）
- **构建镜像**：`docker build --build-arg NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/ -t assetnest:0.1.0 .`（`NPM_REGISTRY` 为可选参数，不传默认使用官方 npmjs 源）
- **镜像体积**：`assetnest:0.1.0` 仅 **96.8 MB**（已执行 `pnpm prune --prod`，仅含生产依赖与编译产物）
- **容器实跑验证**：
  - 运行身份：`uid=1000(node) gid=1000(node)`（非 root）
  - 首次健康检查：`GET /healthz` → `{"status":"ok","initialized":false,"dbReady":true,"version":"0.1.0"}`
  - CSRF 拦截：不带 `x-assetnest-request: 1` 调用 `POST /api/v1/setup/init` → `403`
  - 首次初始化：带合法请求头初始化后，`GET /healthz` → `"initialized":true`
  - 数据库迁移：`/data/db/assetnest.db` 自动应用全部 6 个版本（`version = 6`）
  - 原生图片处理：容器内 `sharp`（`@img/sharp-libvips-linux-arm64`）实测编码 PNG 正常（`ok bytes=107`）
  - 运行内存：`docker stats` 实测 `147.9 MiB`

### 本地实例升级验证
- 已使用最新 `dist/` 重启本地实例 `http://127.0.0.1:3100`
- 现有 `data/db/assetnest.db` 启动时自动无损升级并应用 `0005_m4_templates_releases.sql` 与 `0006_m4_perf_indexes.sql`
- `GET /healthz` 与前端根路径 `/` 均返回 `200 OK`

---

## 6. 已知边界与后续建议（非阻断项）

1. **多架构镜像验证**：本次在本机 `linux/arm64` 完成了完整构建与运行冒烟；`linux/amd64` 镜像已遵循标准 `node:22-bookworm-slim` + `sharp` 预编译依赖规范，建议在发布 CI 中通过 `docker buildx --platform linux/amd64,linux/arm64` 完成双架构回归。
2. **可选视频封面提取（P1）**：当前镜像遵循最少依赖原则未预装 FFmpeg；视频支持流式 Range 播放与元信息记录，FFmpeg 视频首帧抽帧/转码按 PRD 第 11 节归入 P1。
3. **前端大包拆分（非功能性优化）**：`vite build` 产出单包 `729.88 kB`（gzip `189.44 kB`），后续可按路由懒加载做 `manualChunks` 拆分以进一步降低首屏解析体积。
