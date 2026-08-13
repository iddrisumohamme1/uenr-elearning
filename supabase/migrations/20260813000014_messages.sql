-- Migration: 20260813000014_messages.sql
-- Direct messaging between lecturers and students based on performance analysis.

CREATE TABLE IF NOT EXISTS messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_course ON messages(course_id);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_messages" ON messages
    FOR SELECT USING (recipient_id = auth.uid() OR sender_id = auth.uid());

CREATE POLICY "lecturers_send_messages" ON messages
    FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "service_role_full_access" ON messages
    FOR ALL TO service_role USING (true) WITH CHECK (true);
