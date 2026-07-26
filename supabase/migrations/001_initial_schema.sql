-- SUPABASE DATABASE SCHEMA
-- migrations/001_initial_schema.sql

-- 1. Users table (Profiles)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT CHECK (role IN ('student', 'lecturer', 'hod')) NOT NULL,
    department TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Courses table
CREATE TABLE IF NOT EXISTS courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    department TEXT NOT NULL,
    lecturer_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Enrollments table
CREATE TABLE IF NOT EXISTS enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES users(id),
    course_id UUID REFERENCES courses(id),
    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(student_id, course_id)
);

-- 4. Materials table
CREATE TABLE IF NOT EXISTS materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID REFERENCES courses(id),
    title TEXT NOT NULL,
    content_url TEXT,
    content_type TEXT, -- pdf, video, text
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Engagement Logs (Core Feature)
CREATE TABLE IF NOT EXISTS engagement_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES users(id),
    material_id UUID REFERENCES materials(id),
    mouse_movements INTEGER DEFAULT 0,
    scroll_depth INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    time_spent INTEGER DEFAULT 0,
    idle_time INTEGER DEFAULT 0,
    engagement_score FLOAT,
    engagement_level TEXT,
    logged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Quizzes
CREATE TABLE IF NOT EXISTS quizzes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID REFERENCES courses(id),
    title TEXT NOT NULL,
    time_limit INTEGER, -- in minutes
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Questions
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quiz_id UUID REFERENCES quizzes(id),
    question_text TEXT NOT NULL,
    options JSONB NOT NULL, -- e.g. ["A", "B", "C"]
    correct_option INTEGER NOT NULL
);

-- 8. Quiz Results
CREATE TABLE IF NOT EXISTS quiz_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES users(id),
    quiz_id UUID REFERENCES quizzes(id),
    score FLOAT NOT NULL,
    total_questions INTEGER NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


