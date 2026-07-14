-- Tavern-wide Cloudflare usage cache. Object keys are stored only internally so the API can return
-- aggregate media categories without exposing private media identifiers to signed-in users.
CREATE TABLE media_usage_inventory(
  r2_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX media_usage_inventory_category_idx ON media_usage_inventory(category);

-- A singleton tracks the last complete R2 list reconciliation. Immediate mutation updates keep the
-- displayed media total fresh; the scheduled scan corrects drift after an interrupted cross-service write.
CREATE TABLE media_usage_inventory_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  reconciled_at INTEGER
);

-- Each Cloudflare source is independently cacheable. A failed refresh never overwrites the previous
-- successful payload, which lets the API distinguish stale data from data that has never been available.
CREATE TABLE cloudflare_usage_cache(
  source TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'stale', 'unavailable')),
  updated_at INTEGER,
  attempted_at INTEGER NOT NULL
);
