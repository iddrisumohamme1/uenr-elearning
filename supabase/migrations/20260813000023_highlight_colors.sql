-- Migration: 20260813000023_highlight_colors.sql
-- Adds a color choice to material highlights. Existing rows default to amber,
-- matching the original single-color behaviour.

ALTER TABLE material_highlights
    ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'amber'
    CHECK (color IN ('amber', 'green', 'blue'));
