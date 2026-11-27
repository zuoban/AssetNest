# AssetNest

面向跨境电商卖家的自托管、单容器、低依赖数字资产管理平台（DAM）。基于 SQLite 单体架构，支持 Local / S3 Compatible / WebDAV 可插拔存储，覆盖商品与 SKU、素材库、母图与素材版本、多店铺多渠道 Listing、多语种 PDP 文案、版本化导出模板、不可变 Release 上架包与完整备份恢复。

## 交付状态（v1.0 / M0–M4 已全部完成）

- **M0（技术基础）**：配置加载校验、SQLite（Node 22 `node:sqlite` + WAL + 版本化迁移）、可选访问码认证（未配置即免登录）、CSRF/限速、宿主机 `revoke-sessions` CLI、单容器 Docker 部署。
- **M1（素材核心）**：商品/SKU 管理、Local 内容寻址存储与去重、流式上传、文件夹与多级标签、缩略图缓存、安全预览/灯箱/视频 Range 播放、FTS5 中英泰组合检索、回收站与恢复。
- **M2（存储完整性）**：S3 Compatible / WebDAV 适配器、在线连通性检测、默认存储切换、持久化任务队列 Worker、跨存储断点续传安全迁移、延迟清理队列、引用保护 GC 与一致性备份。
- **M3（电商多渠道工作流）**：多角度母图锁定与版本历史、多店铺与多渠道 Listing、SKU 子集绑定、轮播图拖拽排序、SKU 图/详情图/视频集合、中/英/泰多语种 PDP 文案与历史版本。
- **M4（交付与加固）**：版本化导出模板、阻断/提醒校验、草稿包与不可变正式 Release、流式 ZIP 上架包与开放标准目录导出、维护模式完整恢复与恶意 ZIP 拦截、50,000 素材性能压测与 AC-01 至 AC-15 全量验收（详见 [`docs/ACCEPTANCE_REPORT.md`](docs/ACCEPTANCE_REPORT.md)）。

## 快速开始（本地运行）

需要 Node.js `>= 22.13.0`、pnpm 和 Make。在项目目录运行：

```bash
make
```

