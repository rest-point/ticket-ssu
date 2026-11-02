-- Target schema only. The legacy Store is not switched to this schema yet.
-- Run through db/model.mjs: foreign_keys=ON, WAL, busy_timeout=5000.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  email TEXT NOT NULL UNIQUE CHECK(email=lower(trim(email)) AND length(email) BETWEEN 3 AND 254 AND instr(email,'@')>1),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 40),
  phone TEXT NOT NULL CHECK(length(phone) IN (10,11) AND substr(phone,1,2)='01' AND substr(phone,3,1) IN ('0','1','6','7','8','9') AND phone NOT GLOB '*[^0-9]*'),
  password_hash TEXT NOT NULL CHECK(length(password_hash)=161 AND substr(password_hash,33,1)=':' AND substr(password_hash,1,32) NOT GLOB '*[^0-9a-f]*' AND substr(password_hash,34) NOT GLOB '*[^0-9a-f]*'),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  csrf TEXT NOT NULL CHECK(length(csrf)=48 AND csrf NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE venues (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  region TEXT CHECK(region IS NULL OR length(trim(region)) BETWEEN 1 AND 40)
) STRICT;
CREATE TABLE physical_seats (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  seat_code TEXT NOT NULL CHECK(length(trim(seat_code)) BETWEEN 1 AND 32),
  row_label TEXT NOT NULL CHECK(length(trim(row_label)) BETWEEN 1 AND 16),
  number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 9999),
  UNIQUE(venue_id,seat_code), UNIQUE(venue_id,row_label,number)
) STRICT;
CREATE TABLE concerts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
  artist TEXT NOT NULL CHECK(length(trim(artist)) BETWEEN 1 AND 120),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 2000),
  theme TEXT NOT NULL CHECK(theme IN ('teal','purple','orange','blue')),
  duration INTEGER NOT NULL CHECK(duration BETWEEN 1 AND 9007199254740991),
  age TEXT NOT NULL CHECK(length(trim(age)) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE performances (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  concert_id TEXT NOT NULL REFERENCES concerts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  starts_at INTEGER NOT NULL CHECK(starts_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE inventory (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  physical_seat_id TEXT NOT NULL REFERENCES physical_seats(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  grade TEXT NOT NULL CHECK(grade IN ('VIP','R','S')),
  price INTEGER NOT NULL CHECK(price BETWEEN 1000 AND 1040000),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  UNIQUE(performance_id,physical_seat_id)
) STRICT;
CREATE TABLE holds (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('active','expired','released','converted'))
) STRICT;
CREATE TABLE bookings (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled')),
  fee INTEGER NOT NULL CHECK(fee BETWEEN 2000 AND 8000 AND fee%2000=0),
  buyer_name TEXT NOT NULL CHECK(length(trim(buyer_name)) BETWEEN 2 AND 40),
  buyer_phone TEXT NOT NULL CHECK(length(buyer_phone) IN (10,11) AND substr(buyer_phone,1,2)='01' AND substr(buyer_phone,3,1) IN ('0','1','6','7','8','9') AND buyer_phone NOT GLOB '*[^0-9]*'),
  delivery TEXT NOT NULL CHECK(delivery IN ('mobile','onsite')),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  cancelled_at INTEGER CHECK(cancelled_at BETWEEN 0 AND 9007199254740991),
  CHECK((status='confirmed' AND cancelled_at IS NULL) OR (status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_at>=created_at)),
  UNIQUE(id,hold_id)
) STRICT;
CREATE TABLE booking_items (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  grade_snapshot TEXT NOT NULL CHECK(grade_snapshot IN ('VIP','R','S')),
  price_snapshot INTEGER NOT NULL CHECK(price_snapshot BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(booking_id,inventory_id)
) STRICT;
CREATE TABLE current_holds (
  inventory_id TEXT PRIMARY KEY NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  hold_id TEXT NOT NULL REFERENCES holds(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;
CREATE TABLE current_bookings (
  inventory_id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL,
  FOREIGN KEY(booking_id,inventory_id) REFERENCES booking_items(booking_id,inventory_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;
CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),
  hold_id TEXT NOT NULL REFERENCES holds(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  request_key TEXT NOT NULL CHECK(length(trim(request_key)) BETWEEN 1 AND 128),
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64 AND body_hash NOT GLOB '*[^0-9a-f]*'),
  result TEXT NOT NULL CHECK(result IN ('succeeded','failed')),
  amount INTEGER CHECK(amount BETWEEN 0 AND 9007199254740991),
  booking_id TEXT,
  failure_code TEXT CHECK(length(trim(failure_code)) BETWEEN 1 AND 64),
  attempted_at INTEGER NOT NULL CHECK(attempted_at BETWEEN 0 AND 9007199254740991),
  UNIQUE(hold_id,request_key),
  FOREIGN KEY(booking_id,hold_id) REFERENCES bookings(id,hold_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK((result='succeeded' AND booking_id IS NOT NULL AND amount IS NOT NULL AND failure_code IS NULL) OR
        (result='failed' AND booking_id IS NULL AND failure_code IS NOT NULL))
) STRICT;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY CHECK(id>0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('block','unblock','create-concert')),
  detail TEXT NOT NULL CHECK(json_valid(detail)),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991)
) STRICT;
-- Technical provenance only: no fabricated historical payment attempts.
CREATE TABLE legacy_booking_imports (
  booking_id TEXT PRIMARY KEY NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE UNIQUE INDEX one_active_hold ON holds(user_id,performance_id) WHERE status='active';
CREATE UNIQUE INDEX one_successful_payment ON payment_attempts(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX performances_concert_start ON performances(concert_id,starts_at);
CREATE INDEX performances_venue ON performances(venue_id);
CREATE INDEX inventory_physical ON inventory(physical_seat_id);
CREATE INDEX holds_user_performance ON holds(user_id,performance_id);
CREATE INDEX holds_performance ON holds(performance_id);
CREATE INDEX holds_expiry ON holds(expires_at) WHERE status='active';
CREATE INDEX booking_items_inventory ON booking_items(inventory_id,booking_id);
CREATE INDEX current_holds_hold ON current_holds(hold_id,inventory_id);
CREATE INDEX current_bookings_booking ON current_bookings(booking_id,inventory_id);
CREATE INDEX audit_user ON audit_events(user_id);

CREATE VIEW booking_totals AS
SELECT b.*,h.user_id,h.performance_id,COUNT(i.inventory_id) AS ticket_count,
       SUM(i.price_snapshot) AS ticket_total,SUM(i.price_snapshot)+b.fee AS total
FROM bookings b JOIN holds h ON h.id=b.hold_id
LEFT JOIN booking_items i ON i.booking_id=b.id GROUP BY b.id;
