-- Add department to courses for department-scoped access
ALTER TABLE courses
ADD COLUMN IF NOT EXISTS department TEXT;
