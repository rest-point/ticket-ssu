CREATE TABLE IF NOT EXISTS member_booking_restrictions (
  member_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  restricted INTEGER NOT NULL CHECK(restricted IN (0,1)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY (member_id,revision)
) STRICT;
