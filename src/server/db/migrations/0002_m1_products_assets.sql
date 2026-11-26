CREATE TABLE files (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES storage_providers(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
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
CREATE UNIQUE INDEX idx_folders_root_name ON folders(name) WHERE parent_id IS NULL;

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
CREATE UNIQUE INDEX idx_tags_root_dim_name ON tags(dimension, name) WHERE parent_id IS NULL;
CREATE INDEX idx_tags_dimension ON tags(dimension, name);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('image', 'video', 'document', 'archive', 'other')),
  purpose TEXT NOT NULL DEFAULT 'other',
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  current_version_id TEXT,
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
  appearance_constraints_json TEXT NOT NULL DEFAULT '{}',
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
  attributes_json TEXT NOT NULL DEFAULT '{}',
  attributes_canonical TEXT NOT NULL,
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

INSERT OR IGNORE INTO tags (id, dimension, parent_id, name, is_system, created_at, updated_at) VALUES
  ('sys-market-ph', 'market', NULL, 'PH', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-market-th', 'market', NULL, 'TH', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-market-vn', 'market', NULL, 'VN', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-market-my', 'market', NULL, 'MY', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-market-sg', 'market', NULL, 'SG', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-market-us', 'market', NULL, 'US', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-platform-shopee', 'platform', NULL, 'Shopee', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-platform-tiktok', 'platform', NULL, 'TikTok Shop', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-platform-lazada', 'platform', NULL, 'Lazada', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-platform-amazon', 'platform', NULL, 'Amazon', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-raw', 'purpose', NULL, '实拍图', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-main', 'purpose', NULL, '主图', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-carousel', 'purpose', NULL, '轮播图', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-detail', 'purpose', NULL, '详情图', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-sku', 'purpose', NULL, 'SKU图', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-ai', 'purpose', NULL, 'AI生成图', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-video', 'purpose', NULL, '视频', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-purpose-manual', 'purpose', NULL, '说明书', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-color-black', 'color', NULL, '黑色', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-color-white', 'color', NULL, '白色', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-color-beige', 'color', NULL, '米色', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-color-blue', 'color', NULL, '蓝色', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-scene-whitebg', 'scene', NULL, '白底', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-scene-home', 'scene', NULL, '居家', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-scene-office', 'scene', NULL, '办公', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-scene-outdoor', 'scene', NULL, '户外', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sys-scene-studio', 'scene', NULL, '棚拍', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
