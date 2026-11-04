-- One automatic invitation attempt per booking. No guest contact details or tokens.
CREATE TABLE booking_review_deliveries (
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
