-- ── Migration 006: Admin tables + policies ─────────────────────────────────

-- ── 1. Add email column to user_profiles (needed for admin user listing) ────
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email TEXT;

-- Update handle_new_user trigger to also store email
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (user_id, email)
    VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Back-fill email for any existing users who already have profiles
UPDATE user_profiles up
SET email = u.email
FROM auth.users u
WHERE up.user_id = u.id AND up.email IS NULL;

-- ── 2. Audit Logs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  actor_email TEXT,
  action      TEXT NOT NULL,   -- e.g. 'user.plan_changed', 'document.deleted'
  target_type TEXT,            -- 'user', 'document', 'setting', 'waitlist'
  target_id   TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx   ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage audit logs" ON audit_logs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_admin = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_admin = true)
  );

-- ── 3. System Settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users ON DELETE SET NULL
);

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage settings" ON system_settings
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_admin = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_admin = true)
  );

-- Seed default settings
INSERT INTO system_settings (key, value, description) VALUES
  ('plan_prices',  '{"free": 0, "starter": 19, "pro": 49}',          'Plan prices in USD'),
  ('plan_limits',  '{"free": 20, "starter": 200, "pro": 1000}',       'Pages per month per plan'),
  ('features',     '{"api_access": false, "priority_queue": false}',  'Global feature flags')
ON CONFLICT (key) DO NOTHING;

-- ── 4. Admin policies on document_jobs ──────────────────────────────────────
DO $$ BEGIN
  CREATE POLICY "Admins see all jobs" ON document_jobs
    FOR ALL USING (
      EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_admin = true)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins see all pages" ON document_pages
    FOR ALL USING (
      EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_admin = true)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
