-- Migration: 20260813000012_fix_engagement_logs_nullable.sql
-- Allow nullable columns for lightweight telemetry logs that don't include classification.

-- Drop existing constraints by recreating the table
ALTER TABLE engagement_logs DROP CONSTRAINT IF EXISTS engagement_logs_material_id_fkey;

-- Make columns nullable for telemetry-only logs
ALTER TABLE engagement_logs ALTER COLUMN material_id DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN engagement_class DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN engagement_label DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN comprehension_class DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN comprehension_label DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN course_id DROP NOT NULL;

-- Re-add foreign key for material_id (nullable)
ALTER TABLE engagement_logs
    ADD CONSTRAINT engagement_logs_material_id_fkey
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE;
