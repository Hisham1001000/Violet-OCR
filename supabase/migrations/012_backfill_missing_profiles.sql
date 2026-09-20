-- ── Migration 012: Backfill user_profiles for any auth.users missing one ────
-- Some users (especially from Google OAuth) signed up without getting a
-- profile row, so they don't appear in the admin panel.
-- This inserts profiles for anyone missing, using defaults.

INSERT INTO user_profiles (user_id, email, full_name)
SELECT
  u.id,
  u.email,
  COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name')
FROM auth.users u
LEFT JOIN user_profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;
