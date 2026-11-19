-- Stalls and rewards. Spending lives here, never in the points ledger, so the leaderboard
-- keeps ranking lifetime earned points. Everything a person has left (balance, free drinks,
-- stock, per-person limits) is DERIVED from stalls_txn rows with status 'ok', so voiding a
-- row restores all of it at once.

-- Key/value: 'secret' (QR signing key, generated on first use), 'allowance', 'spendLowersBoard'.
CREATE TABLE stalls_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE stalls_stall (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  code       TEXT NOT NULL UNIQUE,            -- the shopkeeper's sign-in PIN
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE stalls_item (
  id         INTEGER PRIMARY KEY,
  stall_id   INTEGER NOT NULL REFERENCES stalls_stall(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price      INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  image      TEXT,                            -- file name in the stall-images folder
  stock      INTEGER CHECK (stock IS NULL OR stock >= 0),   -- NULL = unlimited
  per_person INTEGER CHECK (per_person IS NULL OR per_person >= 1),
  free_drink INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX stalls_item_stall ON stalls_item(stall_id);

-- Shopkeeper sessions (cookie ah_stall). Token stored hashed.
CREATE TABLE stalls_session (
  token_hash TEXT PRIMARY KEY,
  stall_id   INTEGER NOT NULL REFERENCES stalls_stall(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX stalls_session_stall ON stalls_session(stall_id);

-- One row per hand-over. The key makes a double tap or a retry commit once.
CREATE TABLE stalls_txn (
  id           INTEGER PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  attendee_id  INTEGER NOT NULL REFERENCES attendees(id),
  stall_id     INTEGER NOT NULL REFERENCES stalls_stall(id),
  total_points INTEGER NOT NULL,
  free_used    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'void')),
  at           INTEGER NOT NULL,
  voided_at    INTEGER,
  void_reason  TEXT
);
CREATE INDEX stalls_txn_attendee ON stalls_txn(attendee_id, status);
CREATE INDEX stalls_txn_stall ON stalls_txn(stall_id, status);

-- item_name and price are snapshots, so menu edits and deletions never rewrite history.
CREATE TABLE stalls_txn_line (
  id        INTEGER PRIMARY KEY,
  txn_id    INTEGER NOT NULL REFERENCES stalls_txn(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  qty       INTEGER NOT NULL,
  free_qty  INTEGER NOT NULL,
  price     INTEGER NOT NULL,
  points    INTEGER NOT NULL
);
CREATE INDEX stalls_line_txn ON stalls_txn_line(txn_id);
CREATE INDEX stalls_line_item ON stalls_txn_line(item_id);

-- The attendee's basket, attached to their QR so the shopkeeper sees it pre-filled.
CREATE TABLE stalls_cart (
  attendee_id INTEGER PRIMARY KEY REFERENCES attendees(id),
  lines       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
