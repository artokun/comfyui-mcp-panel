-- Apps registry schema (D1). P5 hooks (pricing_json, hosted_only) exist from
-- day one so monetization is purely additive — no migration needed later.

CREATE TABLE IF NOT EXISTS apps (
  id            TEXT PRIMARY KEY,            -- uuid (client's local app id)
  slug          TEXT NOT NULL UNIQUE,        -- creator/app-name
  creator_id    TEXT NOT NULL,               -- sha256(creator_key)
  creator_name  TEXT NOT NULL DEFAULT 'anonymous',
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  version       INTEGER NOT NULL DEFAULT 1,
  hide_workflow INTEGER NOT NULL DEFAULT 0,
  nsfw          INTEGER NOT NULL DEFAULT 0,
  hosted_only   INTEGER NOT NULL DEFAULT 0,  -- P5: run only on hosted fleet
  pricing_json  TEXT,                        -- P5: {per_gen, currency, ...}
  star_count    INTEGER NOT NULL DEFAULT 0,
  run_count     INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,  -- moderation takedown
  created_at    INTEGER,                     -- unix seconds (NULL on legacy upsert)
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stars (
  app_id     TEXT NOT NULL REFERENCES apps(id),
  user_key   TEXT NOT NULL,                  -- sha256(client star key)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_key)
);

-- One counted run per app per marker per day (popularity signal, not billing).
CREATE TABLE IF NOT EXISTS run_marks (
  app_id TEXT NOT NULL REFERENCES apps(id),
  marker TEXT NOT NULL,                      -- sha256(star key or IP)
  day    TEXT NOT NULL,                      -- YYYY-MM-DD
  PRIMARY KEY (app_id, marker, day)
);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id     TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
