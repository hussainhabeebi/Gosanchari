-- The staff dashboard and enquiry lists look up each enquiry's quotations (e.g. the highest view count for
-- lead scoring). Without this index every lookup scanned the whole quotations table, so the page after
-- staff login slowed down as quotations grew. Additive only.
CREATE INDEX IF NOT EXISTS idx_quote_enquiry ON quotations(enquiry_id);
