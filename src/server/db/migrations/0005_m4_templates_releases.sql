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
CREATE INDEX idx_export_templates_platform_market
  ON export_templates(platform, market, is_default DESC);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  release_no INTEGER NOT NULL CHECK (release_no >= 1),
  release_code TEXT NOT NULL,
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
CREATE INDEX idx_releases_listing ON releases(listing_id, release_no DESC);

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

-- 可编辑业务示例导出模板（非平台实时官方规则，用户可按后台要求自由修改）
INSERT OR IGNORE INTO export_templates (
  id, name, platform, market, version, is_default, rules_json, created_at, updated_at
) VALUES
(
  'tpl_shopee_ph_default',
  'Shopee PH 示例模板（可编辑）',
  'shopee',
  'PH',
  1,
  1,
  '{"folders":{"carousel":"01_Carousel","sku":"02_SKU","detail":"03_Detail","video":"04_Video","pdp":"05_PDP"},"carousel":{"minCount":1,"targetCount":9,"maxCount":9,"aspectRatio":"1:1","aspectTolerance":0.05,"minWidth":800,"minHeight":800,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"detail":{"minCount":0,"maxCount":20,"aspectRatio":"9:16","aspectTolerance":0.15,"minWidth":750,"minHeight":800,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"sku":{"required":true,"minWidth":600,"minHeight":600,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"video":{"maxCount":2,"maxFileSizeMB":100,"allowedExts":["mp4","mov","webm"]},"pdp":{"maxTitleCodePoints":120,"requiredFields":["title","description"]},"review":{"requireApprovedForFormal":true},"naming":{"carouselPrefix":"Carousel","mainImageName":"01_Main","detailPrefix":"Detail","videoPrefix":"Video"}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
),
(
  'tpl_tiktok_ph_default',
  'TikTok Shop PH 示例模板（可编辑）',
  'tiktok_shop',
  'PH',
  1,
  1,
  '{"folders":{"carousel":"01_Carousel","sku":"02_SKU","detail":"03_Detail","video":"04_Video","pdp":"05_PDP"},"carousel":{"minCount":1,"targetCount":9,"maxCount":9,"aspectRatio":"1:1","aspectTolerance":0.05,"minWidth":800,"minHeight":800,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"detail":{"minCount":0,"maxCount":20,"aspectRatio":"9:16","aspectTolerance":0.15,"minWidth":750,"minHeight":800,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"sku":{"required":true,"minWidth":600,"minHeight":600,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"video":{"maxCount":2,"maxFileSizeMB":100,"allowedExts":["mp4","mov","webm"]},"pdp":{"maxTitleCodePoints":120,"requiredFields":["title","description"]},"review":{"requireApprovedForFormal":true},"naming":{"carouselPrefix":"Carousel","mainImageName":"01_Main","detailPrefix":"Detail","videoPrefix":"Video"}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
),
(
  'tpl_shopee_th_default',
  'Shopee TH 示例模板（可编辑）',
  'shopee',
  'TH',
  1,
  1,
  '{"folders":{"carousel":"01_Carousel","sku":"02_SKU","detail":"03_Detail","video":"04_Video","pdp":"05_PDP"},"carousel":{"minCount":1,"targetCount":9,"maxCount":9,"aspectRatio":"1:1","aspectTolerance":0.05,"minWidth":800,"minHeight":800,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"detail":{"minCount":0,"maxCount":20,"aspectRatio":"9:16","aspectTolerance":0.15,"minWidth":750,"minHeight":800,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"sku":{"required":true,"minWidth":600,"minHeight":600,"maxFileSizeMB":10,"allowedExts":["jpg","jpeg","png","webp"]},"video":{"maxCount":2,"maxFileSizeMB":100,"allowedExts":["mp4","mov","webm"]},"pdp":{"maxTitleCodePoints":120,"requiredFields":["title","description"]},"review":{"requireApprovedForFormal":true},"naming":{"carouselPrefix":"Carousel","mainImageName":"01_Main","detailPrefix":"Detail","videoPrefix":"Video"}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
