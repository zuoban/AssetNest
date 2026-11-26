# AssetNest 数据库 Schema 与迁移设计（SQLite）

> 数据库引擎：Node 22 内置 `node:sqlite`（SQLite 3.51+）  
> 连接 PRAGMA：`journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`、`synchronous = FULL`（可靠性优先，单用户写吞吐充足）  
> 主键策略：稳定 UUID v4 字符串；时间字段统一 ISO-8601 UTC（如 `2026-11-26T12:00:00.000Z`）

## 1. 迁移策略与版本管理

1. 启动时创建 `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`。
2. 迁移脚本按数字前缀顺序存放于 `src/server/db/migrations/`（打包同步复制至 `dist/server/db/migrations/`）：
   - `0001_m0_foundation.sql`：认证、会话、全局设置、存储 Provider 元数据、任务队列、审计日志
   - `0002_m1_products_assets.sql`：商品、规格、SKU、逻辑目录、标签、物理文件、素材、素材版本、商品素材多对多、搜索文档与 FTS5
   - `0003_m2_storage_ops.sql`：存储清理队列、迁移明细表、备份记录表
   - `0004_m3_ecommerce_workflow.sql`：字典配置（平台/市场/语言）、店铺、Listing、Listing SKU、母图锁定、外观约束、Asset Sets/Items、PDP 草稿与不可变版本
   - `0005_m4_templates_releases.sql`：导出模板、不可变 Release、Release 资产引用与防篡改触发器、导出记录
3. 每个迁移在单个 `BEGIN IMMEDIATE` 事务内执行；校验已应用迁移的 SHA-256 checksum，如数据库版本高于当前程序支持版本则拒绝启动（防止降级破坏）。

## 2. 完整表结构 DDL 规划

### 2.1 M0 基础层（`0001_m0_foundation.sql`）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,        -- scrypt$<N>$<r>$<p>$<salt_hex>$<hash_hex>
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,    -- SHA-256 hex of raw cookie token
  user_agent TEXT,
  ip_address TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 关键键：
-- default_storage_id: string
-- trash_retention_days: number (default 30)
-- export_ttl_hours: number (default 72)
-- app_timezone: string (default "Asia/Shanghai")
-- initialized_at: string

CREATE TABLE storage_providers (
  id TEXT PRIMARY KEY,                -- 稳定 ID，对应 config.yaml 中 provider key
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('local', 's3', 'webdav')),
  config_ref TEXT NOT NULL,           -- config.yaml 路径引用，不含任何密钥
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'healthy', 'degraded', 'offline', 'missing_config')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_tested_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'thumbnail', 'search_reindex', 'export_zip',
    'storage_migrate', 'storage_cleanup', 'gc', 'backup', 'restore'
  )),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  progress_stage TEXT,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,             -- NULL 表示未知总量
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_poll ON jobs(status, run_after, priority, created_at);
CREATE INDEX idx_jobs_lease ON jobs(status, lease_until);
CREATE INDEX idx_jobs_type_status ON jobs(type, status);

