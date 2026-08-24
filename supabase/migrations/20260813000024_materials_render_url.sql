-- Migration: 20260813000024_materials_render_url.sql
-- Office documents uploaded to the platform are converted to PDF at upload
-- time (when LibreOffice is available on the host). The converted copy is
-- stored alongside the original and served as the in-app rendering target so
-- materials gain full engagement tracking and text highlighting. NULL means
-- no conversion exists: the frontend falls back to the original file.

ALTER TABLE materials
    ADD COLUMN IF NOT EXISTS render_url TEXT;
