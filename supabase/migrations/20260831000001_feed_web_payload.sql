-- Migration: 20260831000001_feed_web_payload.sql
-- Extends feed_interactions so live web items (YouTube videos, Wikipedia
-- articles) surfaced by the web-first For You feed can be saved for later and
-- restored on the Saved tab even after they leave the feed pool.
--
-- 1. Adds a `payload` JSONB snapshot column. The frontend sends a small
--    snapshot (title, url, thumbnail, channel, reasons...) when the student
--    saves an item; the Saved endpoint re-renders from it directly.
-- 2. Recreates the `action` CHECK to include 'unsave'. The original
--    constraint silently rejected unsave inserts (the frontend already sends
--    them), so saved items could never be removed.

ALTER TABLE feed_interactions
    ADD COLUMN IF NOT EXISTS payload JSONB;

-- Drop and recreate the action check so 'unsave' is accepted. Postgres gives
-- the original inline CHECK this auto-generated name.
ALTER TABLE feed_interactions
    DROP CONSTRAINT IF EXISTS feed_interactions_action_check;
ALTER TABLE feed_interactions
    ADD CONSTRAINT feed_interactions_action_check
    CHECK (action IN ('open', 'save', 'dismiss', 'impression', 'unsave'));