CREATE TABLE job_locks (
  resource_key TEXT PRIMARY KEY,      -- 例如 file:<file_id> 或 system:backup
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL
);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,               -- setup.init, auth.login_failed, master.replace, release.create ...
  object_type TEXT NOT NULL,
  object_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}', -- 写入前强制脱敏
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_created_at ON activity_events(created_at DESC);
CREATE INDEX idx_activity_object ON activity_events(object_type, object_id);
```

### 2.2 M1 商品、物理文件、素材与搜索（`0002_m1_products_assets.sql`）

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES storage_providers(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,           -- originals/<sha256[0..2]>/<sha256>
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'staging'
    CHECK (state IN ('staging', 'ready', 'pending_delete', 'delete_failed', 'deleted')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storage_id, sha256)
);
CREATE INDEX idx_files_state ON files(state);
CREATE INDEX idx_files_storage ON files(storage_id, state);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (parent_id, name)
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL CHECK (dimension IN ('market', 'platform', 'purpose', 'color', 'scene', 'custom')),
  parent_id TEXT REFERENCES tags(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (dimension, parent_id, name)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('image', 'video', 'document', 'archive', 'other')),
  purpose TEXT NOT NULL DEFAULT 'other',
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, -- NULL 表示待归类
  current_version_id TEXT,            -- 关联 asset_versions(id)，由触发器保证同 asset_id
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  source TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_assets_deleted_created ON assets(deleted_at, created_at DESC);
CREATE INDEX idx_assets_folder ON assets(folder_id, deleted_at);
CREATE INDEX idx_assets_type_purpose ON assets(asset_type, purpose, deleted_at);
CREATE INDEX idx_assets_favorite ON assets(is_favorite, deleted_at);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  original_filename TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  reference_asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  thumb_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (thumb_status IN ('pending', 'ready', 'unsupported', 'failed')),
  thumb_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version_no)
);
CREATE INDEX idx_asset_versions_file ON asset_versions(file_id);
CREATE INDEX idx_asset_versions_review ON asset_versions(review_status, created_at DESC);

-- 保证 assets.current_version_id 必属于该 asset
CREATE TRIGGER trg_assets_current_version_check
BEFORE UPDATE OF current_version_id ON assets
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM asset_versions
      WHERE id = NEW.current_version_id AND asset_id = NEW.id
    )
    THEN RAISE(ABORT, 'current_version_id must belong to the same asset')
  END;
END;

CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX idx_asset_tags_tag ON asset_tags(tag_id, asset_id);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  spu TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  brand_model TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL DEFAULT '',
  supplier_url TEXT NOT NULL DEFAULT '',
  cover_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  notes TEXT NOT NULL DEFAULT '',
  appearance_constraints_json TEXT NOT NULL DEFAULT '{}', -- 结构/比例/颜色/尺寸/禁止修改项
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_products_status_deleted ON products(status, deleted_at, updated_at DESC);

CREATE TABLE product_specs (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  spec_key TEXT NOT NULL,
  spec_value TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_product_specs_product ON product_specs(product_id, position);

CREATE TABLE skus (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',     -- 规范化排序后的 JSON
  attributes_canonical TEXT NOT NULL,             -- 唯一组合键（同商品下不可重复）
  extra_specs_json TEXT NOT NULL DEFAULT '[]',
  primary_asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (product_id, attributes_canonical)
);
CREATE INDEX idx_skus_product ON skus(product_id);

CREATE TABLE product_assets (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_id, asset_id)
);
CREATE INDEX idx_product_assets_asset ON product_assets(asset_id, product_id);

-- 可重建的统一检索索引（支持中/泰/英三语子串精确匹配）
CREATE TABLE search_documents (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('asset', 'product', 'listing')),
  entity_id TEXT NOT NULL,
  search_text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  search_text,
  tokenize = 'trigram'
);
```

### 2.3 M2 存储运维与备份（`0003_m2_storage_ops.sql`）

```sql
CREATE TABLE storage_cleanup_queue (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES storage_providers(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('migration_source', 'gc_unreferenced')),
  source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
    CHECK (status IN ('awaiting_confirmation', 'queued', 'deleted', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storage_id, object_key, status)
);

CREATE TABLE storage_migration_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  source_storage_id TEXT NOT NULL,
  target_storage_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'copied', 'switched', 'merged', 'failed', 'skipped')),
  merged_into_file_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, file_id)
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('metadata', 'full')),
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  schema_version INTEGER NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'ready', 'failed', 'deleted')),
  last_error TEXT,
  created_at TEXT NOT NULL
);
```

### 2.4 M3 电商多渠道工作流（`0004_m3_ecommerce_workflow.sql`）