`make` 和 `make start` 都会安装依赖、构建前后端并启动服务。启动后打开 [AssetNest 本地页面](http://127.0.0.1:3000)，按 `Ctrl+C` 停止服务。

## 本地开发

```bash
make dev
```

打开 [开发页面](http://127.0.0.1:5173)。Vite 默认只监听 `127.0.0.1:5173`，提供 React 热更新，并通过项目 `data/` 下为本次启动创建的独立 Unix socket 代理 `/api/v1` 和 `/healthz`。后端由 `tsx watch` 自动重启。按 `Ctrl+C` 停止，正常退出时会清理本次启动的 socket 和目录。

需要同时运行隔离的开发实例时，可用 `ASSETNEST_DEV_WEB_PORT` 指定其他 Vite 端口，并用 `ASSETNEST_DATA_DIR` 指定独立数据目录。若配置文件中单独指定了数据库或存储路径，也要为隔离实例使用独立的配置文件。

也可以分开启动后端和前端。`pnpm dev:server` 默认使用 TCP 3000 和 `./data`，`pnpm dev:web` 默认监听 `127.0.0.1:5173`，并将 `/api/v1` 和 `/healthz` 代理到 `127.0.0.1:3000`。

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test

# 可选：运行 AC-15 性能压测（1,000 商品 / 5,000 SKU / 50,000 素材）
pnpm tsx scripts/benchmark-m4.ts
```

## 单容器 Docker 部署

```bash
mkdir -p data config
cp config/config.example.yaml config/config.yaml
cp .env.example .env
docker pull ghcr.io/zuoban/assetnest:0.2.0
docker tag ghcr.io/zuoban/assetnest:0.2.0 assetnest:0.2.0
docker compose up -d --no-build
```

如需从当前源码构建，执行 `docker compose up -d --build`。

> 若构建环境需要自定义 npm 镜像源，可使用 `docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t assetnest:0.2.0 .`。

浏览器访问 `http://127.0.0.1:3000` 即可直接使用系统。健康探针地址：`GET /healthz`。

## 访问控制（访问码）

AssetNest 采用简化的环境变量访问码控制，无需注册或维护用户名/密码：

- **免登录模式（默认）**：不配置 `ASSETNEST_ACCESS_CODE`（或留空），打开系统即可直接使用，无需登录。
- **访问码模式**：本地运行 `ASSETNEST_ACCESS_CODE='你的访问码' make`。使用 Docker Compose 时，在 `.env` 中设置 `ASSETNEST_ACCESS_CODE` 并运行 `docker compose up -d`。修改访问码并重新启动后，旧会话会自动失效。

如需手动吊销所有活动会话，可在宿主机执行：

```bash
# Docker 环境
docker compose exec -T assetnest node dist/server/cli.js revoke-sessions

# 本地环境
node dist/server/cli.js revoke-sessions
```

## 升级指南

1. **升级前先做备份**：在「系统设置」页触发一次「完整备份」（或至少触发「元数据备份」）并下载留存。
2. **替换镜像**：使用对应版本的 `compose.yaml`，保留现有 `.env`、`config/` 和 `data/`，然后执行：
   ```bash
   docker pull ghcr.io/zuoban/assetnest:0.2.0
   docker tag ghcr.io/zuoban/assetnest:0.2.0 assetnest:0.2.0
   docker compose up -d --no-build
   ```
   使用新版源码构建时，执行 `docker compose up -d --build`。
3. **自动向前迁移**：容器启动时会校验单实例锁并自动按顺序应用 `src/server/db/migrations/` 下新增的 SQL 迁移（当前最新 Schema 版本为 `7`），保留原有 `/data` 与 `/config` 数据；`GET /healthz` 返回 `"dbReady": true` 即升级完成。
4. **回退说明**：数据库迁移为向前单向执行，如需降级请恢复升级前导出的备份包。

## 备份与维护模式恢复

### 创建备份
在 Web 端「系统设置 → 备份与恢复」中可执行两种一致性备份：
- **元数据备份**：通过 SQLite `VACUUM INTO` 生成一致性数据库快照，并附带 `backup-manifest.json`（含 Schema 版本、校验和，绝不包含远程密钥或明文密码）。
- **完整备份（ZIP）**：在元数据快照基础上流式打包所有本地及远程存储原文件与逐文件 SHA-256 清单，支持跨实例完整重建。

### 维护模式恢复
1. 在「系统设置 → 备份与恢复」选择已有历史备份 ID，或上传本地完整备份 ZIP 文件执行恢复（对应接口 `POST /api/v1/backups/restore` 与 `POST /api/v1/backups/restore-upload`）。
2. 恢复流程会自动进入维护模式：
   - 暂停后台任务并执行严格预检（校验 ZIP 路径防穿越与防符号链接、Schema 版本、`backup-manifest.json` 及逐文件 SHA-256）。
   - 预检任何一项失败都会立即中止并回滚，**绝不覆盖或破坏当前运行数据**。
   - 校验通过后在临时目录暂存还原数据库与本地/远程原文件，原子切换数据库并自动重建 FTS5 全文索引与缩略图缓存。
3. 若目标实例启用了远程存储（S3 / WebDAV），请在恢复前于 `config/config.yaml` 与 `.env` 中配置同名 Provider 凭证。

## 文档导航

- `docs/PRD.md`：产品需求基线
- `docs/ARCHITECTURE.md`：冲突分析、技术栈与系统架构
- `docs/SCHEMA.md`：SQLite 数据库 Schema 与迁移规范
- `docs/STORAGE.md`：可插拔存储接口（Local / S3 / WebDAV）与迁移机制
- `docs/API.md`：REST API 契约
- `docs/UI_UX.md`：桌面端 UI/UX 规范
- `docs/PLAN.md`：M0–M4 任务拆分与验收标准
- `docs/ACCEPTANCE_REPORT.md`：v1.0（M0–M4）AC-01 至 AC-15 完整验收报告与性能压测数据
