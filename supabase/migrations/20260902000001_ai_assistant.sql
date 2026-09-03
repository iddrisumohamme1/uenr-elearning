-- Migration: 20260902000001_ai_assistant.sql
-- Seeds a dedicated sender for automated AI insight messages.
--
-- The `users.id` column references `auth.users`, so the authenticated user
-- must exist first. That row (id, email, password) is created through the
-- Supabase Auth Admin API, NOT here — this migration only guarantees the
-- matching dashboard profile row exists for the mail sender so inbox messages
-- from the AI assistant resolve to a real sender name.
--
-- Idempotent: re-running is safe.
INSERT INTO users (id, full_name, email, role)
SELECT u.id, 'AI Insight Assistant', u.email, 'lecturer'
FROM auth.users u
WHERE u.email = 'ai-insight@uenr.edu.gh'
ON CONFLICT (email) DO NOTHING;
