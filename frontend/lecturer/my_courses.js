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
    let messageRecipient = null;

    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );
    [messageModal, studentsModal].forEach(m => m && m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));

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
                <div class="course-actions">
                    <a class="btn-view" href="resources.html?course=${encodeURIComponent(c.id)}"><i class="bi bi-magic"></i> Study Resources</a>
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
            try {
                const sData = await swrGet(`course-students:${c.id}`, `${API_BASE}/api/courses/${c.id}/students`);
                enrolled = sData && sData.total_enrolled != null ? sData.total_enrolled : null;
            } catch (err) { /* keep – */ }
            try {
                const aData = await swrGet(`lect-summary:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/summary`);
                atRisk = (aData && aData.engagement?.at_risk?.count) || 0;
            } catch (err) { /* keep 0 */ }
            return { ...c, enrolled, atRisk };
        }));

        const totalStudents = enriched.reduce((sum, c) => sum + (c.enrolled || 0), 0);
        const totalRisk = enriched.reduce((sum, c) => sum + (c.atRisk || 0), 0);
        sumStudents.textContent = String(totalStudents);
        sumRisk.textContent = String(totalRisk);

        grid.innerHTML = enriched.map(renderCard).join('');

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
