CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  client_ts TEXT,
  event_type TEXT NOT NULL,
  event_value TEXT,
  event_label TEXT,
  session_id TEXT,
  visitor_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  landing_page TEXT,
  page_title TEXT,
  invite_code TEXT,
  traffic_source TEXT,
  referrer_host TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  colo TEXT,
  asn INTEGER,
  network_name TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  language TEXT,
  timezone TEXT,
  screen_width INTEGER,
  screen_height INTEGER,
  is_bot INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor ON analytics_events(visitor_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_source ON analytics_events(traffic_source, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_campaign ON analytics_events(utm_campaign, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_country ON analytics_events(country, created_at);
