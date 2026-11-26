-- M4 Performance Indexes for 50k+ Asset Search & Pagination (AC-15)
CREATE INDEX IF NOT EXISTS idx_assets_current_version
  ON assets(current_version_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_active_created
  ON assets(created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_active_type_created
  ON assets(asset_type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_active_folder_created
  ON assets(folder_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_active_favorite_created
  ON assets(is_favorite, created_at DESC)
  WHERE deleted_at IS NULL AND is_favorite = 1;

CREATE INDEX IF NOT EXISTS idx_asset_versions_id_review
  ON asset_versions(id, review_status);
