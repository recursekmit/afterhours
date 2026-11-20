-- Student-ID login (spec 4.1): the roster of registered participants.
--
-- A participant signs in by scanning their college ID card. Behind the scenes
-- each participant owns one synthetic kit (kind = 'roster', id = their roll),
-- created when they are added. That kit is what the phone binds to and what the
-- attendee row points at, so everything downstream (points, stickers, stalls,
-- trails, per-kit slip words, leaderboard) works unchanged: an ID sign-in makes
-- a normal attendee. Roster kits have no usable password and never show in the
-- kits panel; printed entry kits are kind = 'card'.

ALTER TABLE kits ADD COLUMN kind TEXT NOT NULL DEFAULT 'card' CHECK (kind IN ('card', 'roster'));

CREATE TABLE participants (
  id         INTEGER PRIMARY KEY,
  roll       TEXT NOT NULL UNIQUE,                 -- normalised: 26BD1A055W
  name       TEXT NOT NULL,
  year       TEXT,
  section    TEXT,
  phone      TEXT,
  email      TEXT,
  note       TEXT NOT NULL DEFAULT '',             -- for the desk: duplicate rolls, test entries
  source     TEXT NOT NULL DEFAULT 'import' CHECK (source IN ('import', 'walkin')),
  kit_id     TEXT NOT NULL UNIQUE REFERENCES kits(id),
  created_at INTEGER NOT NULL
);
