-- Additive: existing bookings and reviews are unchanged.
CREATE TABLE booking_review_links (
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  otp_hash TEXT,
  otp_expires_at TEXT,
  otp_sent_at TEXT,
  otp_attempts INTEGER NOT NULL DEFAULT 0
);
