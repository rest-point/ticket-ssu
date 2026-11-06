-- Data-preserving guard revision for model v1. Table layout/user_version unchanged.
DROP TRIGGER booking_immutable;
CREATE TRIGGER booking_immutable BEFORE UPDATE ON bookings
WHEN NOT (
  (NEW.id IS OLD.id AND NEW.hold_id IS OLD.hold_id AND NEW.fee IS OLD.fee
   AND NEW.buyer_name IS OLD.buyer_name AND NEW.buyer_phone IS OLD.buyer_phone
   AND NEW.delivery IS OLD.delivery AND NEW.created_at IS OLD.created_at
   AND OLD.status='confirmed' AND NEW.status='cancelled'
   AND NOT EXISTS(SELECT 1 FROM current_bookings WHERE booking_id=OLD.id))
  OR
  (NEW.id IS OLD.id AND NEW.hold_id IS OLD.hold_id AND NEW.fee IS OLD.fee
   AND NEW.delivery IS OLD.delivery AND NEW.created_at IS OLD.created_at
   AND NEW.status IS OLD.status AND NEW.cancelled_at IS OLD.cancelled_at
   AND NEW.buyer_name='탈퇴회원' AND NEW.buyer_phone='01000000000'
   AND EXISTS(SELECT 1 FROM holds h JOIN users u ON u.id=h.user_id
     WHERE h.id=OLD.hold_id AND u.password_hash=printf('%032d:%0128d',0,0)))
)
BEGIN SELECT RAISE(ABORT,'invalid booking mutation'); END;
