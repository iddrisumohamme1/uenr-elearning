-- Migration: 20260813000011_attendance.sql
-- Stores self-reported attendance logs for students.

CREATE TABLE IF NOT EXISTS attendance_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id  UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
    logged_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure a student can only log attendance once per day per course
    UNIQUE(student_id, course_id, logged_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_course ON attendance_logs(course_id);

ALTER TABLE attendance_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_manage_own_attendance" ON attendance_logs
    FOR ALL USING (student_id = auth.uid());

CREATE POLICY "service_role_full_access" ON attendance_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
