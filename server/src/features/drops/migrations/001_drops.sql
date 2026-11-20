-- Drops: flash drops, their claims, organiser settings and the live feed.
-- config is the full organiser config INCLUDING the secret (code, answer, golden token);
-- only console code and post-close reveals ever read it out.
CREATE TABLE drops_drops (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('code', 'speed', 'golden', 'room')),
  title        TEXT NOT NULL,
  blurb        TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL,
  config       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'live', 'closed', 'cancelled')),
  library      TEXT,
  fire_at      INTEGER,
  fired_at     INTEGER,
  opens_at     INTEGER,
  closes_at    INTEGER,
  closed_at    INTEGER,
  count        INTEGER NOT NULL DEFAULT 0,   -- room: reactions + taps inside the window
  achieved     INTEGER,                      -- room: 1 hit the goal, 0 missed
  created_at   INTEGER NOT NULL
);

-- One live drop at a time, enforced by the database as well as the code.
CREATE UNIQUE INDEX drops_one_live ON drops_drops (status) WHERE status = 'live';
CREATE INDEX drops_scheduled ON drops_drops (status, fire_at);

-- One row per person per drop: the primary key IS the "pays once" rule.
-- rank is set only for right answers, in arrival order (1 = first).
CREATE TABLE drops_claims (
  drop_id     INTEGER NOT NULL REFERENCES drops_drops(id) ON DELETE CASCADE,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  correct     INTEGER NOT NULL DEFAULT 0,
  rank        INTEGER,
  points      INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL,
  PRIMARY KEY (drop_id, attendee_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX drops_claims_rank ON drops_claims (drop_id, rank) WHERE rank IS NOT NULL;

CREATE TABLE drops_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The ticker, persisted so a restart does not blank the strip. Capped by the feature.
CREATE TABLE drops_feed (
  id     TEXT PRIMARY KEY,
  at     INTEGER NOT NULL,
  text   TEXT NOT NULL,
  tone   TEXT NOT NULL,
  icon   TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX drops_feed_at ON drops_feed (at);
