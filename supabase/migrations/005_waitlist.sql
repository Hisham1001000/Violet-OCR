-- ── Migration 005: Waitlist + manual upgrade support ──────────────────────────

-- Extend user_profiles FIRST (policies below reference these columns)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_admin   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS full_name  TEXT;

-- Waitlist: users who want to upgrade but payment isn't live yet
CREATE TABLE IF NOT EXISTS waitlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  contacted   BOOLEAN NOT NULL DEFAULT false,   -- admin marked as reached out
  upgraded    BOOLEAN NOT NULL DEFAULT false    -- admin manually upgraded this user
);

CREATE INDEX IF NOT EXISTS waitlist_email_idx ON waitlist(email);
CREATE INDEX IF NOT EXISTS waitlist_user_id_idx ON waitlist(user_id);

-- RLS: users can insert their own entry and read it; admins can read/update all
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert own waitlist entry" ON waitlist
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users read own waitlist entry" ON waitlist
  FOR SELECT USING (user_id = auth.uid());

-- Admins (is_admin = true in user_profiles) can read and update all entries
CREATE POLICY "Admins full access waitlist" ON waitlist
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND is_admin = true
    )
  );

