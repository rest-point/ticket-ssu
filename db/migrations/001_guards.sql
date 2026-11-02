CREATE TRIGGER inventory_venue BEFORE INSERT ON inventory BEGIN
  SELECT CASE WHEN (SELECT venue_id FROM performances WHERE id=NEW.performance_id) IS NOT
                   (SELECT venue_id FROM physical_seats WHERE id=NEW.physical_seat_id)
    THEN RAISE(ABORT,'inventory venue mismatch') END;
END;
CREATE TRIGGER inventory_identity BEFORE UPDATE OF id,performance_id,physical_seat_id ON inventory
WHEN NEW.id IS NOT OLD.id OR NEW.performance_id IS NOT OLD.performance_id OR NEW.physical_seat_id IS NOT OLD.physical_seat_id
BEGIN SELECT RAISE(ABORT,'inventory identity immutable'); END;
CREATE TRIGGER performance_identity BEFORE UPDATE OF id,concert_id,venue_id ON performances
WHEN (NEW.id IS NOT OLD.id OR NEW.concert_id IS NOT OLD.concert_id OR NEW.venue_id IS NOT OLD.venue_id)
 AND EXISTS(SELECT 1 FROM inventory WHERE performance_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'performance identity immutable'); END;
CREATE TRIGGER physical_identity BEFORE UPDATE OF id,venue_id,seat_code,row_label,number ON physical_seats
WHEN (NEW.id IS NOT OLD.id OR NEW.venue_id IS NOT OLD.venue_id OR NEW.seat_code IS NOT OLD.seat_code OR NEW.row_label IS NOT OLD.row_label OR NEW.number IS NOT OLD.number)
 AND EXISTS(SELECT 1 FROM inventory WHERE physical_seat_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'physical seat identity immutable'); END;
CREATE TRIGGER inventory_occupied_update BEFORE UPDATE OF blocked,grade,price ON inventory
WHEN (NEW.blocked IS NOT OLD.blocked OR NEW.grade IS NOT OLD.grade OR NEW.price IS NOT OLD.price)
 AND (EXISTS(SELECT 1 FROM current_holds WHERE inventory_id=OLD.id) OR EXISTS(SELECT 1 FROM current_bookings WHERE inventory_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'occupied inventory immutable'); END;

CREATE TRIGGER current_hold_insert BEFORE INSERT ON current_holds BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM holds h JOIN inventory i ON i.id=NEW.inventory_id
    WHERE h.id=NEW.hold_id AND h.performance_id=i.performance_id AND h.status='active' AND i.blocked=0)
    OR EXISTS(SELECT 1 FROM current_bookings WHERE inventory_id=NEW.inventory_id)
    THEN RAISE(ABORT,'invalid current hold') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM current_holds WHERE hold_id=NEW.hold_id)>=4
    THEN RAISE(ABORT,'hold ticket limit') END;
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id JOIN holds h ON h.id=b.hold_id
    JOIN holds n ON n.id=NEW.hold_id WHERE h.user_id=n.user_id AND h.performance_id=n.performance_id AND b.status='confirmed'
  ) + (
    SELECT COUNT(*) FROM current_holds ch JOIN holds h ON h.id=ch.hold_id JOIN holds n ON n.id=NEW.hold_id
    WHERE h.user_id=n.user_id AND h.performance_id=n.performance_id
  )>=4 THEN RAISE(ABORT,'user ticket limit') END;
END;
CREATE TRIGGER current_hold_update BEFORE UPDATE ON current_holds
BEGIN SELECT RAISE(ABORT,'replace current hold using delete/insert'); END;
CREATE TRIGGER current_booking_insert BEFORE INSERT ON current_bookings BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM bookings b JOIN inventory i ON i.id=NEW.inventory_id
    WHERE b.id=NEW.booking_id AND b.status='confirmed' AND i.blocked=0)
    OR EXISTS(SELECT 1 FROM current_holds WHERE inventory_id=NEW.inventory_id)
    THEN RAISE(ABORT,'invalid current booking') END;
