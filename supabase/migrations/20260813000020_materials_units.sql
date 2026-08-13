-- Migration: 20260813000020_materials_units.sql
-- Adds an optional unit/part label to learning materials so lecturers can
-- organise whole-semester content into units when they are not teaching week-by-week.

ALTER TABLE materials ADD COLUMN IF NOT EXISTS unit_label TEXT;

CREATE INDEX IF NOT EXISTS idx_materials_course_unit
    ON materials(course_id, unit_label);
