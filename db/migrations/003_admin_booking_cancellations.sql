CREATE TABLE IF NOT EXISTS admin_booking_cancellations (
  booking_id TEXT PRIMARY KEY NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(reason='customer_request'),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
