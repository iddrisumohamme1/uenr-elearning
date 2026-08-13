-- Migration: 20260813000021_assessments.sql
-- Dual-path assessment support:
--   1. Tracks material downloads (downloaders get auto-generated assignments).
--   2. Adds grading to assignment submissions (score, letter grade, feedback).
--   3. Marks per-student auto-generated assignments (hidden from the class).
--   4. Allows per-student generated quizzes (full-course quizzes change per attempt).

-- 1. Download tracking ------------------------------------------------------

CREATE TABLE IF NOT EXISTS material_downloads (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id  UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    downloaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_downloads_student ON material_downloads(student_id);
CREATE INDEX IF NOT EXISTS idx_downloads_material ON material_downloads(material_id);

ALTER TABLE material_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_manage_own_downloads" ON material_downloads
    FOR ALL USING (student_id = auth.uid());

CREATE POLICY "service_role_full_access_downloads" ON material_downloads
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Assignments: per-student auto-generated assignments ---------------------

ALTER TABLE assignments
    ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS source_material_id UUID REFERENCES materials(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS questions JSONB;

CREATE INDEX IF NOT EXISTS idx_assignments_auto_student ON assignments(student_id);
CREATE INDEX IF NOT EXISTS idx_assignments_source_material ON assignments(source_material_id);

-- 3. Assignment submissions: grading ----------------------------------------

ALTER TABLE assignment_submissions
    ADD COLUMN IF NOT EXISTS answers JSONB,
    ADD COLUMN IF NOT EXISTS score NUMERIC,
    ADD COLUMN IF NOT EXISTS letter_grade TEXT,
    ADD COLUMN IF NOT EXISTS feedback TEXT,
    ADD COLUMN IF NOT EXISTS graded_at TIMESTAMPTZ;

-- 4. Per-student generated quizzes (full-course per-attempt variation) -------

ALTER TABLE generated_quizzes
    ADD COLUMN IF NOT EXISTS generated_for_student_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_quizzes_generated_for_student ON generated_quizzes(generated_for_student_id);
