-- Preserve historical review values while removing indexes used by the retired workflow.
DROP INDEX IF EXISTS idx_asset_versions_review;
DROP INDEX IF EXISTS idx_asset_versions_id_review;
