-- Season types for dynamic pricing: 'season' (peak / high season), 'off_season' (low season), 'special' (holidays,
-- festivals, events such as Christmas, New Year, Onam). When dates overlap, special beats season beats off-season.
-- net_rate / staff_rate: B2B cost and internal staff rate for the same season (filled from rate sheets).
ALTER TABLE season_rates ADD COLUMN kind TEXT NOT NULL DEFAULT 'season';
ALTER TABLE season_rates ADD COLUMN net_rate INTEGER;
ALTER TABLE season_rates ADD COLUMN staff_rate INTEGER;
