-- Migration: 20260901000001_courses_level_semester.sql
-- Adds an academic level (100/200/300/400) and semester label (e.g. "First")
-- to courses so the catalogue can be browsed by level then semester.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS level INTEGER;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS semester TEXT;

CREATE INDEX IF NOT EXISTS idx_courses_level_semester
    ON courses(level, semester);
