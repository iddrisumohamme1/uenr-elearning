ALTER TABLE engagement_logs DROP CONSTRAINT IF EXISTS engagement_logs_material_id_fkey;

ALTER TABLE engagement_logs ALTER COLUMN material_id DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN engagement_class DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN engagement_label DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN comprehension_class DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN comprehension_label DROP NOT NULL;
ALTER TABLE engagement_logs ALTER COLUMN course_id DROP NOT NULL;

ALTER TABLE engagement_logs
    ADD CONSTRAINT engagement_logs_material_id_fkey
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE;
    