-- Migration: 20260813000019_materials_semester.sql
-- Adds a semester label to learning materials so lecturers can organise
-- weekly content by academic semester (e.g. "2025/2026 - First Semester").

ALTER TABLE materials ADD COLUMN IF NOT EXISTS semester TEXT;

CREATE INDEX IF NOT EXISTS idx_materials_course_semester
    ON materials(course_id, semester);
