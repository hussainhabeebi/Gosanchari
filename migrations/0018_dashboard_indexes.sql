-- Indexes for the pages staff and admins land on after logging in (/staff "My day" and /admin Overview).
-- Their counts and lists filter by date or by linked quotation; without these each one read the whole table,
-- so those first pages slowed down as enquiries, quotations and bookings grew. Additive only.
CREATE INDEX IF NOT EXISTS idx_enq_created ON enquiries(created_at);
CREATE INDEX IF NOT EXISTS idx_quote_sent ON quotations(sent_at);
CREATE INDEX IF NOT EXISTS idx_book_created ON bookings(created_at);
CREATE INDEX IF NOT EXISTS idx_book_quotation ON bookings(quotation_id);
