-- Migration: 20260907000000_normalize_materials_render_url.sql
-- Materials bucket is now private, so legacy material references stored as full
-- public URLs (…/storage/v1/object/public/materials/<course>/<file>) no longer
-- resolve. Every read goes through the access-checked /api/materials/view (and
-- /download) endpoints via short-lived signed URLs, which accept the modern
-- bare-path form (<course>/<file>) — that is also what new uploads store.
--
-- Rewrite legacy content_url / render_url values to that bare-path form so no
-- row persists a dead public URL. Safe to re-run: only full-URL values are
-- touched.
--
-- Filename-safe percent-encodings (%20, %27, %(, %)) are decoded to match how
-- the uploader stores raw names; any rarer encoding is left in place because
-- the backend unquotes on read (materials._storage_path).

UPDATE materials
SET content_url = NULLIF(
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(
                        SPLIT_PART(content_url, '/object/public/materials/', 2),
                        '%20', ' '),
                    '%27', ''''),
                '%28', '('),
            '%29', ')'),
        '')
WHERE content_url LIKE 'http%';

UPDATE materials
SET render_url = NULLIF(
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(
                        SPLIT_PART(render_url, '/object/public/materials/', 2),
                        '%20', ' '),
                    '%27', ''''),
                '%28', '('),
            '%29', ')'),
        '')
WHERE render_url LIKE 'http%';