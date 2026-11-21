-- The Cipher Ticket (contract: shared/src/features/cipher.ts). All tables prefixed cipher_.
-- The printed tickets and who claimed them live in hunt (hunt_slip_copies); cipher keeps its own
-- progress keyed by attendee and the claimed copy's id (no foreign key: hunt's tables are not ours).

-- One row: the console's settings (JSON over the defaults) and the "show to players" flag.
CREATE TABLE cipher_config (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  settings TEXT NOT NULL DEFAULT '{}',
  visible  INTEGER NOT NULL DEFAULT 1
);
INSERT INTO cipher_config (id) VALUES (1);

-- A player: one claimed serial (slips I-IV). copy_id is slip I's copy. trial = the trial they are on
-- (1..7, 8 = all sealed).
CREATE TABLE cipher_players (
  attendee_id      INTEGER PRIMARY KEY REFERENCES attendees(id),
  copy_id          INTEGER NOT NULL UNIQUE,
  serial           INTEGER NOT NULL UNIQUE,
  guild            TEXT NOT NULL CHECK (guild IN ('armillary', 'wave', 'ginkgo', 'ruins')),
  claimed_at       INTEGER NOT NULL,
  trial            INTEGER NOT NULL DEFAULT 1,
  trial_started_at INTEGER NOT NULL,
  -- the four winds: when each edge was first read (the claiming scan counts), and the cursed top
  w_bottom         INTEGER,
  w_right          INTEGER,
  w_top            INTEGER,
  w_left           INTEGER,
  cursed           INTEGER NOT NULL DEFAULT 0,
  -- the echo: which edge of slip II to decode and tap (its word is read from the copy, never sent early)
  echo_edge        TEXT,
  echo_tries       INTEGER NOT NULL DEFAULT 0,
  -- the riddle on slip III: 'first' or 'last' alphabetically, its hint and wrong answers
  riddle_rule      TEXT,
  riddle_hint      INTEGER NOT NULL DEFAULT 0,
  riddle_tries     INTEGER NOT NULL DEFAULT 0,
  -- the whisper: hints and wrong guesses (the word itself is in cipher_whispers)
  whisper_hints    INTEGER NOT NULL DEFAULT 0,
  whisper_tries    INTEGER NOT NULL DEFAULT 0,
  -- the pact: in the pool since (null = not waiting)
  pact_since       INTEGER
);
CREATE INDEX cipher_players_trial ON cipher_players(trial);

-- A sealed trial: when, its stars and the points it paid (speed bonus included).
CREATE TABLE cipher_seals (
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  trial       INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  stars       INTEGER NOT NULL,
  points      INTEGER NOT NULL,
  fast        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (attendee_id, trial)
) WITHOUT ROWID;

-- The whisper word of a printed copy. Server only: never sent readable to a phone.
CREATE TABLE cipher_whispers (
  copy_id INTEGER PRIMARY KEY,
  word    TEXT NOT NULL UNIQUE
);

-- A pact: A and B scan each other's ticket. a_edge = the edge of A's ticket B scans; b_edge = the edge
-- of B's ticket (or the Oracle's) A scans. The Oracle: b_id NULL, oracle 1, B's half is always done.
CREATE TABLE cipher_pacts (
  id           INTEGER PRIMARY KEY,
  a_id         INTEGER NOT NULL REFERENCES attendees(id),
  b_id         INTEGER REFERENCES attendees(id),
  oracle       INTEGER NOT NULL DEFAULT 0,
  a_edge       TEXT NOT NULL,
  b_edge       TEXT NOT NULL,
  a_scanned_at INTEGER,
  b_scanned_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sealed', 'broken')),
  created_at   INTEGER NOT NULL,
  sealed_at    INTEGER
);
CREATE INDEX cipher_pacts_a ON cipher_pacts(a_id, status);
CREATE INDEX cipher_pacts_b ON cipher_pacts(b_id, status);

-- The last signal. The word lives here; phones get it only after the reveal.
CREATE TABLE cipher_signals (
  id         INTEGER PRIMARY KEY,
  word       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('warned', 'live', 'closed')),
  warn_at    INTEGER,
  fire_at    INTEGER NOT NULL,
  closes_at  INTEGER,
  revealed   INTEGER NOT NULL DEFAULT 0,
  winner     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE cipher_answers (
  signal_id   INTEGER NOT NULL REFERENCES cipher_signals(id) ON DELETE CASCADE,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  rank        INTEGER NOT NULL,
  points      INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (signal_id, attendee_id)
) WITHOUT ROWID;
