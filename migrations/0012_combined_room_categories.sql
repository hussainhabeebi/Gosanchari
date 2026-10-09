-- Combine room categories in one quotation option (e.g. 4 Standard Non-AC + 2 Standard AC = 6 rooms).
-- Additive only. The option's own room_id / rooms_count stay the first category; further categories are a JSON
-- list [{"room_id": 12, "rooms_count": 2, "guest_rate": null}]. The option's subtotal / taxes / total stay the
-- combined amounts, so every existing total, list and report keeps working.
ALTER TABLE quotation_options ADD COLUMN extra_rooms TEXT NOT NULL DEFAULT '[]';
-- A booking converted from such an option keeps the same list (for display), and its extra rooms are reserved
-- as blocked room-nights linked to the booking (released when the booking is cancelled).
ALTER TABLE bookings ADD COLUMN extra_rooms TEXT NOT NULL DEFAULT '[]';
ALTER TABLE blocked_dates ADD COLUMN booking_id INTEGER;
CREATE INDEX idx_blocked_booking ON blocked_dates(booking_id);
