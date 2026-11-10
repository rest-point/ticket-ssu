-- Data-preserving column addition for model v1 and the legacy store.
-- Existing concerts keep NULL (bookable immediately). Table identity/user_version unchanged.
ALTER TABLE concerts ADD COLUMN booking_opens_at INTEGER
  CHECK(booking_opens_at IS NULL OR booking_opens_at BETWEEN 0 AND 9007199254740991);
