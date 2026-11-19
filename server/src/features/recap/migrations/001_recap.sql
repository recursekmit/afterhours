-- One row: when the recap is open.
--   console_open: the organiser's "recap open" switch.
--   reveal_open_at: set (to the reveal's start time) the first time a final leaderboard reveal is seen
--     finished, so the recap stays open even if the board is unfrozen afterwards.
--   dismissed_reveal_at: the console closed the recap after that reveal; do not reopen for the same one.
-- The reveal itself is read from the leaderboard feature, never written.
CREATE TABLE recap_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  console_open        INTEGER NOT NULL DEFAULT 0,
  reveal_open_at      INTEGER,
  dismissed_reveal_at INTEGER,
  changed_at          INTEGER
);
INSERT INTO recap_state (id, console_open) VALUES (1, 0);

-- Sticker slaps per attendee, for the secret "slap happy" sticker. Just a counter, no points.
CREATE TABLE recap_slaps (
  attendee_id INTEGER PRIMARY KEY REFERENCES attendees(id),
  count       INTEGER NOT NULL DEFAULT 0
);
