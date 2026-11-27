# AssetNest 研发计划与阶段验收标准（M0–M4）

> 每个阶段完成后必须执行真实自动化测试与运行验证，修复全部阻断问题后再进入下一阶段。

## M0：技术基础（骨架、配置、SQLite 迁移、认证、Docker、测试）

### 任务拆分
1. **M0.1 项目骨架与构建管线**：初始化 pnpm + TypeScript（strict）+ Fastify 5 + React 19 / Vite 6 / Tailwind v4 单体项目结构；配置 `typecheck`、`build`、`test` 脚本。
2. **M0.2 配置加载与校验**：实现 `/config/config.yaml` 解析、`${ENV_VAR}` 展开、Zod 校验、敏感字段脱敏及配置示例（`config/config.example.yaml`、`.env.example`）；未配置远程 Provider 时可纯 Local 启动。
3. **M0.3 SQLite 引擎与版本化迁移**：封装 `node:sqlite`（WAL、`foreign_keys = ON`、`busy_timeout = 5000`、`synchronous = FULL`）、`BEGIN IMMEDIATE` 事务助手、单实例文件锁、版本化迁移器与 `0001_m0_foundation.sql`。
4. **M0.4 首次初始化、会话认证与安全基线**：实现 `GET /healthz`、`GET/POST /api/v1/setup/*`、`POST /api/v1/auth/login|logout`、`GET /api/v1/auth/me`、scrypt 密码哈希、`HttpOnly` 会话 Cookie、CSRF 同源与自定义头校验、登录限速、宿主机管理员重置 CLI（`reset-admin`）及审计事件记录。
5. **M0.5 系统只读基础 API 与桌面 UI 外壳**：实现 `GET /api/v1/dashboard`、`GET/PATCH /api/v1/settings`、`GET /api/v1/storage/providers`、`GET /api/v1/jobs`、`GET /api/v1/activities`；完成中文初始化引导页、登录页、左侧主导航框架、工作台真实状态卡片与设置/存储/任务/审计只读展示页（零 Mock 数据、零假按钮）。
6. **M0.6 单容器 Docker 交付与实测**：编写多阶段非 root `Dockerfile`、`compose.yaml` 与 `README.md`；在本地完成真实 Docker 镜像构建、启动、初始化、重启持久化校验。

