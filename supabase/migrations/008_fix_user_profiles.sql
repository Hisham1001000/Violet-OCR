-- ── Migration 008: Fix user_profiles missing columns + bulletproof trigger ───
-- Resolves: "Database error saving new user" on signup

-- 1. Add missing columns (safe if they already exist)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email     TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_admin  BOOLEAN NOT NULL DEFAULT false;

-- 2. Recreate handle_new_user with EXCEPTION block so it NEVER blocks signup
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
        full_name = COALESCE(EXCLUDED.full_name, user_profiles.full_name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a profile-creation failure block signup
  RAISE WARNING 'handle_new_user failed for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Ensure trigger exists (no-op if already there)
DROP TRIGGER IF EXISTS trg_new_user ON auth.users;
CREATE TRIGGER trg_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 4. Back-fill full_name + email for existing users
UPDATE user_profiles up
SET
  email     = COALESCE(up.email,     u.email),
  full_name = COALESCE(up.full_name, u.raw_user_meta_data->>'full_name')
FROM auth.users u
WHERE up.user_id = u.id;
