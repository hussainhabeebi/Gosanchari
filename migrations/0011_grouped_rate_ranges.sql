-- Several date ranges sharing one set of rates (e.g. Season: 1–20 Jan, 20–22 Mar, 14–31 Aug), and recurring weekday rates.
-- Additive only: existing rows keep NULL in both columns and price exactly as before.
-- rate_group_key: rows (one per date range × meal plan) entered together as one rate table share this key.
-- applicable_weekdays: nights the row applies to, as JS weekday numbers of the night ("6" = Saturday nights,
--   "5,6" = Friday and Saturday nights); NULL = every night in the date range.
ALTER TABLE season_rates ADD COLUMN rate_group_key TEXT;
ALTER TABLE season_rates ADD COLUMN applicable_weekdays TEXT;
CREATE INDEX idx_season_group ON season_rates(property_id, rate_group_key);
