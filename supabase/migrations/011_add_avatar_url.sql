-- Migration: 011_add_avatar_url.sql
-- Adds avatar_url column to users table for profile photos.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
