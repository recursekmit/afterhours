-- Arcade rounds: the puzzle hour (Packet Panic, Patch the Bot, Rebuild the Image), houses and mocktail tokens.
-- Levels themselves are code (levels.ts); these tables hold who played what, when, and for whom.

-- Released rounds, in order. The current round is MAX(round). Never auto-advances: the console releases.
CREATE TABLE arcade_rounds (
  round       INTEGER PRIMARY KEY,
  released_at INTEGER NOT NULL
);

-- The four houses. Names are editable from the console; tone + glyph are fixed so a house is never colour-only.
CREATE TABLE arcade_houses (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  tone  TEXT NOT NULL,
  glyph TEXT NOT NULL
);
INSERT INTO arcade_houses (id, name, tone, glyph) VALUES
  (1, 'tangerine', 'tangerine', 'star'),
  (2, 'lime', 'lime', 'bolt'),
  (3, 'sky', 'sky', 'crown'),
  (4, 'pink', 'pink', 'flame');

-- House membership. Organiser controlled only: there is no attendee route that writes here.
CREATE TABLE arcade_house_members (
  attendee_id INTEGER PRIMARY KEY REFERENCES attendees(id),
  house_id    INTEGER NOT NULL REFERENCES arcade_houses(id),
  assigned_at INTEGER NOT NULL
);
CREATE INDEX arcade_house_members_house ON arcade_house_members(house_id);

-- One row per attempt at a level. `round` is the round current when it started and never changes.
-- `scored` = 1 when a win would pay (the level had not been paid to this person when it started).
-- `house_id` is the player's house at the moment the win paid, so later reassignment never moves points.
CREATE TABLE arcade_attempts (
  id          TEXT PRIMARY KEY,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  level_id    TEXT NOT NULL,
  game        TEXT NOT NULL CHECK (game IN ('packet', 'patch', 'pixels')),
  round       INTEGER NOT NULL,
  scored      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won')),
  tries       INTEGER NOT NULL DEFAULT 0,
  fails       INTEGER NOT NULL DEFAULT 0,
  paid        INTEGER NOT NULL DEFAULT 0,
  house_id    INTEGER,
  hint        TEXT,                              -- JSON Hint once revealed
  started_at  INTEGER NOT NULL,
  last_try_at INTEGER,
  won_at      INTEGER
);
-- At most one open attempt per person per level: reopening the level resumes it.
CREATE UNIQUE INDEX arcade_attempts_open ON arcade_attempts(attendee_id, level_id) WHERE status = 'open';
CREATE INDEX arcade_attempts_level ON arcade_attempts(level_id, status);
CREATE INDEX arcade_attempts_house ON arcade_attempts(house_id, round) WHERE paid > 0;

-- Idempotent tries: the same (attempt, key) always returns the stored response.
CREATE TABLE arcade_tries (
  attempt_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  response   TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, key)
) WITHOUT ROWID;

-- The extra-hint perk: at most one per house per round.
CREATE TABLE arcade_perks (
  house_id   INTEGER NOT NULL REFERENCES arcade_houses(id),
  round      INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (house_id, round)
) WITHOUT ROWID;

-- One perk hint per person per round.
CREATE TABLE arcade_hints (
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  round       INTEGER NOT NULL,
  attempt_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (attendee_id, round)
) WITHOUT ROWID;

-- Mocktail claims made by staff. The key makes a double press or a retried request claim once.
CREATE TABLE arcade_claims (
  key         TEXT PRIMARY KEY,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  tokens      INTEGER NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX arcade_claims_attendee ON arcade_claims(attendee_id);
