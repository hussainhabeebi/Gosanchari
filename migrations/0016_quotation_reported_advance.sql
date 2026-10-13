-- Reported funds belong to one quotation option, not a booking/payment receipt.
-- Existing amounts and approval snapshots are untouched; zero is the legacy default.
ALTER TABLE quotation_options ADD COLUMN reported_advance INTEGER NOT NULL DEFAULT 0
 CHECK(typeof(reported_advance) = 'integer' AND reported_advance >= 0 AND reported_advance <= total);
