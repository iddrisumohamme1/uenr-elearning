/*
   LECTURER MY COURSES PAGE
   frontend/lecturer/my_courses.js
   Loads the logged-in lecturer's courses with live enrolment and
   at-risk readouts, and provides the students / messaging modals.
   GETs use the persist-until-reload cache (shared keys with the
   dashboard), so revisits paint instantly without refetching.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer', 'hod').catch(() => null);
    if (!user) return;

    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    const grid = document.getElementById('course-grid');
    const sumCourses = document.getElementById('sum-courses');
    const sumStudents = document.getElementById('sum-students');
    const sumRisk = document.getElementById('sum-risk');

    const messageModal = document.getElementById('message-modal');
    const studentsModal = document.getElementById('students-modal');
    const materialsModal = document.getElementById('materials-modal');
    const materialsBody = document.getElementById('materials-body');
    const removeMaterialModal = document.getElementById('remove-material-modal');
    const removeMaterialConfirm = document.getElementById('remove-material-confirm');
    let messageRecipient = null;
    let activeCourseId = null;
    let pendingMaterialId = null;
    let pendingMaterialTitle = '';

    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );
    [messageModal, studentsModal, materialsModal, removeMaterialModal].forEach(m => m && m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));

    function openMessage(studentName, studentId, courseLabel, courseId) {
        messageRecipient = { student_id: studentId, course_id: courseId };
        document.getElementById('message-to').textContent = `Message ${studentName}`;
        document.getElementById('message-course').textContent = courseLabel || '';
        document.getElementById('message-content').value = '';
        messageModal.hidden = false;
        document.getElementById('message-content').focus();
    }

    document.getElementById('message-send').addEventListener('click', async () => {
        const content = document.getElementById('message-content').value;
        if (!content.trim()) {
            showToast('Write a message before sending.', 'error');
            return;
        }
        const btn = document.getElementById('message-send');
        btn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/messages/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipient_id: messageRecipient.student_id,
                    course_id: messageRecipient.course_id,
                    content,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast(data.message || 'Message sent.', 'success');
                closeModal(messageModal);
            } else {
                showToast(data.detail || 'Could not send message.', 'error');
            }
        } catch (err) {
            showToast('Could not send message.', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    function escapeHTML(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    async function openStudents(courseId, courseLabel) {
        document.getElementById('students-title').textContent = courseLabel;
        const body = document.getElementById('students-body');
        studentsModal.hidden = false;
        body.innerHTML = '<div class="loading-wrapper loading-full"><div class="spinner"></div><p>Loading students…</p></div>';
        try {
            const data = await swrGet(`course-students:${courseId}`, `${API_BASE}/api/courses/${courseId}/students`);
            const students = data.students || [];
            if (!students.length) {
                body.innerHTML = '<p class="text-muted">No students are enrolled in this course yet.</p>';
                return;
            }
            body.innerHTML = students.map(s => `
                <div class="student-row">
                    <div>
                        <span class="student-name">${escapeHTML(s.full_name || 'Unknown student')}</span>
                        <span class="student-email">${escapeHTML(s.email || '')}</span>
                    </div>
                    <button class="btn-msg" data-name="${escapeHTML(s.full_name || 'Student')}" data-id="${s.student_id}" data-course="${escapeHTML(courseLabel)}">Message</button>
                </div>
            `).join('');
            body.querySelectorAll('.btn-msg').forEach(btn => {
                btn.addEventListener('click', () => {
                    closeModal(studentsModal);
                    openMessage(btn.dataset.name, btn.dataset.id, btn.dataset.course, courseId);
                });
            });
        } catch (err) {
            body.innerHTML = '<p class="text-muted">Unable to load students.</p>';
            showToast('Unable to load students.', 'error');
        }
    }

    function formatOrg(m) {
        if (m.week_number != null) return `Week ${m.week_number}`;
        if (m.unit_label) return m.unit_label;
        if (m.semester) return m.semester;
        return 'Full course';
    }

    async function openMaterials(courseId, courseLabel) {
        activeCourseId = courseId;
        document.getElementById('materials-title').textContent = courseLabel;
        document.getElementById('materials-sub').textContent = 'Manage the files uploaded for this course.';
        materialsModal.hidden = false;
        materialsBody.innerHTML = '<div class="loading-wrapper loading-full"><div class="spinner"></div><p>Loading materials…</p></div>';
        try {
            const data = await swrGet(`course-materials:${courseId}`, `${API_BASE}/api/materials/course/${courseId}`);
            const materials = (data && data.materials) || [];
            if (!materials.length) {
                materialsBody.innerHTML = '<p class="text-muted">No materials uploaded for this course yet.</p>';
                return;
            }
            materialsBody.innerHTML = materials.map(m => `
                <div class="material-row">
                    <div class="material-info">
                        <span class="material-title"><i class="bi bi-file-earmark-text"></i> ${escapeHTML(m.title)}</span>
                        <span class="material-meta">${escapeHTML(formatOrg(m))}${m.created_at ? ' · ' + new Date(m.created_at).toLocaleDateString() : ''}</span>
                    </div>
                    <button class="btn-material-remove" data-id="${m.id}" data-title="${escapeHTML(m.title)}" aria-label="Remove ${escapeHTML(m.title)}"><i class="bi bi-trash"></i> Remove</button>
                </div>
            `).join('');
            materialsBody.querySelectorAll('.btn-material-remove').forEach(btn => {
                btn.addEventListener('click', () => openRemoveMaterial(btn.dataset.id, btn.dataset.title));
            });
        } catch (err) {
            materialsBody.innerHTML = '<p class="text-muted">Unable to load materials.</p>';
            showToast('Unable to load materials.', 'error');
        }
    }

    function openRemoveMaterial(id, title) {
        pendingMaterialId = id;
        pendingMaterialTitle = title;
        document.getElementById('remove-material-title').textContent = `Remove "${title}"?`;
        removeMaterialModal.hidden = false;
    }

    removeMaterialConfirm.addEventListener('click', async () => {
        if (!pendingMaterialId) return;
        const btn = removeMaterialConfirm;
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-spinner"></span> Removing…';
        try {
            const res = await authFetch(`${API_BASE}/api/materials/${pendingMaterialId}`, { method: 'DELETE' });
            if (res.ok) {
                showToast('Material removed.', 'success');
                closeModal(removeMaterialModal);
                invalidateApiCache(`course-materials:${activeCourseId}`);
                openMaterials(activeCourseId, document.getElementById('materials-title').textContent);
            } else {
                const data = await res.json().catch(() => ({}));
                showToast(data.detail || 'Could not remove material.', 'error');
            }
        } catch (err) {
            showToast('Could not remove material.', 'error');
        } finally {
            pendingMaterialId = null;
            pendingMaterialTitle = '';
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-trash"></i> Remove material';
        }
    });

    function renderCard(c) {
        const enrolled = c.enrolled != null ? String(c.enrolled) : '–';
        const atRisk = c.atRisk || 0;
        return `
            <article class="course-card">
                <div class="course-card-top">
                    <span class="course-code">${escapeHTML(c.code || 'N/A')}</span>
                    ${atRisk
                        ? `<span class="badge badge--danger">${atRisk} at risk</span>`
                        : '<span class="badge badge--success">All on track</span>'}
                </div>
                <h3 class="course-title">${escapeHTML(c.title)}</h3>
                <div class="course-meta">
                    <span><i class="bi bi-people"></i> ${enrolled} enrolled</span>
                </div>
                ${c.atRisk && c.atRiskReason
                    ? `<p class="course-risk-line">At-risk signal: ${escapeHTML(c.atRiskReason)}</p>`
                    : ''}
                <div class="course-actions">
                    <a class="btn-view" href="resources.html?course=${encodeURIComponent(c.id)}"><i class="bi bi-magic"></i> Study Resources</a>
                    <button class="btn-view" data-materials-id="${c.id}" data-materials-label="${escapeHTML(c.code || '')} ${escapeHTML(c.title)}"><i class="bi bi-folder2-open"></i> Materials</button>
                    <button class="btn-view" data-course-id="${c.id}" data-course-label="${escapeHTML(c.code || '')} ${escapeHTML(c.title)}"><i class="bi bi-person-lines-fill"></i> Students</button>
                </div>
            </article>
        `;
    }

    try {
        const courses = await swrGet('lect-my-courses', `${API_BASE}/api/courses/mine`);
        if (!Array.isArray(courses) || courses.length === 0) {
            sumCourses.textContent = '0';
            sumStudents.textContent = '0';
            sumRisk.textContent = '0';
            grid.innerHTML = `
                <div class="empty-state">
                    <i class="bi bi-journal-bookmark"></i>
                    <h3>No courses assigned yet</h3>
                    <p class="text-muted">Upload lecture content or create a quiz to get started on a course.</p>
                    <a class="btn-auth btn-sm" href="upload.html">Upload content</a>
                </div>
            `;
            return;
        }

        sumCourses.textContent = String(courses.length);

        const enriched = await Promise.all(courses.map(async (c) => {
            let enrolled = null;
            let atRisk = 0;
            let atRiskReason = '';
            try {
                const sData = await swrGet(`course-students:${c.id}`, `${API_BASE}/api/courses/${c.id}/students`);
                enrolled = sData && sData.total_enrolled != null ? sData.total_enrolled : null;
            } catch (err) { /* keep – */ }
            try {
                const aData = await swrGet(`lect-summary:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/summary`);
                atRisk = (aData && aData.engagement?.at_risk?.count) || 0;
            } catch (err) { /* keep 0 */ }
            if (atRisk > 0) {
                try {
                    const rData = await swrGet(`lect-at-risk:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/at-risk`);
                    const flagged = (rData && Array.isArray(rData.students)) ? rData.students : [];
                    if (flagged.length) {
                        const top = flagged[0];
                        const parts = [];
                        if (typeof top.reading_minutes === 'number' && top.reading_minutes > 0) parts.push(`${top.reading_minutes}m read`);
                        if (typeof top.latest_quiz_score === 'number') parts.push(`quiz ${top.latest_quiz_score}%`);
                        if (typeof top.days_since_last_activity === 'number') parts.push(`${top.days_since_last_activity}d inactive`);
                        atRiskReason = parts.length ? parts.join(' · ') : 'flagged at-risk';
                    }
                } catch (err) { /* keep reason empty */ }
            }
            return { ...c, enrolled, atRisk, atRiskReason };
        }));

        enriched.sort((a, b) => (b.atRisk || 0) - (a.atRisk || 0));

        const totalStudents = enriched.reduce((sum, c) => sum + (c.enrolled || 0), 0);
        const totalRisk = enriched.reduce((sum, c) => sum + (c.atRisk || 0), 0);
        sumStudents.textContent = String(totalStudents);
        sumRisk.textContent = String(totalRisk);

        grid.innerHTML = enriched.map(renderCard).join('');

        grid.querySelectorAll('[data-materials-id]').forEach(btn => {
            btn.addEventListener('click', () => openMaterials(btn.dataset.materialsId, btn.dataset.materialsLabel));
        });
        grid.querySelectorAll('[data-course-id]').forEach(btn => {
            btn.addEventListener('click', () => openStudents(btn.dataset.courseId, btn.dataset.courseLabel));
        });
    } catch (err) {
        console.error('My courses error:', err);
        sumCourses.textContent = '–';
        sumStudents.textContent = '–';
        sumRisk.textContent = '–';
        grid.innerHTML = '<div class="empty-state"><p class="text-muted">Unable to load your courses. Refresh to try again.</p></div>';
        showToast('Unable to load your courses.', 'error');
    }
});
