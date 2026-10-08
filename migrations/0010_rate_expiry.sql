-- Season / off-season rate expiry reminders. An admin can mark an expiring rate period as handled
-- (e.g. the resort closes for the off-season) so it stops showing in the reminders.
ALTER TABLE season_rates ADD COLUMN renewal_dismissed_at TEXT;
