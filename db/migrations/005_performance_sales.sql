CREATE TABLE IF NOT EXISTS performance_sales_events (
  performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('open','paused','cancelled')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY (performance_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS performance_cancelled_bookings (
  booking_id TEXT PRIMARY KEY NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  performance_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  FOREIGN KEY (performance_id,revision) REFERENCES performance_sales_events(performance_id,revision) ON DELETE RESTRICT
) STRICT;
