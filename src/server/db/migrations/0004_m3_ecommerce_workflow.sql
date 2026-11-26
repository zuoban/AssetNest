CREATE TABLE dictionaries (
  category TEXT NOT NULL CHECK (category IN ('platform', 'market', 'language')),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, code)
);

INSERT INTO dictionaries (category, code, label, is_active, position) VALUES
  ('platform', 'shopee', 'Shopee', 1, 10),
  ('platform', 'tiktok_shop', 'TikTok Shop', 1, 20),
  ('platform', 'lazada', 'Lazada', 1, 30),
  ('market', 'PH', '菲律宾 (PH)', 1, 10),
  ('market', 'TH', '泰国 (TH)', 1, 20),
  ('market', 'MY', '马来西亚 (MY)', 1, 30),
  ('market', 'VN', '越南 (VN)', 1, 40),
  ('market', 'SG', '新加坡 (SG)', 1, 50),
  ('market', 'ID', '印度尼西亚 (ID)', 1, 60),
  ('language', 'en', 'English (en)', 1, 10),
  ('language', 'th', 'ไทย (th)', 1, 20),
  ('language', 'zh', '中文 (zh)', 1, 30),
  ('language', 'ms', 'Bahasa Melayu (ms)', 1, 40),
  ('language', 'vi', 'Tiếng Việt (vi)', 1, 50),
  ('language', 'id', 'Bahasa Indonesia (id)', 1, 60);

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
CREATE INDEX idx_master_images_version ON product_master_images(asset_version_id, unlocked_at);

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
CREATE INDEX idx_stores_platform_market ON stores(platform, market, status);

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
CREATE INDEX idx_listings_status_deleted ON listings(status, deleted_at, updated_at DESC);

CREATE TABLE listing_skus (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  channel_code TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (listing_id, sku_id)
);
CREATE INDEX idx_listing_skus_sku ON listing_skus(sku_id);

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
CREATE INDEX idx_asset_set_items_sku ON asset_set_items(listing_sku_id);

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

CREATE TRIGGER trg_asset_set_items_sku_scope_update
BEFORE UPDATE OF set_id, listing_sku_id ON asset_set_items
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
  content_json TEXT NOT NULL,
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
CREATE INDEX idx_pdp_versions_listing ON pdp_versions(listing_id, version_no DESC);

CREATE TRIGGER trg_pdp_versions_immutable_update
BEFORE UPDATE ON pdp_versions
BEGIN
  SELECT RAISE(ABORT, 'pdp_versions are immutable');
END;

CREATE TRIGGER trg_pdp_versions_immutable_delete
BEFORE DELETE ON pdp_versions
BEGIN
  SELECT RAISE(ABORT, 'pdp_versions cannot be deleted');
END;
