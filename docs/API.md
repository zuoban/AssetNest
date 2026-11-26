# AssetNest REST API 设计规范

## 1. 通用约定

- **基础路径**：`/api/v1`（另有顶层无鉴权健康检查 `GET /healthz`）
- **鉴权方式**：`HttpOnly; SameSite=Lax; Path=/` 会话 Cookie `assetnest_session`
- **CSRF 防护**：所有 `POST` / `PUT` / `PATCH` / `DELETE` 请求必须携带 `X-AssetNest-Request: 1` 且 `Origin`/`Referer` 同源（若提供）。
- **维护模式**：系统处于备份恢复维护模式时，除 `GET /healthz` 与恢复状态查询外，其余 API 返回 `503 Service Unavailable`。
- **统一响应结构**：
  - 成功：直接返回结构化 JSON（列表统一 `{ items: [...], total, page, pageSize }` 或 `{ items: [...], nextCursor }`）
  - 失败：
    ```json
    {
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "人类可读中文错误说明",
        "details": {}
      }
    }
    ```
- **常用错误码**：`UNAUTHORIZED` (401)、`FORBIDDEN` (403)、`NOT_FOUND` (404)、`CONFLICT` (409)、`VALIDATION_ERROR` (400)、`PAYLOAD_TOO_LARGE` (413)、`RATE_LIMITED` (429)、`STORAGE_OFFLINE` (503)、`MAINTENANCE_MODE` (503)、`INTERNAL_ERROR` (500)。

## 2. 端点规划（按里程碑分组）

### M0：健康检查、初始化、认证与系统基础

| Method & Path | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 公开 | 返回 `{ status, initialized, dbReady, version }` |
| `GET /api/v1/setup/status` | 公开 | 返回 `{ initialized, defaultStorageId, providersSummary }`（不含密钥） |
| `POST /api/v1/setup/init` | 仅未初始化时 | 创建唯一管理员、写入初始 settings，自动登录；已初始化后永久 `409` |
| `POST /api/v1/auth/login` | 公开（限速） | 校验用户名与 scrypt 密码，下发 `HttpOnly` Cookie |
| `POST /api/v1/auth/logout` | 需登录 | 吊销当前会话并清除 Cookie |
| `GET /api/v1/auth/me` | 需登录 | 返回当前管理员信息与系统摘要 |
| `GET /api/v1/dashboard` | 需登录 | 返回真实 DB 统计（商品数、素材数、待审核数、草稿 Listing 数、进行中/失败任务、最近审计活动） |
| `GET /api/v1/settings` | 需登录 | 读取通用设置（时区、默认存储 ID、回收站保留天数、导出 TTL） |
| `PATCH /api/v1/settings` | 需登录 | 更新可编辑通用设置 |
| `GET /api/v1/storage/providers` | 需登录 | 列出所有已配置存储（不含密钥），含在线/离线/配置缺失状态与默认标志 |
| `GET /api/v1/jobs` | 需登录 | 分页查看后台任务列表与状态 |
| `GET /api/v1/activities` | 需登录 | 分页查看审计日志（已脱敏） |

### M1：商品、SKU、素材导入、标签/目录、预览与检索

| Method & Path | 说明 |
|---|---|
| `GET /api/v1/products` | 分页搜索商品（支持 `q`、`status`、`category`） |
| `POST /api/v1/products` | 创建商品（含自定义规格 `specs`） |
| `GET /api/v1/products/:id` | 商品详情（含规格、SKU 列表、统计与关联素材概览） |
| `PATCH /api/v1/products/:id` | 更新商品字段、规格、外观约束、归档状态 |
| `DELETE /api/v1/products/:id` | 软删除商品（返回历史引用影响提示） |
| `POST /api/v1/products/:id/skus` | 创建 SKU（校验全空间 code 唯一及同商品规格组合唯一） |
| `PATCH /api/v1/products/:id/skus/:skuId` | 更新 SKU |
| `DELETE /api/v1/products/:id/skus/:skuId` | 删除/停用 SKU（被 Listing 引用时阻止硬删） |
| `GET /api/v1/folders` / `POST /api/v1/folders` / `PATCH /api/v1/folders/:id` / `DELETE /api/v1/folders/:id` | 逻辑目录树管理 |
| `GET /api/v1/tags` / `POST /api/v1/tags` / `PATCH /api/v1/tags/:id` / `DELETE /api/v1/tags/:id` | 多级标签管理（按维度分组） |
| `POST /api/v1/assets/upload` | 流式 `multipart/form-data` 上传（支持指定 `productId`、`folderId`、`storageId`、`purpose`、`tagIds`） |
| `GET /api/v1/assets` | 组合筛选与多语种检索（`q`、`productId`、`storeId`、`market`、`platform`、`purpose`、`type`、`reviewStatus`、`folderId`、`unfiled`、`favorite`、`storageId`、`minWidth`、`dateFrom`、`dateTo`、`sort`、分页） |
| `GET /api/v1/assets/:id` | 素材详情（含版本历史、关联商品、标签、存储状态） |
| `PATCH /api/v1/assets/:id` | 编辑业务名、目录、用途、收藏、来源、备注、标签、关联商品（不修改原文件） |
| `POST /api/v1/assets/batch` | 批量操作（移动目录、增删标签、关联商品、批量审核、软删除） |
| `GET /api/v1/assets/:id/versions/:versionId/content` | 流式原文件下载（`Content-Disposition: attachment`；视频支持 `Range` 206；安全文本/图片预览模式强制严格 `CSP` + `nosniff`） |
| `GET /api/v1/assets/:id/versions/:versionId/thumbnail` | 读取或按需触发生成本地缩略图缓存 |
| `POST /api/v1/assets/:id/versions/:versionId/regenerate-thumbnail` | 手动重建损坏/缺失缩略图 |
| `GET /api/v1/trash` | 查看回收站（商品、Listing、素材） |
| `POST /api/v1/trash/restore` | 恢复软删除对象及其关系 |

