-- Migration: 20260813000026_add_user_profile_details.sql
-- Adds optional self-editable profile detail columns to users.
--   date_of_birth : student/lecturer/hod date of birth
--   index_number  : unique student index number (students only; NULL otherwise)
--   staff_id      : unique staff ID (lecturers/hods only; NULL otherwise)
--   phone         : contact phone for any role
--
-- Postgres UNIQUE columns allow multiple NULLs, so the student-only and
-- staff-only uniqueness constraints coexist safely on the single table.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS index_number TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS staff_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS phone TEXT;
