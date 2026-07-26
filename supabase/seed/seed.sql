-- SEED DATA FOR DEMO
-- supabase/seed/seed.sql

-- 1. Insert Sample Lecturer
-- Note: Replace with actual IDs if needed, or use these as placeholders
-- INSERT INTO users (id, full_name, email, role, department) 
-- VALUES ('LECTURER_UUID', 'Prof. Kwame Mensah', 'kwame@uenr.edu.gh', 'lecturer', 'Department of Computer Science and Informatics');

-- 2. Insert Sample Courses
INSERT INTO courses (title, description, code, department) VALUES 
('Data Structures & Algorithms', 'Introduction to fundamental algorithms and data structures.', 'CSI 201', 'Department of Computer Science and Informatics'),
('Database Management Systems', 'Core concepts of relational databases and SQL.', 'CSI 202', 'Department of Computer Science and Informatics'),
('Web Application Development', 'Building modern web apps with HTML, CSS, and JS.', 'CSI 305', 'Department of Computer Science and Informatics');

-- 3. Insert Sample Materials
INSERT INTO materials (course_id, title, content_type) VALUES 
((SELECT id FROM courses WHERE code='CSI 202'), 'Introduction to SQL', 'pdf'),
((SELECT id FROM courses WHERE code='CSI 202'), 'Database Normalization', 'text');

-- 4. Insert Sample Quizzes
INSERT INTO quizzes (course_id, title, time_limit) VALUES 
((SELECT id FROM courses WHERE code='CSI 202'), 'SQL Basics Quiz', 15),
((SELECT id FROM courses WHERE code='CSI 201'), 'Arrays and Linked Lists', 10);

-- 5. Insert Sample Questions
INSERT INTO questions (quiz_id, question_text, options, correct_option) VALUES 
((SELECT id FROM quizzes WHERE title='SQL Basics Quiz'), 'What does SQL stand for?', '["Structured Query Language", "Simple Query Language", "Sequential Query Language"]', 0),
((SELECT id FROM quizzes WHERE title='SQL Basics Quiz'), 'Which keyword is used to fetch data?', '["FETCH", "GET", "SELECT"]', 2);