### M2：存储运维、迁移、任务控制、GC 与备份

| Method & Path | 说明 |
|---|---|
| `POST /api/v1/storage/providers/:id/test` | 执行真实四步探针测试并更新 `status` / `last_tested_at` |
| `POST /api/v1/storage/default` | 切换默认存储（仅影响新上传，校验已启用且可读可写） |
| `POST /api/v1/storage/migrations/preview` | 预览迁移物理文件数、总字节数及共享引用影响清单 |
| `POST /api/v1/storage/migrations` | 创建持久化 `storage_migrate` 迁移任务 |
| `GET /api/v1/storage/cleanup-queue` | 查看迁移保留的来源对象列表 |
| `POST /api/v1/storage/cleanup-queue/confirm` | 用户二次确认后入队清理来源对象 |
| `POST /api/v1/jobs/:id/retry` / `POST /api/v1/jobs/:id/cancel` | 任务重试与协作取消 |
| `POST /api/v1/trash/gc` | 触发受引用保护的物理垃圾回收任务 |
| `POST /api/v1/cache/clear` | 清理本地缩略图缓存（不影响原文件/DB/Release） |
| `GET /api/v1/backups` / `POST /api/v1/backups` | 列出与创建 `metadata` 或 `full` 一致性备份 |
| `GET /api/v1/backups/:id/download` | 流式下载备份包 |

### M3：母图锁定、多版本审核、店铺、Listing、素材集合与 PDP

| Method & Path | 说明 |
|---|---|
| `POST /api/v1/assets/:id/versions` | 为已有素材追加不可变新版本（默认 `pending`） |
| `POST /api/v1/assets/:id/current-version` | 切换当前版本指针（不删历史） |
| `POST /api/v1/asset-versions/:versionId/review` | 按版本审核（`approved` / `rejected` / `pending` + 备注） |
| `GET /api/v1/products/:id/master-images` / `POST ...` / `POST .../:masterId/unlock` | 锁定多角度母图、设默认母图、带备注解锁/替换 |
| `GET /api/v1/dictionaries` / `POST /api/v1/dictionaries` | 平台、市场、语言可配置字典 |
| `GET/POST/PATCH/DELETE /api/v1/stores` | 店铺 CRUD（同平台同市场支持多店） |
| `GET/POST/PATCH/DELETE /api/v1/listings` | Listing CRUD（含手动状态切换） |
| `POST /api/v1/listings/:id/duplicate` | 复制 Listing 为新独立草稿（复用素材版本引用，不共享可变草稿） |
| `PUT /api/v1/listings/:id/skus` | 绑定参与该 Listing 的 SKU 子集与渠道专属编码/名称 |
| `GET /api/v1/listings/:id/asset-sets` / `PUT /api/v1/listings/:id/asset-sets/:kind` | 维护轮播/详情/SKU/视频有序集合（支持拖拽排序、升级版本、SKU 精确绑定） |
| `GET /api/v1/listings/:id/pdp` / `PUT /api/v1/listings/:id/pdp/draft` | 读写 PDP 草稿（UTF-8 EN/TH/ZH，支持导入商品公共规格） |
| `POST /api/v1/listings/:id/pdp/versions` / `POST /api/v1/listings/:id/pdp/restore/:versionId` | 冻结不可变 PDP 版本 / 从历史版本恢复为新草稿 |

### M4：导出模板、预检、不可变 Release、ZIP 导出与完整恢复

| Method & Path | 说明 |
|---|---|
| `GET/POST/PATCH /api/v1/export-templates` | 可配置导出模板（示例规则可编辑、版本化） |
| `POST /api/v1/listings/:id/validate` | 按指定模板对当前 Listing 草稿执行阻断项与提醒项预检 |
| `POST /api/v1/listings/:id/releases` | 创建不可变 Release 快照（区分正式包与明确标记的草稿包） |
| `GET /api/v1/listings/:id/releases` / `GET /api/v1/releases/:id` | 查看 Release 列表与完整快照 |
| `POST /api/v1/releases/:id/restore-draft` | 从旧 Release 恢复为新的独立 Listing 草稿 |
| `POST /api/v1/releases/:id/exports` | 入队流式 ZIP 生成任务（含标准目录结构与 `manifest.json`） |
| `GET /api/v1/exports/:exportId/download` | 下载已生成的上架 ZIP 包（过期提示可一键重建） |
| `POST /api/v1/assets/export-standard` | 按标准目录 + JSON manifest 导出开放格式素材包 |
| `POST /api/v1/backups/restore` | 上传或指定备份文件，进入维护模式执行严格校验与原子恢复 |
