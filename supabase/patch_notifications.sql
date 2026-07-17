-- =========================================================
-- SHEBLOOM PATCH SQL - Run this in your Supabase SQL Editor
-- Fixes: admin_notifications 500 error
-- =========================================================

-- 1. Create admin_notifications table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS public.admin_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL,
    target_id UUID NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS (backend uses service_role key which bypasses RLS)
ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

-- 2. Verify doctor_applications table exists with correct structure
-- (This will fail safely if already correct)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'doctor_applications'
  ) THEN
    RAISE EXCEPTION 'doctor_applications table is MISSING - please run the full migrations.sql first!';
  ELSE
    RAISE NOTICE 'doctor_applications table exists OK';
  END IF;
END $$;

-- 3. Verify users table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'
  ) THEN
    RAISE EXCEPTION 'users table is MISSING - please run the full migrations.sql first!';
  ELSE
    RAISE NOTICE 'users table exists OK';
  END IF;
END $$;

-- 4. Verify community_posts table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'community_posts'
  ) THEN
    RAISE EXCEPTION 'community_posts table is MISSING - please run the full migrations.sql first!';
  ELSE
    RAISE NOTICE 'community_posts table exists OK';
  END IF;
END $$;

-- If you see EXCEPTION above, go to Supabase SQL Editor and run the full:
-- /home/gayathri/shebloom/backend/supabase/migrations.sql
-- then re-run this patch script.
