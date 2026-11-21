-- Door / gate coordinator check-in:
-- 1. Track when each registered participant was let in at the door (independent of app sign-in).
-- 2. Allow 'gate' staff sessions alongside 'attendee', 'admin' and 'screen'.

ALTER TABLE participants ADD COLUMN gate_entered_at INTEGER;

CREATE TABLE sessions_new (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('attendee', 'admin', 'screen', 'gate')),
  attendee_id INTEGER REFERENCES attendees(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

INSERT INTO sessions_new (token_hash, kind, attendee_id, created_at, expires_at)
  SELECT token_hash, kind, attendee_id, created_at, expires_at FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_attendee ON sessions(attendee_id);
