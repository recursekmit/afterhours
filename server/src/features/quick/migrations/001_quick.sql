-- Quick sessions: what an organiser launched in a hurry, what it created (so it can be ended or undone),
-- and the reusable presets. The underlying polls, drops, rounds and trails stay in their own features.
CREATE TABLE quick_sessions (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,        -- idempotency key: a double press returns the same session
  template    TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'live', 'ended', 'undone')),
  spec        TEXT NOT NULL,               -- JSON: the filled form
  common      TEXT NOT NULL,               -- JSON: speaker label, run of show, announce
  refs        TEXT NOT NULL DEFAULT '{}',  -- JSON: ids of the objects it made in other features
  preset_id   INTEGER,
  created_at  INTEGER NOT NULL,
  live_at     INTEGER,
  ended_at    INTEGER
);
CREATE INDEX quick_sessions_status ON quick_sessions (status, id);

CREATE TABLE quick_presets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  template    TEXT NOT NULL,
  spec        TEXT NOT NULL,
  common      TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
