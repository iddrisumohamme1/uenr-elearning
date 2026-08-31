-- Migration: 20260830000001_feed_interactions.sql
-- Stores the personalization-informed interactions the student makes in the
-- "For You" recommendations feed. These become the behavioral signals the
-- feed ranker uses: opens (+dwell proxy via engagement logs), saves (strong
-- positive), and dismissals (strong negative). Impressions power the
-- exploration slot (UCB-style) by counting how often an item was surfaced.

CREATE TABLE IF NOT EXISTS feed_interactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('material', 'study_resource', 'external')),
    item_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('open', 'save', 'dismiss', 'impression')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feed_interactions_student
    ON feed_interactions(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_interactions_item
    ON feed_interactions(student_id, item_type, item_key);

ALTER TABLE feed_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "students_view_own_feed_interactions" ON feed_interactions
    FOR SELECT USING (student_id = auth.uid());
CREATE POLICY "students_insert_own_feed_interactions" ON feed_interactions
    FOR INSERT WITH CHECK (student_id = auth.uid());
CREATE POLICY "service_role_feed_interactions" ON feed_interactions
    FOR ALL TO service_role USING (true) WITH CHECK (true);