-- Migration: 20260813000022_material_highlights.sql
-- Adds:
--  1. `highlights` telemetry column on engagement_logs (count of highlights
--     made in a session, feeds the engagement score formula).
--  2. material_highlights table — persistent per-student text highlights on
--     PDF materials (page number + normalized rect boxes + snippet).

-- ── 1. Engagement telemetry: highlights count ────────────────────────────────
ALTER TABLE engagement_logs ADD COLUMN IF NOT EXISTS highlights INTEGER DEFAULT 0;

-- ── 2. Persistent highlights ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_highlights (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL DEFAULT 1,
    -- Normalized boxes relative to the rendered page:
    -- [{ "l": 0-100, "t": 0-100, "w": 0-100, "h": 0-100 }, ...]
    rects JSONB NOT NULL,
    text TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_highlights_material_student
    ON material_highlights(material_id, student_id);
CREATE INDEX IF NOT EXISTS idx_highlights_student ON material_highlights(student_id);

ALTER TABLE material_highlights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_view_own_highlights" ON material_highlights
    FOR SELECT USING (student_id = auth.uid());
CREATE POLICY "students_insert_own_highlights" ON material_highlights
    FOR INSERT WITH CHECK (student_id = auth.uid());
CREATE POLICY "students_delete_own_highlights" ON material_highlights
    FOR DELETE USING (student_id = auth.uid());
CREATE POLICY "service_role_highlights" ON material_highlights
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE material_highlights IS
    'Persistent PDF text highlights per student + material. rects are '
    'percentage boxes relative to the rendered page so they survive '
    'different zoom levels and screen sizes.';
