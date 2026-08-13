-- ROW LEVEL SECURITY (RLS) POLICIES
-- migrations/20260813000003_rls_policies.sql

-- 1. Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_results ENABLE ROW LEVEL SECURITY;

-- 2. User Profile Policies
CREATE POLICY "Users can view their own profile"
ON users FOR SELECT
USING (auth.uid() = id);

-- 3. Enrollment Policies
CREATE POLICY "Students can view their own enrollments"
ON enrollments FOR SELECT
USING (auth.uid() = student_id);

CREATE POLICY "Lecturers can view enrollments for their courses"
ON enrollments FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM courses 
        WHERE courses.id = enrollments.course_id 
        AND courses.lecturer_id = auth.uid()
    )
);

-- 4. Engagement Log Policies
CREATE POLICY "Students can only log their own engagement"
ON engagement_logs FOR INSERT
WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Lecturers can view engagement for their materials"
ON engagement_logs FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM materials 
        JOIN courses ON materials.course_id = courses.id
        WHERE materials.id = engagement_logs.material_id 
        AND courses.lecturer_id = auth.uid()
    )
);

-- 5. Course Policies
CREATE POLICY "Lecturers can view their own courses"
ON courses FOR SELECT
USING (lecturer_id = auth.uid());

CREATE POLICY "Students can view courses in their department"
ON courses FOR SELECT
USING (
    department = (SELECT department FROM users WHERE id = auth.uid())
);

CREATE POLICY "HOD can view courses in their department"
ON courses FOR SELECT
USING (
    department = (SELECT department FROM users WHERE id = auth.uid())
);

-- 6. HOD Policies
CREATE POLICY "HOD can view everything in their department"
ON users FOR SELECT
USING (
    (SELECT role FROM users WHERE id = auth.uid()) = 'hod'
);