```sql
CREATE TABLE dictionaries (
  category TEXT NOT NULL CHECK (category IN ('platform', 'market', 'language')),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, code)
);

CREATE TABLE product_master_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  angle TEXT NOT NULL DEFAULT 'front',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  lock_note TEXT NOT NULL DEFAULT '',
  locked_at TEXT NOT NULL,
  unlocked_at TEXT,
  unlock_note TEXT
);
CREATE INDEX idx_master_images_product ON product_master_images(product_id, unlocked_at);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  market TEXT NOT NULL,
  default_language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  language TEXT NOT NULL,
  external_id TEXT,
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'published', 'archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_listings_product ON listings(product_id, deleted_at);
CREATE INDEX idx_listings_store ON listings(store_id, deleted_at);

CREATE TABLE listing_skus (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  channel_code TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (listing_id, sku_id)
);

CREATE TABLE asset_sets (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('carousel', 'detail', 'sku', 'video')),
  updated_at TEXT NOT NULL,
  UNIQUE (listing_id, kind)
);

CREATE TABLE asset_set_items (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES asset_sets(id) ON DELETE CASCADE,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  listing_sku_id TEXT REFERENCES listing_skus(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_asset_set_items_set ON asset_set_items(set_id, position);
CREATE INDEX idx_asset_set_items_version ON asset_set_items(asset_version_id);

-- 禁止跨 Listing 关联 listing_sku_id
CREATE TRIGGER trg_asset_set_items_sku_scope
BEFORE INSERT ON asset_set_items
WHEN NEW.listing_sku_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM asset_sets s
      JOIN listing_skus ls ON ls.id = NEW.listing_sku_id
      WHERE s.id = NEW.set_id AND s.listing_id = ls.listing_id AND s.kind = 'sku'
    )
    THEN RAISE(ABORT, 'listing_sku_id must belong to the same listing and a sku asset_set')
  END;
END;

CREATE TABLE listing_pdp_drafts (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  content_json TEXT NOT NULL,         -- { title, shortDescription, bullets, fullDescription, specs, packageList, usageInstructions, seoKeywords, notes }
  revision INTEGER NOT NULL DEFAULT 1,
  based_on_version_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE pdp_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  language TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  content_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version_no)
);
```

### 2.5 M4 模板、不可变 Release 与导出（`0005_m4_templates_releases.sql`）

```sql
CREATE TABLE export_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  market TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  release_no INTEGER NOT NULL CHECK (release_no >= 1),
  release_code TEXT NOT NULL,         -- 例如 R001
  is_draft_package INTEGER NOT NULL DEFAULT 0 CHECK (is_draft_package IN (0, 1)),
  template_id TEXT NOT NULL REFERENCES export_templates(id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL,
  pdp_version_id TEXT REFERENCES pdp_versions(id) ON DELETE RESTRICT,
  validation_summary_json TEXT NOT NULL,
  immutable_snapshot_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, release_no)
);

CREATE TABLE release_assets (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('carousel', 'detail', 'sku', 'video')),
  listing_sku_code TEXT,
  position INTEGER NOT NULL,
  export_relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);
CREATE INDEX idx_release_assets_release ON release_assets(release_id, kind, position);
CREATE INDEX idx_release_assets_version ON release_assets(asset_version_id);

-- 数据库级强制保护 Release 不可变性
CREATE TRIGGER trg_releases_immutable_update
BEFORE UPDATE ON releases
BEGIN
  SELECT RAISE(ABORT, 'releases are immutable');
END;

CREATE TRIGGER trg_releases_immutable_delete
BEFORE DELETE ON releases
BEGIN
  SELECT RAISE(ABORT, 'releases cannot be deleted');
END;

CREATE TRIGGER trg_release_assets_immutable_update
BEFORE UPDATE ON release_assets
BEGIN
  SELECT RAISE(ABORT, 'release_assets are immutable');
END;

CREATE TRIGGER trg_release_assets_immutable_delete
BEFORE DELETE ON release_assets
BEGIN
  SELECT RAISE(ABORT, 'release_assets cannot be deleted');
END;

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'expired', 'failed')),
  file_path TEXT,
  file_name TEXT NOT NULL,
  size_bytes INTEGER,
  expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_exports_release ON exports(release_id, created_at DESC);
```

## 3. 关键业务不变量与清理引用判定

一个 `files` 记录**仅当同时满足以下所有条件**时才允许被 GC 物理删除：
1. 无任何未删除或未超过回收站保留期的 `assets` 关联到引用该 `file_id` 的 `asset_versions`；
2. 无任何未解锁的 `product_master_images` 引用该 `file_id`；
3. 无任何 `asset_set_items` 引用该 `file_id`；
4. 无任何 `release_assets` 通过 `asset_versions.file_id` 引用该 `file_id`（永久受保护）；
5. 无任何 `status IN ('queued', 'running')` 的 `jobs`（含 `backup`、`export_zip`、`storage_migrate`）持有或覆盖该 `file_id`。
