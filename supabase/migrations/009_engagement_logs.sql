-- Migration: 009_engagement_logs.sql
-- Stores Two-Tower Neural Network classification results.
-- Student Tower (9 features) + Interaction Tower (6 features) → dual-head output.

-- Drop the older table if it exists (e.g. missing comprehension_class or engagement_class)
DROP TABLE IF EXISTS engagement_logs CASCADE;

CREATE TABLE engagement_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id  UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,

    -- ── Interaction Tower Features (Objective 1 — behavioural telemetry) ──────
    failures   NUMERIC NOT NULL DEFAULT 0,   -- Past course failures
    absences   NUMERIC NOT NULL DEFAULT 0,   -- Attendance absences
    "G1"       NUMERIC NOT NULL DEFAULT 10,  -- First period quiz score
    "G2"       NUMERIC NOT NULL DEFAULT 10,  -- Mid-term quiz score
    "G3"       NUMERIC NOT NULL DEFAULT 10,  -- Final assessment score
    freetime   NUMERIC NOT NULL DEFAULT 3,   -- Free time after school (1-5)

    -- ── Two-Tower Output: Engagement Head ────────────────────────────────────
    engagement_class  SMALLINT NOT NULL CHECK (engagement_class  IN (0,1,2)),
    engagement_label  TEXT     NOT NULL,

    -- ── Two-Tower Output: Comprehension Head ─────────────────────────────────
    comprehension_class SMALLINT NOT NULL CHECK (comprehension_class IN (0,1,2)),
    comprehension_label TEXT     NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast dashboard queries
CREATE INDEX IF NOT EXISTS idx_engagement_student    ON engagement_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_engagement_course     ON engagement_logs(course_id);
CREATE INDEX IF NOT EXISTS idx_engagement_class      ON engagement_logs(engagement_class);
CREATE INDEX IF NOT EXISTS idx_comprehension_class   ON engagement_logs(comprehension_class);
CREATE INDEX IF NOT EXISTS idx_engagement_created    ON engagement_logs(created_at DESC);

-- Row Level Security
ALTER TABLE engagement_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_view_own_logs" ON engagement_logs
    FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "service_role_full_access" ON engagement_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE engagement_logs IS
    'Two-Tower Neural Network classification output. '
    'Each row is one inference: engagement class (0=At-Risk, 1=Moderate, 2=Highly Engaged) '
    'and comprehension class (0=Low, 1=Moderate, 2=Good).';
