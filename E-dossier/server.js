const express = require('express');
const cors = require('cors'); 
const { Pool } = require('pg');

const app = express();

// ==========================================
// 1. MIDDLEWARE CONFIGURATION
// ==========================================
app.use(cors({
    origin: ['http://127.0.0.1:5500', 'http://localhost:5500'],
    methods: ['GET', 'POST'],
    credentials: true
}));

app.use(express.json());

// ==========================================
// 2. DATABASE CONNECTION POOL
// ==========================================
const pool = new Pool({
    user: 'postgres',
    password: '2026', 
    host: 'localhost',
    database: 'result_system_database',
    port: 5432,
});

pool.connect((err, client, release) => {
    if (err) return console.error('Connection fault:', err.stack);
    console.log('Connected seamlessly to result_system_database PostgreSQL engine! 🐘');
    release();
});

// ==========================================
// ROUTE: DYNAMIC METRICS AGGREGATOR ENGINE
// ==========================================
app.get('/api/admin/dashboard-stats', async (req, res) => {
    let activeClassesCount = 0;
    let deployedTeachersCount = 0;
    let totalStudentsCount = 0;

    // 1. Metric: Active Classes with Subjects (Synchronized with subject_assignments)
    try {
        const classArmsQuery = `
            SELECT COUNT(DISTINCT(assigned_class || '-' || assigned_arm)) as active_classes 
            FROM subject_assignments;
        `;
        const classRes = await pool.query(classArmsQuery);
        activeClassesCount = parseInt(classRes.rows[0].active_classes) || 0;
    } catch (err) {
        console.log("⚠️ Notice: Couldn't read subject assignments metric inside dashboard-stats.");
    }

    // 2. Metric: Deployed Form Teachers
    try {
        const teachersQuery = `SELECT COUNT(*) as staff_keys FROM teachers;`;
        const teacherRes = await pool.query(teachersQuery);
        deployedTeachersCount = parseInt(teacherRes.rows[0].staff_keys) || 0;
    } catch (err) {
        console.log("⚠️ Notice: Couldn't read teachers metric.");
    }

    // 3. Metric: Total Assigned Students 
    try {
        const studentsQuery = `SELECT COUNT(*) as total_students FROM students;`;
        const studentRes = await pool.query(studentsQuery);
        totalStudentsCount = parseInt(studentRes.rows[0].total_students) || 0;
    } catch (err) {
        console.log("⚠️ Notice: Couldn't read students registry metric.");
    }

    // Return safely processed data structural payload
    res.json({
        success: true,
        stats: {
            activeClassArms: activeClassesCount,
            deployedTeachers: deployedTeachersCount,
            totalStudents: totalStudentsCount
        }
    });
});

// ==========================================
// ROUTE A: FETCH ASSIGNED STUDENTS WITH EXISTING SCORES (LEFT JOIN)
// ==========================================
app.get('/api/subject-teacher/students', async (req, res) => {
    const { classTier, classArm, subjectName } = req.query;

    try {
        // Runs a JOIN query across student_enrollments and student_scores 
        // to grab students assigned by their Form Teacher, alongside any saved grades.
        const rosterQuery = `
            SELECT 
                s.admission_id, 
                s.first_name, 
                s.last_name, 
                s.gender,
                sc.ca_score, 
                sc.exam_score
            FROM student_enrollments se
            JOIN students s ON se.admission_id = s.admission_id
            LEFT JOIN student_scores sc ON s.admission_id = sc.admission_id 
                AND sc.subject_name = $3 
                AND sc.class_tier = $1 
                AND sc.class_arm = $2
            WHERE se.assigned_class = $1 AND se.assigned_arm = $2
            ORDER BY s.last_name ASC;
        `;

        const result = await pool.query(rosterQuery, [classTier, classArm, subjectName]);
        res.json({ success: true, students: result.rows });
    } catch (err) {
        console.error("Roster extraction error:", err.message);
        res.status(500).json({ success: false, error: "Failed to extract class data manifest." });
    }
});

