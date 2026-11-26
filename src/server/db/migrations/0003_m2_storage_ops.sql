CREATE TABLE storage_cleanup_queue (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES storage_providers(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('migration_source', 'gc_unreferenced')),
  source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
    CHECK (status IN ('awaiting_confirmation', 'queued', 'deleted', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_cleanup_active_object
  ON storage_cleanup_queue(storage_id, object_key)
  WHERE status IN ('awaiting_confirmation', 'queued', 'failed');
CREATE INDEX idx_cleanup_status_created ON storage_cleanup_queue(status, created_at DESC);

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
CREATE INDEX idx_migration_items_job_status ON storage_migration_items(job_id, status);

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
CREATE INDEX idx_backups_created ON backups(created_at DESC);
