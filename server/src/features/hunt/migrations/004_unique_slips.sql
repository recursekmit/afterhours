-- Unique slips (docs/SLIPS.md, "unique slips") and the K-of-M trail option.
--
-- 1. Slip sets gain the 'unique' mode. The CHECK lives on the column, so the column is swapped in place
--    (add, copy, drop, rename). The table itself is never dropped, so no ON DELETE CASCADE fires and
--    every slip, reading and find keeps its id (points ledger refs "slip:<reading id>" stay valid).
ALTER TABLE hunt_slip_sets ADD COLUMN mode_v2 TEXT NOT NULL DEFAULT 'shared' CHECK (mode_v2 IN ('shared', 'per_kit', 'unique'));
UPDATE hunt_slip_sets SET mode_v2 = mode;
ALTER TABLE hunt_slip_sets DROP COLUMN mode;
ALTER TABLE hunt_slip_sets RENAME COLUMN mode_v2 TO mode;
-- Unique sets: printed copies of every slip (0 for shared and per-kit sets).
ALTER TABLE hunt_slip_sets ADD COLUMN copies INTEGER NOT NULL DEFAULT 0;

-- One printed copy of one slip. Serial 1..N is printed in the plaque ("no. 037"); copies of slips 1..3
-- with the same serial print on one page so a kit gets a matching trio. The first person whose reading
-- matches this copy claims it; nobody else's readings of it count after that.
CREATE TABLE hunt_slip_copies (
  id         INTEGER PRIMARY KEY,
  slip_id    INTEGER NOT NULL REFERENCES hunt_slips(id) ON DELETE CASCADE,
  serial     INTEGER NOT NULL,
  claimed_by INTEGER,
  claimed_at INTEGER,
  UNIQUE (slip_id, serial)
);
-- One copy per person per slip, enforced by the database too.
CREATE UNIQUE INDEX hunt_slip_copies_claim ON hunt_slip_copies(slip_id, claimed_by) WHERE claimed_by IS NOT NULL;

-- The word each copy carries for each generated reading. `word` is NULL for a derived extra (the copy's
-- top strip read upside down). Morse keys are unique across every unique copy anywhere.
CREATE TABLE hunt_slip_copy_words (
  copy_id    INTEGER NOT NULL REFERENCES hunt_slip_copies(id) ON DELETE CASCADE,
  reading_id INTEGER NOT NULL REFERENCES hunt_slip_readings(id) ON DELETE CASCADE,
  word       TEXT,
  morse      TEXT NOT NULL,
  PRIMARY KEY (copy_id, reading_id)
);
CREATE UNIQUE INDEX hunt_slip_copy_words_morse ON hunt_slip_copy_words(morse);

-- 2. Linear trails: each player gets K of the stops before the finale (0 = all of them).
ALTER TABLE hunt_trails ADD COLUMN subset_k INTEGER NOT NULL DEFAULT 0;