// ==========================================
// ROUTE B: BATCH SAVE/UPSERT SCORES
// ==========================================
app.post('/api/subject-teacher/save-scores', async (req, res) => {
    const { subjectName, classTier, classArm, scores } = req.body;

    if (!subjectName || !classTier || !classArm || !Array.isArray(scores)) {
        return res.status(400).json({ success: false, error: "Missing required parameter payloads." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const upsertQuery = `
            INSERT INTO student_scores (admission_id, subject_name, class_tier, class_arm, ca_score, exam_score, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (admission_id, subject_name, class_tier, class_arm) 
            DO UPDATE SET 
                ca_score = EXCLUDED.ca_score,
                exam_score = EXCLUDED.exam_score,
                updated_at = CURRENT_TIMESTAMP;
        `;

        for (const record of scores) {
            await client.query(upsertQuery, [
                record.admissionId, 
                subjectName, 
                classTier, 
                classArm, 
                record.caScore, 
                record.examScore
            ]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Scores compiled successfully." });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Score transaction error:", err.message);
        res.status(500).json({ success: false, error: "Failed to securely write spreadsheet values." });
    } finally {
        client.release();
    }
});
// ==========================================
// UPDATED ROUTE 4: STUDENT BATCH ENROLLMENT WITH AUTOMATED DOSSIER INITIALIZATION
// ==========================================
app.post('/api/students/batch-enroll', async (req, res) => {
    const { classTier, classArm, enrolledByEmail, students } = req.body;

    if (!classTier || !classArm || !students || !Array.isArray(students)) {
        return res.status(400).json({ success: false, error: "Missing required enrollment metadata fields." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        let insertedCount = 0;

        for (const student of students) {
            const { admissionId, firstName, lastName, gender, dob } = student;

            // Step A: Insert Core Student Identity Info
            const studentQuery = `
                INSERT INTO students (admission_id, first_name, last_name, gender, date_of_birth)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (admission_id) DO UPDATE 
                SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, gender = EXCLUDED.gender, date_of_birth = EXCLUDED.date_of_birth;
            `;
            await client.query(studentQuery, [admissionId, firstName, lastName, gender, dob]);

            // Step B: Insert Placement Track in Student Enrollments
            const enrollmentQuery = `
                INSERT INTO student_enrollments (admission_id, assigned_class, assigned_arm, enrolled_by_email)
                VALUES ($1, $2, $3, $4);
            `;
            await client.query(enrollmentQuery, [admissionId, classTier, classArm, enrolledByEmail]);

            // Step C: AUTOMATION ENGINE
            // Look up all subjects allocated to this class tier/arm, and instantly initialize rows for this student
            const autoDossierQuery = `
                INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm)
                SELECT $1, subject_name, class_tier, class_arm 
                FROM subject_allocations 
                WHERE class_tier = $2 AND class_arm = $3
                ON CONFLICT (admission_id, subject_name) DO NOTHING;
            `;
            await client.query(autoDossierQuery, [admissionId, classTier, classArm]);

            insertedCount++;
        }

        await client.query('COMMIT');
        console.log(`Successfully enrolled ${insertedCount} students and generated their active subject dossiers.`);
        res.json({ success: true, count: insertedCount });

    } catch (dbError) {
        await client.query('ROLLBACK');
        console.error("Enrollment pipeline crashed, rolling back:", dbError.message);
        res.status(500).json({ success: false, error: "Database transaction error: " + dbError.message });
    } finally {
        client.release();
    }
});
// ==========================================
// ROUTE: FETCH LIVE SUBJECT ASSIGNMENTS FOR LOGGED-IN TEACHER
// ==========================================
app.get('/api/teachers/live-allocations', async (req, res) => {
    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ success: false, error: "Teacher email parameter required." });
    }

    try {
        const queryText = `
            SELECT assigned_class, assigned_arm, subject_name 
            FROM subject_assignments 
            WHERE teacher_email = $1;
        `;
        const result = await pool.query(queryText, [email]);
        res.json({ success: true, allocations: result.rows });
    } catch (err) {
        console.error("Live allocation fetch failure:", err.message);
        res.status(500).json({ success: false, error: "Database retrieval error." });
    }
});
// ==========================================
// ROUTE: PURE SUBJECT ALLOCATION REGISTRY
// ==========================================
app.post('/api/admin/allocate-subject', async (req, res) => {
    const { subjectName, classTier, classArm } = req.body;

    // Validation Guard
    if (!subjectName || !classTier || !classArm) {
        return res.status(400).json({ success: false, error: "Missing required framework parameters." });
    }

    try {
        const queryText = `
            INSERT INTO subject_allocations (subject_name, class_tier, class_arm)
            VALUES ($1, $2, $3)
            ON CONFLICT ON CONSTRAINT unique_allocation DO NOTHING
            RETURNING *;
        `;
        
        const result = await pool.query(queryText, [subjectName, classTier, classArm]);

        // If rows.length is 0, it means the constraint triggered (it already existed)
        if (result.rows.length === 0) {
            return res.status(409).json({ 
                success: false, 
                error: `The framework mapping for ${subjectName} in ${classTier} ${classArm} already exists.` 
            });
        }

        res.status(201).json({ 
            success: true, 
            message: `Successfully registered ${subjectName} to ${classTier} ${classArm}.` 
        });

    } catch (err) {
        console.error("Allocation structural error:", err.message);
        res.status(500).json({ success: false, error: "Database mapping connection failure." });
    }
});
// ==========================================
// ROUTE 1: STAFF PORTAL ALLOCATION (FORM VS SUBJECT)
// ==========================================
app.post('/api/teachers/assign', async (req, res) => {
    const { name, email, password, assignedClass, assignedArm, role, subject } = req.body;

    try {
        await pool.query('BEGIN');

        // Check if the teacher profile already exists in the main teachers table
        const teacherCheck = await pool.query('SELECT * FROM teachers WHERE email = $1', [email]);
        
        if (teacherCheck.rows.length === 0) {
            if (role === 'Form Teacher') {
                // Form Teachers get their real class assigned directly
                await pool.query(
                    `INSERT INTO teachers (name, email, password, assigned_class, assigned_arm) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [name, email, password, assignedClass, assignedArm]
                );
            } else {
                // Subject Teachers supply a clean 'N/A' string placeholder to avoid Not-Null constraints
                await pool.query(
                    `INSERT INTO teachers (name, email, password, assigned_class, assigned_arm) 
                     VALUES ($1, $2, $3, 'N/A', 'N/A')`, 
                    [name, email, password]
                );
            }
        } else if (role === 'Form Teacher') {
            // Update class if profile already exists and is acting as Form Teacher
            await pool.query(
                `UPDATE teachers SET assigned_class = $1, assigned_arm = $2 WHERE email = $3`,
                [assignedClass, assignedArm, email]
            );
        }

        // Register the Subject Assignment Link (Only for Subject Teachers)
        if (role === 'Subject Teacher') {
            if (!subject) {
                throw new Error("Subject tracking requires an assigned subject specialization.");
            }
            
            await pool.query(
                `INSERT INTO subject_assignments (teacher_email, assigned_class, assigned_arm, subject_name)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (teacher_email, assigned_class, assigned_arm, subject_name) DO NOTHING`,
                [email, assignedClass, assignedArm, subject]
            );
        }

        await pool.query('COMMIT');
        res.status(201).json({ success: true, message: `${role} account processed successfully!` });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("Database Constraint Blocked:", error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});
// ==========================================================================
// ADMIN WORKSPACE: BATCH SUBJECT ALLOCATION ROUTE
// ==========================================================================
app.post('/api/admin/allocate-subject-batch', async (req, res) => {
    const { classTier, classArm, subjectNames } = req.body;

    if (!classTier || !classArm || !Array.isArray(subjectNames) || subjectNames.length === 0) {
        return res.status(400).json({ success: false, error: "Missing required class structure or batch metrics data inputs." });
    }

    // Acquire an isolation client connection from the main pool to handle a secure relational database transaction
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start safe SQL block entry transaction context

        for (const subject of subjectNames) {
            // 1. Insert allocation connection safely bypassing pre-existing constraint rules
            const allocationQuery = `
                INSERT INTO subject_allocations (subject_name, class_tier, class_arm)
                VALUES ($1, $2, $3)
                ON CONFLICT (subject_name, class_tier, class_arm) DO NOTHING;
            `;
            await client.query(allocationQuery, [subject, classTier, classArm]);

            // 2. Cascade update logic: Auto-generate student dossier folders matching this configuration parameters
            const cascadeDossierQuery = `
                INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm)
                SELECT se.admission_id, $1, se.assigned_class, se.assigned_arm
                FROM student_enrollments se
                WHERE se.assigned_class = $2 AND se.assigned_arm = $3
                ON CONFLICT (admission_id, subject_name) DO NOTHING;
            `;
            await client.query(cascadeDossierQuery, [subject, classTier, classArm]);
        }

        await client.query('COMMIT'); // Execute all changes securely to tables simultaneously
        res.json({ success: true, message: "Batch curriculum mapping processed successfully." });

    } catch (err) {
        await client.query('ROLLBACK'); // Cancel changes instantly if any iteration fails
        console.error("Batch allocation runtime execution error:", err.message);
        res.status(500).json({ success: false, error: "Internal processing layout transaction fault inside engine." });
    } finally {
        client.release(); // Release client back into the database pool connection
    }
});
// // ==========================================
// BULLETPROOF ROSTER MANIFEST FETCH ENGINE
// ==========================================
app.get('/api/subject-teacher/dossier-roster', async (req, res) => {
    const { classTier, classArm, subjectName } = req.query;

    if (!classTier || !classArm || !subjectName) {
        return res.status(400).json({ success: false, error: "Missing required query stream parameters." });
    }

    try {
        // Fallback Auto-Heal Strategy: Ensure missing dossier slots are built on-the-fly
        const healingQuery = `
            INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm)
            SELECT se.admission_id, $3, se.assigned_class, se.assigned_arm
            FROM student_enrollments se
            WHERE se.assigned_class = $1 AND se.assigned_arm = $2
            ON CONFLICT (admission_id, subject_name) DO NOTHING;
        `;
        await pool.query(healingQuery, [classTier, classArm, subjectName]);

        // Main Query: Extract profiles cleanly
        const queryText = `
            SELECT 
                s.admission_id, 
                s.first_name, 
                s.last_name, 
                s.gender,
                COALESCE(ad.ca_1, 0.00) AS ca_1, 
                COALESCE(ad.ca_2, 0.00) AS ca_2, 
                COALESCE(ad.ca_3, 0.00) AS ca_3, 
                COALESCE(ad.exam, 0.00) AS exam,
                COALESCE(ad.total_score, 0.00) AS total_score
            FROM student_enrollments se
            JOIN students s ON se.admission_id = s.admission_id
            JOIN academic_dossiers ad ON s.admission_id = ad.admission_id
            WHERE se.assigned_class = $1 
              AND se.assigned_arm = $2 
              AND ad.subject_name = $3
            ORDER BY s.last_name ASC;
        `;
 // ==========================================================================
// BULLETPROOF TEACHER CLASS & SUBJECT ALLOCATION EXTRACTOR
// ==========================================================================
app.get('/api/subject-teacher/allocated-subjects', async (req, res) => {
    try {
        // Safe global extraction query 
        const queryText = `
            SELECT DISTINCT subject_name, class_tier, class_arm 
            FROM subject_allocations 
            ORDER BY class_tier ASC, class_arm ASC, subject_name ASC;
        `;
        
        const result = await pool.query(queryText);
        
        res.json({ 
            success: true, 
            allocations: result.rows 
        });
    } catch (err) {
        console.error("CRITICAL: Allocation dropdown pipeline failure ->", err.message);
        res.status(500).json({ 
            success: false, 
            error: "Internal database connection breakdown while parsing allocations." });
    }
});
        const result = await pool.query(queryText, [classTier, classArm, subjectName]);
        res.json({ success: true, students: result.rows });

    } catch (err) {
        console.error("Dossier parsing system fault:", err.message);
        res.status(500).json({ success: false, error: "Failed to extract database dossier profiles." });
    }
});

// ==========================================
// ROUTE: DYNAMIC FIELD UPSERT GRADE CONSOLE HANDLER
// ==========================================
app.post('/api/subject-teacher/save-dossier-scores', async (req, res) => {
    const { subjectName, classTier, classArm, scoreColumn, scores } = req.body;

    // Direct whitelist tracking validation to guard database injection vectors
    const allowedColumns = ['ca_1', 'ca_2', 'ca_3', 'exam'];
    if (!allowedColumns.includes(scoreColumn)) {
        return res.status(400).json({ success: false, error: "Invalid structural assessment targeting target vector." });
    }

    if (!Array.isArray(scores)) {
        return res.status(400).json({ success: false, error: "Invalid scoring payload schema map." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Dynamically inject the verified column name identifier into our SQL template safely
        const dynamicUpsertQuery = `
            INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm, ${scoreColumn})
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (admission_id, subject_name) 
            DO UPDATE SET 
                ${scoreColumn} = EXCLUDED.${scoreColumn},
                updated_at = CURRENT_TIMESTAMP;
        `;

        for (const record of scores) {
            await client.query(dynamicUpsertQuery, [
                record.admissionId,
                subjectName,
                classTier,
                classArm,
                record.scoreValue
            ]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Target metrics committed successfully." });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Dossier transaction save loop fault:", err.message);
        res.status(500).json({ success: false, error: "Failed to write score values: " + err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// ROUTE: EXTRACT CLASS ROSTER MANIFEST FOR ADMIN
// ==========================================
app.get('/api/admin/class-roster', async (req, res) => {
    const { classTier, classArm } = req.query;

    if (!classTier || !classArm) {
        return res.status(400).json({ success: false, error: "Missing required filtering search metrics." });
    }

    try {
        // Core relational database join targeting real-time placements
        const queryText = `
            SELECT 
                s.admission_id, 
                s.first_name, 
                s.last_name, 
                s.gender, 
                s.date_of_birth
            FROM student_enrollments se
            JOIN students s ON se.admission_id = s.admission_id
            WHERE se.assigned_class = $1 AND se.assigned_arm = $2
            ORDER BY s.last_name ASC;
        `;
        
        const result = await pool.query(queryText, [classTier, classArm]);
        res.json({ success: true, students: result.rows });

    } catch (err) {
        console.error("Admin roster fetch error:", err.message);
        res.status(500).json({ success: false, error: "Database reading structural pipeline fault." });
    }
});
// ==========================================
// ROUTE 2: TEACHER AUTHENTICATION GATEWAY
// ==========================================
app.post('/api/teachers/login', async (req, res) => {
    const { email, password, loginRole } = req.body;

    try {
        const teacherResult = await pool.query('SELECT * FROM teachers WHERE email = $1', [email]);
        
        if (teacherResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid email credentials." });
        }

        const teacher = teacherResult.rows[0];

        if (teacher.password !== password) {
            return res.status(401).json({ success: false, message: "Incorrect password configuration." });
        }

        if (loginRole === 'Form Teacher') {
            if (!teacher.assigned_class || teacher.assigned_class === 'N/A') {
                return res.status(403).json({ success: false, message: "Access Denied: You are not assigned as a Form Teacher." });
            }

            return res.json({
                success: true,
                role: 'Form Teacher',
                teacher: {
                    name: teacher.name,
                    email: teacher.email,
                    assignedClass: teacher.assigned_class,
                    assignedArm: teacher.assigned_arm
                }
            });

        } else if (loginRole === 'Subject Teacher') {
            const subjectAssignments = await pool.query(
                `SELECT assigned_class, assigned_arm, subject_name 
                 FROM subject_assignments 
                 WHERE teacher_email = $1`, 
                [email]
            );

            if (subjectAssignments.rows.length === 0) {
                return res.status(403).json({ success: false, message: "Access Denied: No subject allocations found." });
            }

            return res.json({
                success: true,
                role: 'Subject Teacher',
                teacher: {
                    name: teacher.name,
                    email: teacher.email,
                    allocations: subjectAssignments.rows
                }
            });
        }

    } catch (error) {
        console.error("Login verification fault:", error);
        res.status(500).json({ success: false, error: "Internal server authentication error." });
    }
});

// ==========================================
// ROUTE 3: FETCH ALL ASSIGNED TEACHERS FOR THE DATA TABLE UI
// ==========================================
app.get('/api/teachers/list', async (req, res) => {
    try {
        const result = await pool.query('SELECT name, email, password, assigned_class, assigned_arm FROM teachers ORDER BY id DESC;');
        res.json({ success: true, teachers: result.rows });
    } catch (error) {
        console.error("Fetch list breakdown:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// ROUTE 4: RELATIONAL BATCH ENROLLMENT (TWO-TABLE SYSTEM)
// ==========================================
app.post('/api/students/batch-enroll', async (req, res) => {
    const { classTier, classArm, enrolledByEmail, students } = req.body;

    if (!classTier || !classArm || !students || !Array.isArray(students)) {
        return res.status(400).json({ success: false, error: "Missing required enrollment metadata fields." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        let insertedCount = 0;

        for (const student of students) {
            const { admissionId, firstName, lastName, gender, dob } = student;

            const studentQuery = `
                INSERT INTO students (admission_id, first_name, last_name, gender, date_of_birth)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (admission_id) DO UPDATE 
                SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, gender = EXCLUDED.gender, date_of_birth = EXCLUDED.date_of_birth;
            `;
            await client.query(studentQuery, [admissionId, firstName, lastName, gender, dob]);

            const enrollmentQuery = `
                INSERT INTO student_enrollments (admission_id, assigned_class, assigned_arm, enrolled_by_email)
                VALUES ($1, $2, $3, $4);
            `;
            await client.query(enrollmentQuery, [admissionId, classTier, classArm, enrolledByEmail]);

            insertedCount++;
        }

        await client.query('COMMIT');
        console.log(`Successfully enrolled a batch of ${insertedCount} students into ${classTier} ${classArm}`);
        res.json({ success: true, count: insertedCount });

    } catch (dbError) {
        await client.query('ROLLBACK');
        console.error("Database transaction aborted! Rolling back changes.", dbError);
        res.status(500).json({ success: false, error: "Database transaction error: " + dbError.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 5. START SERVER LISTENER
// ==========================================
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Teacher Portal Engine active on port ${PORT}`);
});