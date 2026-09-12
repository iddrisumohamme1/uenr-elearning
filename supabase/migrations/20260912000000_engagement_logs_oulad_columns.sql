-- Migration: 20260912000000_engagement_logs_oulad_columns.sql
-- The Two-Tower model was retrained on OULAD (see ml/OULAD_RETRAIN_PLAN.txt).
-- The classification writers (/classify, /auto-classify, post-submit
-- re-classify) now persist the OULAD interaction feature set instead of the
-- legacy UCI proxy columns (failures/absences/G1/G2/G3/freetime). Those old
-- columns are kept as-is for audit; new writes only populate the OULAD set.
--
-- Interaction feature semantics (built from real platform telemetry):
--   total_activities            Σ time_spent (seconds→minutes)
--   unique_materials            distinct material_id
--   active_days                 distinct day of created_at
--   avg_daily_activity          total / max(active_days, 1)
--   activity_per_registered_day total / max(enrolled days, 1)
--   days_since_last_activity    now − last telemetry day (0 if fresh)
--   assessment_count            distinct graded quizzes + assignments
ALTER TABLE public.engagement_logs
    ADD COLUMN IF NOT EXISTS total_activities NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unique_materials NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS active_days NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_daily_activity NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS activity_per_registered_day NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS days_since_last_activity NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS assessment_count NUMERIC DEFAULT 0;

-- Post-submit re-classification writes a fresh row with no material attached
-- (a student just finished an assessment, not a reading session).
ALTER TABLE public.engagement_logs ALTER COLUMN material_id DROP NOT NULL;

COMMENT ON TABLE public.engagement_logs IS
  'Two-Tower Neural Network classification output (OULAD feature set). '
  'Each row is one inference: engagement class (0=At-Risk, 1=Moderate, 2=Highly Engaged), '
  'comprehension class (0=Low, 1=Moderate, 2=Good), and the 7 interaction features that fed it.';