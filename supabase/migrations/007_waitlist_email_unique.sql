-- Migration 007: Add unique constraint on waitlist.email
-- Prevents duplicate registrations at the database level

-- Step 1: Remove duplicate rows, keeping the earliest entry per email
DELETE FROM waitlist
WHERE id NOT IN (
  SELECT DISTINCT ON (email) id
  FROM waitlist
  ORDER BY email, created_at ASC
);

-- Step 2: Add unique constraint so no future duplicates can be inserted
ALTER TABLE waitlist
  ADD CONSTRAINT waitlist_email_unique UNIQUE (email);