### M0 验收标准（覆盖 AC-01、AC-13 基础）
- `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过；
- 空数据启动后完成首次管理员初始化，再次调用 `/api/v1/setup/init` 返回 `409`；
- 未登录访问 `/api/v1/dashboard`、`/api/v1/settings` 等业务接口均返回 `401`；
- 缺少 CSRF 头或跨源 `POST` 请求返回 `403`；
- 宿主机执行 `reset-admin` 可重置密码并吊销旧会话；
- 单容器 Docker 构建并运行成功，仅挂本地卷无任何外部 DB/Redis；重启容器后账户与设置数据完整保留。

---

## M1：素材核心（商品/SKU、Local 存储、上传去重、标签目录、预览、多语检索、回收站）

### 任务拆分
1. **M1.1 数据库迁移 `0002_m1_products_assets.sql`**：建表 + 触发器 + 预置用途/标签维度 + FTS5 trigram 搜索表。
2. **M1.2 `StorageProvider` 接口与 Local 适配器**：原子暂存写入、符号链接/路径穿越防护、Range 流式读取、四步探针测试。
3. **M1.3 商品与 SKU 全功能（FR-02）**：商品 CRUD、自定义键值规格、归档与软删除影响检测、SKU CRUD（全空间唯一码 + 同商品规格组合唯一）、商品中心网格/列表 UI 与详情页。
4. **M1.4 流式上传、去重与基础素材库（FR-03）**：`multipart` 磁盘流式暂存、SHA-256 去重、魔数检测、大小/并发/临时盘上限、逻辑文件夹、多级标签、批量操作、收藏/备注/来源/Prompt 文本。
5. **M1.5 预览、缩略图缓存与中/泰/英组合搜索（FR-04）**：Sharp 限像素缩略图生成与缓存容量控制、损坏缩略图重建、全屏灯箱（缩放/100%/切换）、视频 Range 播放、安全纯文本预览、SVG/HTML 沙箱防护、FTS5 + 1–2 字回退组合搜索与虚拟滚动三栏 UI。
6. **M1.6 回收站与恢复基础（FR-10 基础）**：软删除列表、一键恢复并保留原有商品/标签关联。

### M1 验收标准（覆盖 AC-03、AC-04、AC-11 基础）
- 重复上传同图至两个商品仅落盘 1 份 Local 物理文件，两条素材独立编辑与软删除互不影响；
- 组合筛选「商品 + 市场 + 平台 + 场景 + 状态」精确命中；中/泰/英（含 1–2 字符）关键词检索全部通过；
- PSD/ZIP 等不可预览格式安全提供下载；SVG/HTML 响应强制安全头且不执行脚本；
- 损坏缩略图删除缓存后可重新生成；回收站恢复保留关联。

---

## M2：存储完整性（S3、WebDAV、默认切换、持久化任务队列、安全迁移、GC、备份）

### 任务拆分
1. **M2.1 数据库迁移 `0003_m2_storage_ops.sql`** 与内置持久化 Worker（租约、心跳、并发上限 2、重试退避、协作取消、重启恢复过期租约）。
2. **M2.2 S3 Compatible 适配器**：流式分片上传、Range 读取、自定义 endpoint/path-style/prefix、错误分类与真实 S3 兼容服务集成测试。
3. **M2.3 WebDAV 适配器**：原生 `fetch` 流式读写、递归 `MKCOL`、SSRF/重定向防护、非 Range 降级流式回退与真实 WebDAV 服务集成测试。
4. **M2.4 存储配置管理与默认切换**：在线测试、默认存储切换（仅影响新文件）、`missing_config`/离线降级提示、有引用 Provider 禁止删除。
5. **M2.5 跨存储安全迁移**：Dry-run 预览（含共享引用影响）、逐文件流式校验与短事务切换/去重合并、断网/重启断点续传、来源对象二次确认清理队列。
6. **M2.6 引用保护 GC 与一致性备份**：全引用检查 GC（远程删除失败保留重试状态）、`VACUUM INTO` 元数据备份与流式完整备份、缓存清理。

### M2 验收标准（覆盖 AC-08、AC-09、AC-10、AC-11、AC-14 部分）
- Local、真实 S3 兼容服务、真实 WebDAV 服务完成上传/读取/下载/探针/删除保护实测；
- 切换默认存储后新旧文件各自正确定位；
- Local→S3、S3→WebDAV、WebDAV→Local 迁移校验通过，模拟故障与重启后可继续且哈希/引用一致；
- 远程离线时本地元数据仍可浏览并给出明确离线状态；一致性备份可成功生成并下载。

---

## M3：电商多渠道工作流（母图、版本管理、店铺、Listing、轮播/SKU 图、PDP）

### 任务拆分
1. **M3.1 数据库迁移 `0004_m3_ecommerce_workflow.sql`** 与预置平台/市场/语言字典。
2. **M3.2 母图锁定与多版本管理（FR-05）**：追加不可变新版本、当前版本指针切换、多角度母图锁定与带备注解锁/替换、外观约束维护、母图与选定素材版本并排对比。
3. **M3.3 店铺与 Listing 管理（FR-06）**：同平台同市场多店、同店多 Listing、SKU 子集与渠道专属编码绑定、Listing 复制为独立草稿、手动状态标记。
4. **M3.4 上架素材集合与可视化拖拽排序（FR-07）**：轮播图（`@dnd-kit` 拖拽持久化）、详情图竖排预览、SKU 图与 `listing_sku` 精确绑定、视频集合、版本更新提示与手动升级、重复项警示。
5. **M3.5 PDP 多语种文案与版本历史（FR-08）**：结构化字段编辑器、Unicode 码点标题计数、导入商品公共规格（差异提示不覆盖）、单字段/全文复制、冻结不可变 PDP 版本与历史恢复为新草稿。

### M3 验收标准（覆盖 AC-02、AC-05、AC-06）
- 一 SPU + 三 SKU + 三渠道 Listing（PH Shopee / PH TikTok / TH Shopee）独立维护互不影响；
- 锁定母图 V1 后上传 V2，母图继续引用 V1；
- 9 张轮播图拖拽刷新后顺序不变；替换单个 SKU 图不影响其他 SKU；
- EN/TH 混合 PDP 保存、历史复制与 UTF-8 文本读取零乱码。

---

## M4：交付与加固（导出模板、Release、ZIP 导出、完整恢复、安全与性能验收）

### 任务拆分
1. **M4.1 数据库迁移 `0005_m4_templates_releases.sql`**（含不可变触发器）与可编辑示例导出模板。
2. **M4.2 上架预检与不可变 Release（FR-09）**：阻断错误 vs 提醒项检查、创建不可变正式 Release 与明确标注的草稿包、从旧 Release 恢复为新独立草稿。
3. **M4.3 流式 ZIP 上架包与开放格式导出**：Worker 流式读取远程/本地原文件写入 `yazl`（含标准目录结构、安全文件名、`manifest.json` 无密钥）、进度/重试/过期清理与历史 Release 内容一致重导出；批量开放目录导出。
4. **M4.4 维护模式完整恢复（Section 8）**：备份完整性/Schema/逐文件哈希预检、临时 staging 与原子切换、损坏备份零损回滚、缩略图与搜索索引自动重建。
5. **M4.5 安全、故障与性能基准测试（Section 9–10）**：路径穿越/ZIP-Slip/未登录/CSRF/大文件超限/断网/缓存满实测；构建 1,000 商品 / 5,000 SKU / 50,000 素材基准脚本实测 P95 搜索与内存占用，输出完整验收报告覆盖 AC-01 至 AC-15。

### M4 验收标准（覆盖 AC-07、AC-12、AC-13、AC-14、AC-15 及全量 AC-01..AC-15）
- 9 轮播 + 3 SKU + 详情 + EN PDP 正式 Release 导出 ZIP 与 `manifest.json` 全一致；修改草稿后重导旧 Release 文件哈希与文案内容一致；
- 干净实例恢复含 Local 与远程原文件的完整备份全部一致，损坏备份保留原数据；
- 完成 AC-01 至 AC-15 逐项真实测试记录与性能实测数据报告。
