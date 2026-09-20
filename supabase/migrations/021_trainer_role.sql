-- ── Migration 021: Trainer role ─────────────────────────────────────────────
-- A scoped admin role: can access only the Data Training section of the
-- admin panel (not Users, Documents, Subscriptions, etc.).
--
-- Promotion model: same shape as is_admin — toggle from the user detail page.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS is_trainer BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN user_profiles.is_trainer IS
  'Trainer role: gated access to /admin/training only. Independent of is_admin.';

CREATE INDEX IF NOT EXISTS user_profiles_is_trainer
  ON user_profiles (is_trainer)
  WHERE is_trainer = TRUE;
