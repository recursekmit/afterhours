-- Player visibility: two console switches, one per event, both OFF until an organiser turns them on.
--   hunt_visible:  "show treasure hunt to players" (trails of kind 'hunt' and 'other')
--   morse_visible: "show morse challenge to players" (trails of kind 'morse': the morse slip)
-- While a switch is off, attendees see nothing of that event and its attendee APIs refuse.
-- A fresh database and the live one (on deploy) both start with both off.
-- (The online Morse ladder keeps its own switch in morse_config.)
CREATE TABLE hunt_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  hunt_visible  INTEGER NOT NULL DEFAULT 0,
  morse_visible INTEGER NOT NULL DEFAULT 0,
  changed_at    INTEGER
);
INSERT INTO hunt_settings (id, hunt_visible, morse_visible) VALUES (1, 0, 0);

-- Unique slips print in all four ticket designs, balanced per slip (20 each for 80) and shuffled from
-- the set, stored per copy so a reprint of the same serial gets the same design. NULL rows (copies made
-- before this migration) are filled the next time the set's copies are synced.
ALTER TABLE hunt_slip_copies ADD COLUMN design TEXT;
