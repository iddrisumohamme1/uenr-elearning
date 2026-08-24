-- Video watch telemetry on engagement logs (xAPI-inspired):
-- video_watch_seconds = seconds of real playback consumed
-- video_coverage_pct  = unique footage covered, 0-100
alter table public.engagement_logs
    add column if not exists video_watch_seconds numeric not null default 0;

alter table public.engagement_logs
    add column if not exists video_coverage_pct numeric not null default 0;
