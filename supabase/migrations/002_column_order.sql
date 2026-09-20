-- Migration 002: Add column_order to preserve table column ordering
--
-- PostgreSQL JSONB does not preserve JSON object key order.
-- This column stores the column names in their correct right-to-left order
-- as an explicit text array, separate from the JSONB data.
--
-- Run this in the Supabase SQL Editor:

ALTER TABLE document_jobs
  ADD COLUMN IF NOT EXISTS column_order text[];

-- Index not needed — this column is always read alongside the full row.
