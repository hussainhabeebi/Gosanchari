-- Booking confirmation vouchers. After the guest pays an advance, staff send a voucher for admin approval;
-- the approved voucher ("Booking Confirmed") is frozen as a JSON snapshot so it never changes afterwards.
CREATE TABLE booking_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  kids_ages TEXT NOT NULL DEFAULT '',
  staff_remarks TEXT NOT NULL DEFAULT '',
  admin_remarks TEXT NOT NULL DEFAULT '',
  reject_reason TEXT,
  snapshot TEXT,
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE INDEX idx_voucher_status ON booking_vouchers(status, created_at);
CREATE INDEX idx_voucher_requester ON booking_vouchers(requested_by, created_at);
CREATE INDEX idx_voucher_booking ON booking_vouchers(booking_id);
