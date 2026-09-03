-- Migration: 20260902000000_low_confidence.sql
-- Flags Two-Tower classifications built from insufficient signals.
--
-- /auto-classify sets TRUE when fewer than 2 graded assessments (quizzes or
-- assignments) fed the G1/G2/G3 proxy, or when no attendance rows exist at all.
-- UIs can then show "based on limited data" instead of a firm-sounding label.
ALTER TABLE public.engagement_logs ADD COLUMN IF NOT EXISTS low_confidence BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN public.engagement_logs.low_confidence IS
  'True when the classification was built from insufficient signals (fewer than 2 graded assessments, or no attendance data).'