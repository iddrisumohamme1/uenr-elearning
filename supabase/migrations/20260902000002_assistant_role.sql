-- Migration: 20260902000002_assistant_role.sql
-- Adds an 'assistant' role for the automated AI Insight Assistant sender.
--
-- The AI assistant must be clearly distinct from human staff: it should never
-- be assignable as a course lecturer or appear in lecturer/HOD department
-- lists. Giving it a dedicated role (instead of re-using 'lecturer') makes
-- every staff-facing query that filters `role IN ('lecturer','hod')` exclude
-- it by construction, and prevents it from being picked up by broader role
-- checks elsewhere.
ALTER TABLE public.users DROP CONSTRAINT users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['student', 'lecturer', 'hod', 'assistant']));
