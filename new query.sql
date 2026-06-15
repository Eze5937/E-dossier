-- 1. Drop the old conflicting tables completely
DROP TABLE IF EXISTS form_teachers CASCADE;
DROP TABLE IF EXISTS teachers CASCADE;
DROP TABLE IF EXISTS subject_assignments CASCADE;

-- 2. Create the UNIFIED teachers table (Class/Arm are optional here!)
CREATE TABLE teachers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL, -- <-- This handles the assigned password!
    assigned_class VARCHAR(50),
    assigned_arm VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
SELECT * FROM teachers;
-- 3. Create the Master Subjects Table
CREATE TABLE IF NOT EXISTS subjects (
    id SERIAL PRIMARY KEY,
    subject_name VARCHAR(100) UNIQUE NOT NULL
);

SELECT * FROM subjects;

-- 4. Create the Subject Assignments Table (Maps Subject Teachers to their classes)
CREATE TABLE subject_assignments (
    id SERIAL PRIMARY KEY,
    teacher_email VARCHAR(255) REFERENCES teachers(email) ON DELETE CASCADE,
    assigned_class VARCHAR(50) NOT NULL,
    assigned_arm VARCHAR(50) NOT NULL,
    subject_name VARCHAR(100) REFERENCES subjects(subject_name) ON DELETE CASCADE,
    academic_year VARCHAR(20) DEFAULT '2025/2026',
    UNIQUE(teacher_email, assigned_class, assigned_arm, subject_name)
);

SELECT * FROM subject_assignments;

-- 5. Seed your default teacher profile row into the new UNIFIED table
INSERT INTO teachers (name, email, password, assigned_class, assigned_arm)
VALUES ('Maza Winner', 'maza@school.com', 'winner2026', 'SSS 1', 'Science A')
ON CONFLICT (email) DO NOTHING;

INSERT INTO subjects (subject_name) VALUES 
('Mathematics'),
('Further Mathematics'),
('English Language'),
('Physics'),
('Chemistry'),
('Biology'),
('Literature-in-English'),
('Government'),
('Economics'),
('Data Processing')
ON CONFLICT (subject_name) DO NOTHING;


INSERT INTO subjects (subject_name) VALUES
('Mathematics'),
('English Language'),
('Further Mathematics'),
('Biology'),
('Chemistry'),
('Physics'),
('Agricultural Science'),
('Geography'),
('Technical Drawing'),
('Literature-in-English'),
('History'),
('Government'),
('Economics'),
('Christian Religious Studies'),
('Islamic Religious Studies'),
('Civic Education'),
('French Language'),
('Data Processing'),
('Garment Making'),
('Catering Craft Practice');


DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS student_enrollments CASCADE;

