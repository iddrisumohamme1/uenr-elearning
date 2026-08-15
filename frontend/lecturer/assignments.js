/* 
   LECTURER ASSIGNMENTS PAGE LOGIC
   frontend/lecturer/assignments.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();

    const courseSelect = document.getElementById('course-select');
    const form = document.getElementById('assign-form');
    const listEl = document.getElementById('assign-list');
    const subsModal = document.getElementById('subs-modal');

    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );
    subsModal && subsModal.addEventListener('click', (e) => { if (e.target === subsModal) closeModal(subsModal); });

    let courseNames = {};

    async function loadCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/courses/`);
            const courses = await res.json();
            if (!Array.isArray(courses) || !courses.length) {
                courseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }
            courses.forEach(c => { if (c.id) courseNames[c.id] = c.title; });
            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${courses.map(c => `<option value="${c.id}">${c.title} (${c.code || 'No code'})</option>`).join('')}
            `;
        } catch (err) {
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('assign-title').value.trim();
        const courseId = courseSelect.value;
        if (!title || !courseId) {
            showToast('Select a course and enter a title.', 'warning');
            return;
        }
        const payload = {
            course_id: courseId,
            title,
            instructions: document.getElementById('assign-instructions').value.trim() || null,
            due_date: document.getElementById('assign-due').value || null,
            week_number: document.getElementById('assign-week').value ? Number(document.getElementById('assign-week').value) : null,
        };
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/assignments/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast('Assignment created.', 'success');
                form.reset();
                courseSelect.innerHTML = '<option value="" disabled selected>Select a course</option>';
                await loadCourses();
                loadAssignments();
            } else {
                showToast(data.detail || 'Could not create assignment.', 'error');
            }
        } catch (err) {
            showToast('Could not create assignment.', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    async function viewSubmissions(assignmentId, title) {
        document.getElementById('subs-title').textContent = title;
        const body = document.getElementById('subs-body');
        subsModal.hidden = false;
        body.innerHTML = '<div class="loading-wrapper loading-full"><div class="spinner"></div><p>Loading submissions…</p></div>';
        try {
            const res = await authFetch(`${API_BASE}/api/assignments/${assignmentId}/submissions`);
            if (!res.ok) throw new Error('submissions fetch failed');
            const data = await res.json();
            const subs = data.submissions || [];
            if (!subs.length) {
                body.innerHTML = '<p class="text-muted">No submissions yet.</p>';
                return;
            }
            const onTimeCount = subs.filter(s => s.on_time).length;
            body.innerHTML = `
                <p class="text-muted" style="margin-bottom: var(--s4)">${subs.length} submission${subs.length === 1 ? '' : 's'} · ${onTimeCount} on time</p>
                ${subs.map(s => `
                    <div class="sub-card">
                        <div class="sub-head">
                            <span class="sub-name">${s.student_name || s.student_id}</span>
                            <div class="sub-head-right">
                                ${s.letter_grade ? `<span class="badge badge--ontime">${s.letter_grade}</span>` : ''}
                                <span class="badge ${s.on_time ? 'badge--ontime' : 'badge--none'}">${s.on_time ? 'On time' : 'Late'}</span>
                            </div>
                        </div>
                        <div class="sub-time">Submitted ${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '–'}</div>
                        ${s.score != null ? `<div class="sub-grade">Score ${s.score}%</div>` : ''}
                        ${s.feedback ? `<div class="sub-feedback">${s.feedback}</div>` : ''}
                        <div class="sub-content">${s.content}</div>
                    </div>
                `).join('')}
            `;
        } catch (err) {
            body.innerHTML = '<p class="text-muted">Unable to load submissions.</p>';
            showToast('Unable to load submissions.', 'error');
        }
    }

    async function loadAssignments() {
        try {
            const coursesRes = await authFetch(`${API_BASE}/api/courses/`);
            const courses = await coursesRes.json();
            if (!Array.isArray(courses) || !courses.length) {
                listEl.innerHTML = '<p class="text-muted">No courses assigned yet.</p>';
                return;
            }

            let rows = [];
            for (const course of courses) {
                const res = await authFetch(`${API_BASE}/api/assignments/course/${course.id}`);
                if (!res.ok) continue;
                const data = await res.json();
                (data.assignments || []).forEach(a => {
                    rows.push({
                        ...a,
                        course_id: course.id,
                        courseLabel: `${course.code || 'N/A'} · ${course.title}`,
                    });
                });
            }

            if (!rows.length) {
                listEl.innerHTML = '<p class="text-muted">You have not created any assignments yet.</p>';
                return;
            }

            rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            listEl.innerHTML = rows.map(a => {
                const total = a.submission_count || 0;
                return `
                <div class="assign-item">
                    <div class="assign-item-head">
                        <div>
                            <h4>${a.title}${a.auto_generated ? ' <span class="badge badge--ontime">Auto</span>' : ''}</h4>
                            <div class="assign-meta">
                                <span>${a.courseLabel}</span>
                                <span>Week ${a.week_number || '–'}</span>
                                <span>Due ${a.due_date || 'flexible'}</span>
                            </div>
                        </div>
                        <div class="assign-badges">
                            <span class="badge badge--count">${total} submitted</span>
                            ${total ? `<span class="badge badge--ontime">${a.on_time_count || 0} on time</span>` : ''}
                        </div>
                    </div>
                    ${a.instructions ? `<p class="assign-instructions text-muted">${a.instructions}</p>` : ''}
                    <div class="assign-actions">
                        <button class="btn-msg" data-id="${a.id}" data-title="${a.title}">View submissions</button>
                    </div>
                </div>`;
            }).join('');

            listEl.querySelectorAll('.btn-msg').forEach(btn => {
                btn.addEventListener('click', () => viewSubmissions(btn.dataset.id, btn.dataset.title));
            });
        } catch (err) {
            console.error('Error loading assignments:', err);
            listEl.innerHTML = '<p class="text-muted">Unable to load assignments.</p>';
            showToast('Unable to load assignments.', 'error');
        }
    }

    await loadCourses();
    loadAssignments();
});
