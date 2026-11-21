-- Staff-reported evidence metadata, scoped to one quotation option.
-- Does not create payments, verify funds, backfill statuses or alter saved amounts.
ALTER TABLE quotation_options ADD COLUMN advance_details TEXT NOT NULL DEFAULT '{}'
 CHECK(json_valid(advance_details));
