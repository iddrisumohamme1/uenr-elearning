-- Migration: 20260813000018_recommendation_notifications.sql
-- Stores per-student resource recommendations that were generated automatically
-- after a low quiz score. Rows act as notifications: the sidebar shows an
-- unread badge on the Recommendations link until the student views them.

CREATE TABLE IF NOT EXISTS recommendation_notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    submission_id UUID REFERENCES quiz_submissions(id) ON DELETE SET NULL,
    score NUMERIC,
    weak_concept TEXT,
    resource_id UUID REFERENCES study_resources(id) ON DELETE SET NULL,
    resource_title TEXT NOT NULL,
    resource_url TEXT,
    resource_source TEXT,
    resource_type TEXT,
    resource_description TEXT,
    reason TEXT,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rec_notif_student ON recommendation_notifications(student_id, is_read);

ALTER TABLE recommendation_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_view_own_rec_notif" ON recommendation_notifications
    FOR SELECT USING (student_id = auth.uid());
CREATE POLICY "students_update_own_rec_notif" ON recommendation_notifications
    FOR UPDATE USING (student_id = auth.uid());
CREATE POLICY "service_role_rec_notif" ON recommendation_notifications
    FOR ALL TO service_role USING (true) WITH CHECK (true);
