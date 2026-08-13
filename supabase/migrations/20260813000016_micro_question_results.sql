-- Migration: 20260813000016_micro_question_results.sql
-- Persists micro-question comprehension-check results so lecturers can
-- review student performance per material/topic.

CREATE TABLE IF NOT EXISTS micro_question_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID,
    material_id UUID REFERENCES materials(id) ON DELETE CASCADE,
    session_id TEXT,
    topic TEXT,
    difficulty TEXT,
    source TEXT,
    total INTEGER,
    correct INTEGER,
    score FLOAT,
    engagement_class INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mq_results_student ON micro_question_results(student_id);
CREATE INDEX IF NOT EXISTS idx_mq_results_material ON micro_question_results(material_id);
CREATE INDEX IF NOT EXISTS idx_mq_results_created ON micro_question_results(created_at DESC);

-- Row Level Security
ALTER TABLE micro_question_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_view_own_mq_results" ON micro_question_results
    FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "service_role_full_access_mq" ON micro_question_results
    FOR ALL TO service_role USING (true) WITH CHECK (true);
