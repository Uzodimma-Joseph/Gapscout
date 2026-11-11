PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL, country TEXT, region TEXT, city TEXT NOT NULL, area TEXT,
  result_limit INTEGER NOT NULL DEFAULT 50,
  lat REAL, lng REAL, resolved_location TEXT, discovery_done INTEGER NOT NULL DEFAULT 0,
  hide_seen INTEGER NOT NULL DEFAULT 1, skipped_seen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','discovering','enriching','verifying','completed','partial','failed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, name_norm TEXT NOT NULL,
  category TEXT, subcategory TEXT, description TEXT,
  image_url TEXT, image_source TEXT,
  phone TEXT, email TEXT, whatsapp TEXT,
  address TEXT, city TEXT, region TEXT, country TEXT, postal_code TEXT, lat REAL, lng REAL,
  facebook_url TEXT, instagram_url TEXT, linkedin_url TEXT, listing_url TEXT, listing_website TEXT,
  official_url TEXT,
  website_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (website_status IN ('unverified','website_found','no_website_found','uncertain','verification_failed')),
  website_confidence TEXT, verified_at TEXT, verification_notes TEXT,
  completeness REAL NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_biz_phone ON businesses(phone);
CREATE INDEX IF NOT EXISTS idx_biz_city ON businesses(city, country);
CREATE INDEX IF NOT EXISTS idx_biz_status ON businesses(website_status);

-- A business can appear in many searches; records are reused, never duplicated.
CREATE TABLE IF NOT EXISTS search_businesses (
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  PRIMARY KEY (search_id, business_id)
);

CREATE TABLE IF NOT EXISTS business_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source TEXT NOT NULL, source_id TEXT, url TEXT, raw_json TEXT, fetched_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status TEXT NOT NULL, confidence TEXT, official_url TEXT,
  evidence_json TEXT NOT NULL, verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ver_biz ON verifications(business_id, verified_at);

CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id TEXT, step TEXT NOT NULL, source TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id TEXT, provider TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 1, est_cost_usd REAL, created_at TEXT NOT NULL
);