END;
CREATE TRIGGER current_booking_update BEFORE UPDATE ON current_bookings
BEGIN SELECT RAISE(ABORT,'replace current booking using delete/insert'); END;

CREATE TRIGGER hold_identity BEFORE UPDATE OF id,user_id,performance_id,expires_at ON holds
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.performance_id IS NOT OLD.performance_id OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'hold identity/expiry immutable'); END;
CREATE TRIGGER hold_transition BEFORE UPDATE OF status ON holds
WHEN NEW.status IS NOT OLD.status BEGIN
  SELECT CASE WHEN OLD.status!='active' OR NEW.status='active' OR EXISTS(SELECT 1 FROM current_holds WHERE hold_id=OLD.id)
    THEN RAISE(ABORT,'invalid hold transition') END;
END;
CREATE TRIGGER hold_delete BEFORE DELETE ON holds
BEGIN SELECT RAISE(ABORT,'hold history immutable'); END;
CREATE TRIGGER booking_insert BEFORE INSERT ON bookings BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM holds WHERE id=NEW.hold_id AND status='converted')
    THEN RAISE(ABORT,'booking requires converted hold') END;
END;
CREATE TRIGGER booking_immutable BEFORE UPDATE ON bookings
WHEN NEW.id IS NOT OLD.id OR NEW.hold_id IS NOT OLD.hold_id OR NEW.fee IS NOT OLD.fee OR NEW.buyer_name IS NOT OLD.buyer_name
 OR NEW.buyer_phone IS NOT OLD.buyer_phone OR NEW.delivery IS NOT OLD.delivery OR NEW.created_at IS NOT OLD.created_at
 OR NOT(OLD.status='confirmed' AND NEW.status='cancelled')
 OR EXISTS(SELECT 1 FROM current_bookings WHERE booking_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'invalid booking mutation'); END;
CREATE TRIGGER booking_delete BEFORE DELETE ON bookings
BEGIN SELECT RAISE(ABORT,'booking history immutable'); END;
CREATE TRIGGER item_insert BEFORE INSERT ON booking_items BEGIN
  SELECT CASE WHEN (SELECT h.performance_id FROM bookings b JOIN holds h ON h.id=b.hold_id WHERE b.id=NEW.booking_id)
    IS NOT (SELECT performance_id FROM inventory WHERE id=NEW.inventory_id)
    THEN RAISE(ABORT,'booking item performance mismatch') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM booking_items WHERE booking_id=NEW.booking_id)>=4
    THEN RAISE(ABORT,'booking ticket limit') END;
END;
CREATE TRIGGER item_update BEFORE UPDATE ON booking_items
BEGIN SELECT RAISE(ABORT,'booking item immutable'); END;
CREATE TRIGGER item_delete BEFORE DELETE ON booking_items
BEGIN SELECT RAISE(ABORT,'booking item history immutable'); END;
CREATE TRIGGER payment_insert BEFORE INSERT ON payment_attempts WHEN NEW.result='succeeded' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM booking_totals WHERE id=NEW.booking_id AND hold_id=NEW.hold_id AND total=NEW.amount AND ticket_count BETWEEN 1 AND 4)
    THEN RAISE(ABORT,'payment amount mismatch') END;
END;
CREATE TRIGGER payment_update BEFORE UPDATE ON payment_attempts
BEGIN SELECT RAISE(ABORT,'payment immutable'); END;
CREATE TRIGGER payment_delete BEFORE DELETE ON payment_attempts
BEGIN SELECT RAISE(ABORT,'payment history immutable'); END;
CREATE TRIGGER audit_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT,'audit immutable'); END;
CREATE TRIGGER audit_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT,'audit history immutable'); END;
CREATE TRIGGER legacy_import_update BEFORE UPDATE ON legacy_booking_imports
BEGIN SELECT RAISE(ABORT,'import provenance immutable'); END;
CREATE TRIGGER legacy_import_delete BEFORE DELETE ON legacy_booking_imports
BEGIN SELECT RAISE(ABORT,'import provenance immutable'); END;