--------------- STUDENT REGISTRY (Holds core personal info)-----------------
CREATE TABLE students (
    admission_id VARCHAR(50) PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    gender VARCHAR(20) NOT NULL,
    date_of_birth DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- table 2: CLASS ENROLLMENT MANIFEST (Links students to their current class and teacher)
CREATE TABLE student_enrollments (
    id SERIAL PRIMARY KEY,
    admission_id VARCHAR(50) REFERENCES students(admission_id) ON DELETE CASCADE,
    assigned_class VARCHAR(50) NOT NULL,
    assigned_arm VARCHAR(50) NOT NULL,
    academic_year VARCHAR(20) DEFAULT '2025/2026',
    enrolled_by_email VARCHAR(255) NOT NULL,
    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

SELECT * FROM student_enrollments;
SELECT * FROM students;

DROP TABLE IF EXISTS subject_allocations CASCADE;

--------------- SUBJECT ALLOCATION REGISTRY -----------------
CREATE TABLE subject_allocations (
    id SERIAL PRIMARY KEY,
    subject_name VARCHAR(100) NOT NULL,          -- e.g., 'Further Mathematics' or 'Mathematics'
    class_tier VARCHAR(50) NOT NULL,            -- e.g., 'SSS 1', 'SSS 2'
    class_arm VARCHAR(50) NOT NULL,             -- e.g., 'A', 'B'
    allocated_by VARCHAR(255) DEFAULT 'Admin',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
    
    -- Prevents accidentally mapping the exact same subject to the same class arm twice
    -- 1. Remove any duplicate rows that might already exist to prevent constraint building failure
TRUNCATE TABLE subject_allocations;

-- 2. Manually add the missing unique constraint structure with the correct name
ALTER TABLE subject_allocations 
ADD CONSTRAINT unique_allocation UNIQUE (subject_name, class_tier, class_arm);

-- 3. Double-check your work to confirm it's active
SELECT * FROM subject_allocations;

-- Test Insert: Let's populate one entry to see if the dashboard reads it
INSERT INTO = (subject_name, class_tier, class_arm)
VALUES ('Further Mathematics', 'SSS 1', 'A');

SELECT * FROM academic_dossiers;


--------------- STUDENT PERFORMANCE SCORE REGISTRY -----------------
CREATE TABLE IF NOT EXISTS student_scores (
    id SERIAL PRIMARY KEY,
    admission_id VARCHAR(100) NOT NULL REFERENCES students(admission_id) ON DELETE CASCADE,
    subject_name VARCHAR(100) NOT NULL,
    class_tier VARCHAR(50) NOT NULL,
    class_arm VARCHAR(50) NOT NULL,
    ca_score NUMERIC(5,2) DEFAULT NULL,   -- Continuous Assessment (Max 40)
    exam_score NUMERIC(5,2) DEFAULT NULL, -- Term Exam Score (Max 60)
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Keeps your data tidy: one row per subject for each student
    CONSTRAINT unique_student_subject_score UNIQUE (admission_id, subject_name, class_tier, class_arm)
);

--------------- AUTOMATED UNIVERSAL ACADEMIC DOSSIER REGISTRY -----------------
CREATE TABLE IF NOT EXISTS academic_dossiers (
    id SERIAL PRIMARY KEY,
    admission_id VARCHAR(100) NOT NULL REFERENCES students(admission_id) ON DELETE CASCADE,
    subject_name VARCHAR(100) NOT NULL,
    class_tier VARCHAR(50) NOT NULL,
    class_arm VARCHAR(50) NOT NULL,
    
    -- Term Assessment Tracks
    ca_1 NUMERIC(5,2) DEFAULT 0.00, -- First CA (e.g., Max 10)
    ca_2 NUMERIC(5,2) DEFAULT 0.00, -- Second CA (e.g., Max 10)
    ca_3 NUMERIC(5,2) DEFAULT 0.00, -- Third CA (e.g., Max 20)
    exam NUMERIC(5,2) DEFAULT 0.00, -- Examination (e.g., Max 60)
    
    -- GENERATED ALWAYS: Automated math calculation directly inside Postgres
    total_score NUMERIC(5,2) GENERATED ALWAYS AS (ca_1 + ca_2 + ca_3 + exam) STORED,
    
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_student_subject_dossier UNIQUE (admission_id, subject_name)
);

-- 1. Fix any minor string discrepancies between the registration tables
UPDATE academic_dossiers ad
SET class_tier = se.assigned_class,
    class_arm = se.assigned_arm
FROM student_enrollments se
WHERE ad.admission_id = se.admission_id
  AND (ad.class_tier != se.assigned_class OR ad.class_arm != se.assigned_arm);

-- 2. Force-insert missing subject ledger tracks for any student left behind
INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm)
SELECT se.admission_id, sa.subject_name, se.assigned_class, se.assigned_arm
FROM student_enrollments se
JOIN subject_allocations sa ON se.assigned_class = sa.class_tier AND se.assigned_arm = sa.class_arm
ON CONFLICT (admission_id, subject_name) DO NOTHING;

-- 1. Check for mismatched class naming structures
SELECT assigned_class, COUNT(*) FROM student_enrollments GROUP BY assigned_class;
SELECT class_tier, COUNT(*) FROM subject_allocations GROUP BY class_tier;

-- 2. Force-repair dossier structural data string fields to match enrollment alignment
UPDATE academic_dossiers ad
SET class_tier = se.assigned_class,
    class_arm = se.assigned_arm
FROM student_enrollments se
WHERE ad.admission_id = se.admission_id
  AND (ad.class_tier != se.assigned_class OR ad.class_arm != se.assigned_arm);

-- 3. Run a global sync sweep to build missing subject rows for all students
INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm)
SELECT se.admission_id, sa.subject_name, se.assigned_class, se.assigned_arm
FROM student_enrollments se
JOIN subject_allocations sa ON se.assigned_class = sa.class_tier AND se.assigned_arm = sa.class_arm
ON CONFLICT (admission_id, subject_name) DO NOTHING;

-- See what classes and subjects are actually registered
SELECT * FROM subject_allocations;

-- Ensure there are no trailing whitespaces or case-mismatch issues causing your joins to fail
UPDATE subject_allocations 
SET class_tier = TRIM(class_tier), 
    class_arm = TRIM(UPPER(class_arm)), 
    subject_name = TRIM(subject_name);