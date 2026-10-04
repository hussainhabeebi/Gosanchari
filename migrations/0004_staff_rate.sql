-- Three-tier room pricing:
--   rooms.net_rate   = B2B / net rate from the resort (management only, already existed)
--   rooms.staff_rate = internal benchmark rate management gives staff (new)
--   rooms.base_rate / weekend_rate = guest rate / selling price on the website (already existed)
-- quotation_options.guest_rate = per-night selling price a staff member quotes (null = website price by rate rules).
ALTER TABLE rooms ADD COLUMN staff_rate INTEGER;
ALTER TABLE quotation_options ADD COLUMN guest_rate INTEGER;
