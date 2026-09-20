-- ── Migration 017: Fix admin panel showing NULL names for Google OAuth users ──
-- Two related issues caused users to display incorrectly in the admin panel:
--   (a) The handle_new_user() trigger only read raw_user_meta_data->>'full_name',
--       but Google OAuth stores the user's name under the 'name' key. So new
--       Google sign-ups landed in user_profiles with NULL full_name.
--   (b) Migration 012 only INSERTED missing profiles — it did not UPDATE rows
--       that already existed with NULL full_name. Existing Google users stayed
--       broken.
-- This migration fixes the trigger forward AND repairs existing rows.

-- 1. Recreate handle_new_user with COALESCE(full_name, name) so all OAuth
--    providers are handled. Idempotent on re-run.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (user_id, email, full_name)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name')
    )
  ON CONFLICT (user_id) DO UPDATE
    SET email     = EXCLUDED.email,
        full_name = COALESCE(user_profiles.full_name, EXCLUDED.full_name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_user failed for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Ensure trigger is wired up (no-op if already exists).
DROP TRIGGER IF EXISTS trg_new_user ON auth.users;
CREATE TRIGGER trg_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 3. Backfill: update existing user_profiles whose full_name is NULL or empty
--    by pulling from auth.users.raw_user_meta_data with COALESCE.
UPDATE user_profiles up
SET full_name = COALESCE(
                  u.raw_user_meta_data->>'full_name',
                  u.raw_user_meta_data->>'name'
                )
FROM auth.users u
WHERE up.user_id = u.id
  AND (up.full_name IS NULL OR up.full_name = '')
  AND COALESCE(
        u.raw_user_meta_data->>'full_name',
        u.raw_user_meta_data->>'name'
      ) IS NOT NULL;

-- 4. Backfill: also patch any missing email on user_profiles (safety net).
UPDATE user_profiles up
SET email = u.email
FROM auth.users u
WHERE up.user_id = u.id
  AND (up.email IS NULL OR up.email = '')
  AND u.email IS NOT NULL;
