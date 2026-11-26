# AssetNest

面向跨境电商卖家的自托管、单容器、低依赖数字资产管理平台（DAM）。

## 当前阶段状态

- **M0（技术基础）**：已完成项目骨架、配置加载校验、SQLite（Node 22 内置 `node:sqlite` + WAL + 版本化迁移）、初始化引导与会话鉴权、CSRF/限速防护、宿主机 `reset-admin` CLI、桌面端基础 UI 与单容器 Docker 部署。
- **M1–M4**：规划与验收标准见 [`docs/PLAN.md`](docs/PLAN.md)。

## 快速开始（本地开发）

环境要求：Node.js `>= 22.13.0`、pnpm `12+`。

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test

# 启动后端（默认端口 3000，数据目录 ./data）
pnpm dev:server
# 另开终端启动前端开发服务（端口 5173，代理 /api 到 3000）
pnpm dev:web
```

## 单容器 Docker 部署

```bash
mkdir -p data config
cp config/config.example.yaml config/config.yaml
cp .env.example .env
docker compose up -d --build
```

浏览器访问 `http://127.0.0.1:3000` 完成首次管理员初始化。

## 宿主机受控重置管理员密码

已初始化实例无法通过 Web 初始化入口重置管理员。若忘记密码，请在宿主机执行：

```bash
# Docker 环境
printf '%s\n' 'NewStrongPassword123' | docker compose exec -T assetnest \
  node dist/server/cli.js reset-admin --username admin --password-stdin

# 本地环境
printf '%s\n' 'NewStrongPassword123' | node dist/server/cli.js reset-admin --username admin --password-stdin
```

## 文档导航

- `docs/PRD.md`：产品需求基线
- `docs/ARCHITECTURE.md`：冲突分析、技术栈与系统架构
- `docs/SCHEMA.md`：SQLite 数据库 Schema 与迁移规范
- `docs/STORAGE.md`：可插拔存储接口（Local / S3 / WebDAV）与迁移机制
- `docs/API.md`：REST API 契约
- `docs/UI_UX.md`：桌面端 UI/UX 规范
- `docs/PLAN.md`：M0–M4 任务拆分与验收标准
