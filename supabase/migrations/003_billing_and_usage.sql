-- ── Migration 003: User profiles, billing, and usage tracking ────────────────

-- User profile: plan, billing status, usage counters
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                  TEXT NOT NULL DEFAULT 'free',          -- 'free' | 'starter' | 'pro'
  stripe_customer_id    TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  subscription_status   TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'inactive' | 'past_due'
  pages_used_this_month INTEGER NOT NULL DEFAULT 0,
  usage_reset_at        TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()) + interval '1 month',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plan page limits (kept in sync with frontend/src/lib/stripe.ts)
-- free=20, starter=200, pro=1000

-- Auto-reset usage counter on new billing period
CREATE OR REPLACE FUNCTION reset_monthly_usage()
RETURNS TRIGGER AS $$
BEGIN
  IF now() >= NEW.usage_reset_at THEN
    NEW.pages_used_this_month := 0;
    NEW.usage_reset_at := date_trunc('month', now()) + interval '1 month';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reset_monthly_usage
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION reset_monthly_usage();

-- Create profile automatically when user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- RLS
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own profile" ON user_profiles
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users update own profile" ON user_profiles
  FOR UPDATE USING (user_id = auth.uid());

-- Service role (webhooks, backend) can do anything — no policy needed with service key

-- Safe increment function called by the pipeline after each OCR job
CREATE OR REPLACE FUNCTION increment_pages_used(p_user_id UUID, p_pages INTEGER)
RETURNS VOID AS $$
BEGIN
  INSERT INTO user_profiles (user_id, pages_used_this_month)
    VALUES (p_user_id, p_pages)
  ON CONFLICT (user_id) DO UPDATE
    SET pages_used_this_month = user_profiles.pages_used_this_month + p_pages,
        updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
