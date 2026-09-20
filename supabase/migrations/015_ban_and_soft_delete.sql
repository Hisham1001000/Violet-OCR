-- Admin ban + soft-delete columns for user_profiles.
--
-- is_banned    — true blocks login (middleware check) but keeps data intact
-- is_deleted   — true marks account as removed; middleware blocks login + hides data
-- deleted_at   — timestamp of soft delete (for audit / potential restore)

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS is_banned  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS user_profiles_is_banned_idx  ON user_profiles (is_banned)  WHERE is_banned  = TRUE;
CREATE INDEX IF NOT EXISTS user_profiles_is_deleted_idx ON user_profiles (is_deleted) WHERE is_deleted = TRUE;
