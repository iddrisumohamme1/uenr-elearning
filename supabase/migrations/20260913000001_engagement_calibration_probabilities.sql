-- Migration: 20260913000001_engagement_calibration_probabilities.sql
-- Adds: raw Two-Tower softmax outputs alongside the platform-calibrated
--       engagement class, so callers can see the model's uncertainty instead
--       of treating the stored At-Risk/Moderate/Highly-Engaged label as exact.

ALTER TABLE engagement_logs
    ADD COLUMN IF NOT EXISTS engagement_probabilities JSONB;
ALTER TABLE engagement_logs
    ADD COLUMN IF NOT EXISTS comprehension_probabilities JSONB;