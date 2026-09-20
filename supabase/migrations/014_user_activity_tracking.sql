-- ── Migration 014: User activity tracking ─────────────────────────────────
-- Adds columns to track last-seen + lifetime login count so the admin panel
-- can show Daily / Weekly active users and total logins.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS login_count   int NOT NULL DEFAULT 0;

-- Fast lookup for "active in last N days" queries.
CREATE INDEX IF NOT EXISTS user_profiles_last_active_idx
  ON user_profiles (last_active_at DESC);

-- RPC called by /api/track-visit — bumps last_active_at and (optionally)
-- increments login_count on fresh logins. SECURITY DEFINER so it bypasses
-- the "own row only" RLS without exposing write access to arbitrary rows.
CREATE OR REPLACE FUNCTION public.track_user_visit(is_login boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  UPDATE user_profiles
  SET last_active_at = now(),
      login_count    = login_count + CASE WHEN is_login THEN 1 ELSE 0 END
  WHERE user_id = auth.uid();
END;
$$;
