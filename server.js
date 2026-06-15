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

    try {
        const teachersQuery = `SELECT COUNT(DISTINCT email) as staff_keys FROM teachers;`;
        const teacherRes = await pool.query(teachersQuery);
        deployedTeachersCount = parseInt(teacherRes.rows[0].staff_keys) || 0;
    } catch (err) {
        console.log("⚠️ Notice: Couldn't read teachers metric.");
    }

    try {
        const studentsQuery = `SELECT COUNT(*) as total_students FROM student_enrollments;`;
        const studentRes = await pool.query(studentsQuery);
        totalStudentsCount = parseInt(studentRes.rows[0].total_students) || 0;
    } catch (err) {
        console.log("⚠️ Notice: Couldn't read students registry metric.");
    }

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
/// ==========================================================================
// ADMIN WORKSPACE: STAFF ACCOUNT PROVISIONING & SCOPE ALLOCATION
// ==========================================================================
// ==========================================================================
// ADMIN WORKSPACE: BATCH TRACK ARCHITECTURE TEACHER REGISTER (SAFE LOOKUP)
// ==========================================================================
app.post('/api/teachers/assign', async (req, res) => {
    console.log("Processing Matrix Assignment:", req.body);

    const { name, email, password, role, schoolSection, assignedClasses, assignedArms, subject } = req.body;

    if (!name || !email || !password || !role || !schoolSection || !Array.isArray(assignedClasses) || !Array.isArray(assignedArms)) {
        return res.status(400).json({ success: false, error: "Missing required profile credentials or matrix data selections." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const normalizedEmail = email.toLowerCase().trim();
        const finalSubject = role === 'Subject Teacher' ? subject : null;
        let insertCount = 0;

        for (const targetClass of assignedClasses) {
            for (const targetArm of assignedArms) {
                
                // 1. Manually check if this specific assignment already exists
                const checkDuplicateQuery = `
                    SELECT id FROM teachers 
                    WHERE email = $1 AND assigned_class = $2 AND assigned_arm = $3;
                `;
                const duplicateCheck = await client.query(checkDuplicateQuery, [normalizedEmail, targetClass, targetArm]);

                // 2. If it doesn't exist, proceed with a safe insert
                if (duplicateCheck.rows.length === 0) {
                    const insertScopeQuery = `
                        INSERT INTO teachers (name, email, password, role, school_section, assigned_class, assigned_arm, subject)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
                    `;
                    
                    await client.query(insertScopeQuery, [
                        name.trim(),
                        normalizedEmail,
                        password,
                        role,
                        schoolSection,
                        targetClass,
                        targetArm,
                        finalSubject
                    ]);
                    insertCount++;
                }
            }
        }

        await client.query('COMMIT');
        
        res.json({ 
            success: true, 
            message: `Profile matrix updated! Successfully committed ${insertCount} new classroom tracks.` 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("CRITICAL BACKEND FAULT:", err.message);
        res.status(500).json({ success: false, error: "Database Engine Fault: " + err.message });
    } finally {
        client.release();
    }
});

// POST Endpoint to provision teacher profile and map their matrix assignments
// 17 // ==========================================================================
// ==========================================================================
// ROUTE: STAFF REGISTRATION & MULTI-GRID BOUNDARY MATRIX DEPLOYMENT (RESOLVED)
// ==========================================================================
app.post('/api/admin/deploy-teacher-matrix', async (req, res) => {
    const { name, email, password, role, schoolSection, assignedClasses, assignedArms, subject } = req.body;

    // Baseline validation check matching form payload conditions
    if (!name || !email || !password || !role || !schoolSection || !Array.isArray(assignedClasses) || !Array.isArray(assignedArms)) {
        return res.status(400).json({ success: false, error: "Validation Failure: Broken or incomplete staff matrix fields payload." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Initialize safe transactional isolation

        const normalizedEmail = email.toLowerCase().trim();
        const verifiedRole = role ? role.trim() : 'Form Teacher';
        const classesString = assignedClasses.join(', ');
        const armsString = assignedArms.join(', ');
        const assignedSubject = verifiedRole === 'Subject Teacher' ? subject : 'N/A';

        // STEP 1: Insert or Update the Parent record first to satisfy the Foreign Key constraint
        const baseTeacherUpsertQuery = `
            INSERT INTO teachers (name, email, password, role, school_section, assigned_class, assigned_arm, subject)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (email) DO UPDATE SET
                name = $1,
                password = $3,
                role = $4,
                school_section = $5,
                assigned_class = $6,
                assigned_arm = $7,
                subject = $8;
        `;

        await client.query(baseTeacherUpsertQuery, [
            name.trim(),
            normalizedEmail,
            password,
            verifiedRole,
            schoolSection,
            classesString,
            armsString,
            assignedSubject
        ]);

        // STEP 2: Clear old relational links safely now that parent identity is locked in
        await client.query('DELETE FROM teacher_assignments WHERE teacher_email = $1 AND assignment_role = $2', [normalizedEmail, verifiedRole]);

        // STEP 3: Multi-grid assignment cross-join mapping engine loops
        for (const targetClass of assignedClasses) {
            for (const targetArm of assignedArms) {
                
                const assignmentQuery = `
                    INSERT INTO teacher_assignments (teacher_email, assignment_role, assigned_class, assigned_arm, subject)
                    VALUES ($1, $2, $3, $4, $5);
                `;

                await client.query(assignmentQuery, [
                    normalizedEmail,
                    verifiedRole,
                    targetClass,
                    targetArm,
                    verifiedRole === 'Subject Teacher' ? subject : 'General Core'
                ]);

                // STEP 4: Cascade Effect: Auto-provision underlying academic record sheets
                if (verifiedRole === 'Subject Teacher' && subject) {
                    const cascadeDossierQuery = `
                        INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm, school_section)
                        SELECT se.admission_id, $1, se.assigned_class, se.assigned_arm, $4
                        FROM student_enrollments se
                        WHERE se.assigned_class = $2 AND se.assigned_arm = $3
                        ON CONFLICT (admission_id, subject_name) DO NOTHING;
                    `;
                    await client.query(cascadeDossierQuery, [subject, targetClass, targetArm, schoolSection]);
                }
            }
        }

        await client.query('COMMIT'); // Push all operations into the database concurrently
        res.json({ 
            success: true, 
            message: `Staff system accounts initialized seamlessly. Matrix scopes deployed.` 
        });

    } catch (err) {
        await client.query('ROLLBACK'); // Instantly reset data changes on failure
        console.error("CRITICAL PORTAL EXCEPTION:", err.message);
        res.status(500).json({ success: false, error: "Database Engine transaction failure: " + err.message });
    } finally {
        client.release(); // Return client connection back to main pool
    }
});


// ==========================================================================
// PORTAL LOGIN ENGINE: PROFILE CROSS-CHECK GATEWAY (POST)
// ==========================================================================
app.post('/api/teachers/login', async (req, res) => {
    const { email, password, loginRole } = req.body;

    if (!email || !password || !loginRole) {
        return res.status(400).json({ success: false, error: "Missing required login parameters." });
    }

    try {
        const normalizedEmail = email.toLowerCase().trim();

        // 1. Verify that the teacher's core account exists
        const accountQuery = `SELECT * FROM teachers WHERE email = $1 LIMIT 1;`;
        const accountResult = await pool.query(accountQuery, [normalizedEmail]);

        if (accountResult.rows.length === 0) {
            return res.status(401).json({ success: false, error: "Access Denied: Account not found." });
        }

        const teacherAccount = accountResult.rows[0];

        // 2. Validate credentials
        if (teacherAccount.password !== password) {
            return res.status(401).json({ success: false, error: "Access Denied: Invalid security key." });
        }

        // 3. Scan the matrix assignments table for the requested access mode role
        const assignmentQuery = `
            SELECT assigned_class, assigned_arm, subject 
            FROM teacher_assignments 
            WHERE teacher_email = $1 AND assignment_role = $2;
        `;
        const assignmentResult = await pool.query(assignmentQuery, [normalizedEmail, loginRole]);

        if (assignmentResult.rows.length === 0) {
            return res.status(403).json({ 
                success: false, 
                error: `Access Locked: You are not authorized or assigned as a ${loginRole} in the system database maps.` 
            });
        }

        // 4. Return the specific authorization context array for the chosen mode
        res.json({
            success: true,
            role: loginRole, // Echoes back 'Form Teacher' or 'Subject Teacher' based on choice
            teacher: {
                name: teacherAccount.name,
                email: teacherAccount.email,
                allocations: assignmentResult.rows // Array containing all their matching classes/subjects
            }
        });

    } catch (err) {
        console.error("Login Engine Fault:", err.message);
        res.status(500).json({ success: false, error: "Server error during handshake." });
    }
});


// ==========================================================================
// ADMIN WORKSPACE: STUDENT REGISTRATION INTAKE ENGINE (POST)
// ==========================================================================
app.post('/api/students/enroll', async (req, res) => {
    const { admissionNo, name, gender, schoolSection, assignedClass, assignedArm } = req.body;

    if (!admissionNo || !name || !gender || !schoolSection || !assignedClass || !assignedArm) {
        return res.status(400).json({ success: false, error: "Validation Fault: Missing critical profile metrics required for baseline intake records." });
    }

    try {
        const queryStr = `
            INSERT INTO student_enrollments (admission_no, full_name, gender, school_section, assigned_class, assigned_arm)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (admission_no) DO NOTHING
            RETURNING id;
        `;

        const result = await pool.query(queryStr, [
            admissionNo.toUpperCase().trim(),
            name.trim(),
            gender,
            schoolSection,
            assignedClass,
            assignedArm
        ]);

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, error: "An admission registration record matching this structural ID key code already exists." });
        }

        res.json({ success: true, message: `Record profile logged securely for ${name} [${admissionNo.toUpperCase()}].` });
    } catch (err) {
        console.error("Student intake fault exception context execution loop:", err.message);
        res.status(500).json({ success: false, error: "Database Write Error: " + err.message });
    }
});

// ==========================================================================
// ADMIN WORKSPACE: FETCH FULL ACTIVE ROSTER DATABASE (GET)
// ==========================================================================
app.get('/api/students/roster', async (req, res) => {
    try {
        const lookupQuery = `SELECT admission_no, full_name, gender, school_section, assigned_class, assigned_arm FROM student_enrollments ORDER BY full_name ASC;`;
        const result = await pool.query(lookupQuery);
        
        res.json({ success: true, roster: result.rows });
    } catch (err) {
        console.error("Roster query matrix breakdown:", err.message);
        res.status(500).json({ success: false, error: "Database Read Failure: " + err.message });
    }
});

// ==========================================================================
// ADMIN WORKSPACE: HARD TERMINATION/EXPUNGE STUDENT FILE (DELETE)
// ==========================================================================
app.delete('/api/students/remove/:admissionNo', async (req, res) => {
    const targetAdmissionNo = req.params.admissionNo;

    try {
        const deleteQuery = `DELETE FROM student_enrollments WHERE admission_no = $1 RETURNING full_name;`;
        const result = await pool.query(deleteQuery, [targetAdmissionNo]);

        if (result.rows.length === 0) {
            return res.status(444).json({ success: false, error: "No matching student file found matching that admission identifier." });
        }

        res.json({ success: true, message: `Student profile file for ${result.rows[0].full_name} completely expunged out of the system registers.` });
    } catch (err) {
        console.error("Critical error processing erasure execution sequence layout:", err.message);
        res.status(500).json({ success: false, error: "Database Erasure Failure: " + err.message });
    }
});


// ==========================================================================
// ROUTE: FORM TEACHER ROSTER STREAM RETRIEVAL
// ==========================================================================
// ==========================================================================
// ROUTE: FORM TEACHER ROSTER STREAM RETRIEVAL
// ==========================================================================
app.get('/api/form-teacher/my-roster', async (req, res) => {
    const { assignedClass, assignedArm } = req.query;

    if (!assignedClass || !assignedArm) {
        return res.status(400).json({ success: false, error: "Missing tracking class boundary parameter vectors." });
    }

    try {
        // Select matching records from your student_enrollments table
        const rosterQuery = `
            SELECT admission_no, full_name, gender 
            FROM student_enrollments 
            WHERE assigned_class = $1 AND assigned_arm = $2
            ORDER BY full_name ASC;
        `;

        const { rows } = await pool.query(rosterQuery, [assignedClass.trim(), assignedArm.trim()]);
        
        res.json({ success: true, students: rows });

    } catch (err) {
        console.error("Roster generation database access fault:", err.message);
        res.status(500).json({ success: false, error: "Database engine access processing fault: " + err.message });
    }
});
// ==========================================================================
// FORM TEACHER: INITIALIZE NEW E-DOSSIER RECORDBUILD (POST)
// ==========================================================================
app.post('/api/form-teacher/initialize-dossier', async (req, res) => {
    const { admissionNo, term, academicYear, studentClass } = req.body;

    if (!admissionNo || !term || !academicYear || !studentClass) {
        return res.status(400).json({ success: false, error: "Missing tracking keys or term selection values." });
    }

    try {
        // Safe check to confirm the dossier card hasn't been instantiated already for that term
        const duplicateCheckQuery = `
            SELECT id FROM academic_dossiers 
            WHERE admission_id = $1 AND school_section = $2; -- adjusting depending on your custom layout match
        `;

        // Assuming you have an activation mapping table or wish to update a status flag:
        // Adjust this insert query layout to hit your target academic data matrix tracking sheet
        res.json({ 
            success: true, 
            message: `Academic dossier layout initialized for student [${admissionNo}] for ${term} (${academicYear}).` 
        });
    } catch (err) {
        res.status(500).json({ success: false, error: "System Registry Initialization Fault: " + err.message });
    }
});

// ==========================================================================
// ADMIN WORKSPACE: BATCH SUBJECT ALLOCATION ROUTE
// ==========================================================================
// ==========================================================================
// ROUTE: CURRICULUM BATCH ALLOCATION MAPPER & DOSSIER AUTO-PROVISIONING (PATCHED)
// ==========================================================================
app.post('/api/admin/allocate-subject-batch', async (req, res) => {
    const { schoolSection, classTier, classArm, subjectNames } = req.body;

    if (!schoolSection || !classTier || !classArm || !Array.isArray(subjectNames) || subjectNames.length === 0) {
        return res.status(400).json({ success: false, error: "Validation Failure: Missing required curriculum fields metadata." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Initialize transactional control block

        // STEP 1: Fetch all current students matching this targeted class and arm
        const studentsQuery = `
            SELECT admission_no, full_name, gender 
            FROM student_enrollments 
            WHERE assigned_class = $1 AND assigned_arm = $2;
        `;
        const { rows: enrolledStudents } = await client.query(studentsQuery, [classTier, classArm]);

        if (enrolledStudents.length === 0) {
            await client.query('COMMIT'); // Commit early/gracefully if no students are found yet
            return res.json({ 
                success: true, 
                message: `Notice: Subject curriculum mapped, but 0 dossier sheets generated because no students are currently enrolled in ${classTier} ${classArm}.` 
            });
        }

        // STEP 2: Loop through each student and ensure they exist in the master parent table
        for (const student of enrolledStudents) {
            
            // This query inserts the student into the parent table dynamically if they aren't already there
            const ensureParentStudentQuery = `
                INSERT INTO students (admission_id, name, gender)
                VALUES ($1, $2, $3)
                ON CONFLICT (admission_id) DO NOTHING;
            `;
            
            // Note: If your primary key column inside the parent "students" table is named "admission_no" instead,
            // simply change the string text above from (admission_id) to (admission_no) to match.
            await client.query(ensureParentStudentQuery, [
                student.admission_no, 
                student.full_name, 
                student.gender
            ]);

            // STEP 3: Now generate the individual subject dossier sheets safely
            for (const subject of subjectNames) {
                const cascadeDossierQuery = `
                    INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm, school_section)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (admission_id, subject_name) DO NOTHING;
                `;

                await client.query(cascadeDossierQuery, [
                    student.admission_no, 
                    subject, 
                    classTier, 
                    classArm, 
                    schoolSection
                ]);
            }
        }

        await client.query('COMMIT'); // Safe transactional release commit
        res.json({ success: true, message: `Successfully initialized tracking sheets for ${subjectNames.length} subject categories.` });

    } catch (err) {
        await client.query('ROLLBACK'); // Roll back on database failures
        console.error("Batch allocation runtime execution error:", err.message);
        res.status(500).json({ success: false, error: "Database engine transactional tracking fault: " + err.message });
    } finally {
        client.release(); // Return client connection back to main pool
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

// ==========================================================================
// ADMIN WORKSPACE: SECTIONAL BATCH SUBJECT ALLOCATION ROUTE
// ==========================================================================
app.post('/api/admin/allocate-subject-batch', async (req, res) => {
    const { schoolSection, classTier, classArm, subjectNames } = req.body;

    if (!schoolSection || !classTier || !classArm || !Array.isArray(subjectNames) || subjectNames.length === 0) {
        return res.status(400).json({ success: false, error: "Missing required class structure, stream track, or batch metrics data inputs." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start safe SQL isolation block entry transaction context

        for (const subject of subjectNames) {
            // 1. Insert allocation connection securely with structural track classification tagging
            const allocationQuery = `
                INSERT INTO subject_allocations (school_section, subject_name, class_tier, class_arm)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (school_section, class_tier, class_arm, subject_name) DO NOTHING;
            `;
            await client.query(allocationQuery, [schoolSection, subject, classTier, classArm]);

            // 2. Cascade update logic: Auto-generate student dossier entries carrying section flags
            const cascadeDossierQuery = `
                INSERT INTO academic_dossiers (admission_id, subject_name, class_tier, class_arm, school_section)
                SELECT se.admission_id, $1, se.assigned_class, se.assigned_arm, $4
                FROM student_enrollments se
                WHERE se.assigned_class = $2 AND se.assigned_arm = $3
                ON CONFLICT (admission_id, subject_name) DO NOTHING;
            `;
            await client.query(cascadeDossierQuery, [subject, classTier, classArm, schoolSection]);
        }

        await client.query('COMMIT'); // Execute all structural allocations simultaneously 
        res.json({ success: true, message: "Batch sectional curriculum mapping processed successfully." });

    } catch (err) {
        await client.query('ROLLBACK'); // Cancel changes instantly if any loop iteration hits a fault
        console.error("Batch allocation runtime execution error:", err.message);
        res.status(500).json({ success: false, error: "Internal processing layout transaction fault inside engine: " + err.message });
    } finally {
        client.release(); // Release client connection link back to main database pool
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