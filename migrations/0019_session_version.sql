-- "Log out of all devices": every login session remembers the account's session_version when it was created.
-- Raising the number (admin action or password reset) ends all existing sessions for that account.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
