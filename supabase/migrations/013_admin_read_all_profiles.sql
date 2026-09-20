-- ── Migration 013: Allow admins to read all user_profiles ──────────────
-- RLS previously restricted user_profiles to "own row only", which meant
-- the admin panel only ever saw the admin's own record.
--
-- Using a SECURITY DEFINER function to avoid RLS infinite recursion when
-- a policy on user_profiles references user_profiles.

CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_admin FROM user_profiles WHERE user_id = auth.uid()),
    false
  );
$$;

CREATE POLICY "Admins read all profiles" ON user_profiles
  FOR SELECT
  USING (public.is_current_user_admin());

CREATE POLICY "Admins update all profiles" ON user_profiles
  FOR UPDATE
  USING (public.is_current_user_admin());
