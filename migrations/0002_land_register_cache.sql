CREATE TABLE IF NOT EXISTS land_register_documents (
  id TEXT PRIMARY KEY,
  pnu TEXT NOT NULL,
  pin TEXT NOT NULL,
  pin_fmt TEXT,
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  capp_req_no TEXT,
  r2_key TEXT,
  content_type TEXT,
  byte_size INTEGER,
  page_count INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  downloaded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_land_register_documents_pnu
  ON land_register_documents(pnu);

CREATE INDEX IF NOT EXISTS idx_land_register_documents_status
  ON land_register_documents(status, expires_at);

CREATE TABLE IF NOT EXISTS land_register_downloads (
  id TEXT PRIMARY KEY,
  selection_hash TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  merged_r2_key TEXT,
  file_name TEXT NOT NULL,
  source_document_ids TEXT NOT NULL,
  byte_size INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  downloaded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_land_register_downloads_selection
  ON land_register_downloads(selection_hash, format);

CREATE INDEX IF NOT EXISTS idx_land_register_downloads_status
  ON land_register_downloads(status, expires_at);
