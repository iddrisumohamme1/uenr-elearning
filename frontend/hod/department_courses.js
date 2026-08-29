/*
   DEPARTMENT COURSES LOGIC
   frontend/hod/department_courses.js
   Fetches all department courses from Supabase via FastAPI backend and
   renders the course ledger: filter by lecturer, assign/reassign/resign
   lecturers, and delete courses.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    const courseList = document.getElementById('hod-course-list');
    const lecturerFilter = document.getElementById('lecturer-filter');
    const courseCount = document.getElementById('course-count');
    const assignModal = document.getElementById('assign-modal');
    const deleteModal = document.getElementById('delete-modal');
    const assignCourseName = document.getElementById('assign-modal-course');
    const assignLecturerSelect = document.getElementById('assign-lecturer-select');
    const confirmAssignBtn = document.getElementById('confirm-assign-btn');
    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    const confirmAssignSpinner = document.getElementById('confirm-assign-spinner');
    const confirmDeleteSpinner = document.getElementById('confirm-delete-spinner');
    const confirmAssignLabel = document.getElementById('confirm-assign-label');
    const confirmDeleteLabel = document.getElementById('confirm-delete-label');

    function setPending(btn, spinner, label, busy, text) {
        btn.disabled = busy;
        if (spinner) spinner.hidden = !busy;
        label.textContent = text;
    }

    let deptCourses = [];
    let activeCourse = null;

    function openModal(modal) { modal.hidden = false; }
    function closeModal(modal) { modal.hidden = true; }

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = document.getElementById(btn.dataset.closeModal);
            if (modal) closeModal(modal);
        });
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal(overlay);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay:not([hidden])').forEach(closeModal);
        }
    });

    document.getElementById('dept-name').textContent = user.department || 'Department';
    document.getElementById('user-avatar').textContent = (user.full_name || 'H').charAt(0).toUpperCase();

    attachLogout('logout-btn');
    initProfilePopup();

    async function resignCourse(course) {
        try {
            const response = await authFetch(`${API_BASE}/api/courses/${course.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lecturer_id: null })
            });
            const data = await response.json().catch(() => ({}));
            if (response.ok) {
                showToast(`${course.code || course.title} resigned. The course is now unassigned.`, 'success');
                invalidateApiCache('hod-catalog');
                invalidateApiCache('lect-my-courses');
                loadCourses();
            } else {
                showToast('Failed to resign course: ' + (data.detail || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Resign course error:', err);
            showToast('Server connection failed.', 'error');
        }
    }

    function openDeleteModal(course) {
        activeCourse = course;
        const name = `${course.code || 'N/A'} - ${course.title}`;
        document.getElementById('delete-modal-text').textContent =
            `Are you sure you want to delete "${name}"? This will permanently remove its enrollments, materials, quizzes, and all related data.`;
        openModal(deleteModal);
    }

    async function confirmDelete() {
        if (!activeCourse) return;
        const course = activeCourse;
        setPending(confirmDeleteBtn, confirmDeleteSpinner, confirmDeleteLabel, true, 'Deleting…');
        try {
            const response = await authFetch(`${API_BASE}/api/courses/${course.id}`, { method: 'DELETE' });
            const data = await response.json().catch(() => ({}));
            if (response.ok) {
                showToast(`${course.code || course.title} deleted.`, 'success');
                invalidateApiCache('hod-catalog');
                invalidateApiCache('lect-my-courses');
                invalidateApiCache('hod-dept-summary');
                invalidateApiCache(`lect-summary:${course.id}`);
                invalidateApiCache(`lect-at-risk:${course.id}`);
                closeModal(deleteModal);
                loadCourses();
            } else {
                showToast('Failed to delete course: ' + (data.detail || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Delete course error:', err);
            showToast('Server connection failed.', 'error');
        } finally {
            setPending(confirmDeleteBtn, confirmDeleteSpinner, confirmDeleteLabel, false, 'Delete Course');
        }
    }

    async function openAssignModal(course) {
        activeCourse = course;
        assignCourseName.textContent = `Assign a lecturer to ${course.code || 'N/A'} - ${course.title}`;
        assignLecturerSelect.innerHTML = '<option value="" disabled>Loading lecturers…</option>';
        openModal(assignModal);
        try {
            const response = await authFetch(`${API_BASE}/api/users/lecturers`);
            const lecturers = await response.json();
            assignLecturerSelect.innerHTML = `
                <option value="" disabled selected>Select a department lecturer</option>
                ${lecturers.map(l => `
                    <option value="${l.id}">${l.full_name}${l.id === user.id ? ' (you)' : ''}</option>
                `).join('')}
            `;
            if (course.lecturer_id) {
                const existing = assignLecturerSelect.querySelector(`option[value="${course.lecturer_id}"]`);
                if (existing) existing.selected = true;
            }
        } catch (err) {
            console.error('Error loading lecturers:', err);
            assignLecturerSelect.innerHTML = '<option value="" disabled>Lecturers unavailable</option>';
        }
    }

    async function confirmAssign() {
        if (!activeCourse) return;
        const lecturerId = assignLecturerSelect.value;
        if (!lecturerId) {
            showToast('Please select a lecturer.', 'warning');
            return;
        }
        const course = activeCourse;
        setPending(confirmAssignBtn, confirmAssignSpinner, confirmAssignLabel, true, 'Assigning…');
        try {
            const response = await authFetch(`${API_BASE}/api/courses/${course.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lecturer_id: lecturerId })
            });
            const data = await response.json().catch(() => ({}));
            if (response.ok) {
                showToast(`${course.code || course.title} assigned to the selected lecturer.`, 'success');
                invalidateApiCache('hod-catalog');
                invalidateApiCache('lect-my-courses');
                closeModal(assignModal);
                loadCourses();
            } else {
                showToast('Failed to assign lecturer: ' + (data.detail || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Assign course error:', err);
            showToast('Server connection failed.', 'error');
        } finally {
            setPending(confirmAssignBtn, confirmAssignSpinner, confirmAssignLabel, false, 'Assign');
        }
    }

    function populateLecturerFilter(courses) {
        const current = lecturerFilter.value;
        const byLecturer = new Map();
        (Array.isArray(courses) ? courses : []).forEach(c => {
            if (c.lecturer_id && !byLecturer.has(c.lecturer_id)) {
                byLecturer.set(c.lecturer_id, c.lecturer_name || 'Unnamed lecturer');
            }
        });
        let options = '<option value="">All lecturers</option>';
        byLecturer.forEach((name, id) => {
            options += `<option value="${id}">${name}</option>`;
        });
        options += '<option value="unassigned">Unassigned</option>';
        lecturerFilter.innerHTML = options;
        const keepable = current === '' || current === 'unassigned' || byLecturer.has(current);
        lecturerFilter.value = keepable ? current : '';
    }

    function renderDeptTable() {
        const filter = lecturerFilter.value;
        let filtered = deptCourses;
        if (filter === 'unassigned') {
            filtered = deptCourses.filter(c => !c.lecturer_id);
        } else if (filter) {
            filtered = deptCourses.filter(c => c.lecturer_id === filter);
        }

        const total = deptCourses.length;
        const unassignedCount = deptCourses.filter(c => !c.lecturer_id).length;
        if (total === 0) {
            courseCount.textContent = 'No courses yet';
        } else if (filter) {
            courseCount.textContent = `${filtered.length} of ${total} course${total === 1 ? '' : 's'}`;
        } else {
            courseCount.textContent = `${total} course${total === 1 ? '' : 's'} \u00B7 ${unassignedCount} unassigned`;
        }

        if (filtered.length === 0) {
            courseList.innerHTML = `
                <tr>
                    <td colspan="3" class="empty-cell">
                        <p class="text-muted">No courses match this filter.</p>
                    </td>
                </tr>`;
            return;
        }

        courseList.innerHTML = filtered.map(course => {
            const assigned = !!course.lecturer_id;
            const lecturerCell = assigned
                ? `<span class="lecturer-cell">${course.lecturer_name}${course.lecturer_id === user.id ? ' <span class="text-muted">(you)</span>' : ''}</span>`
                : '<span class="badge badge--unassigned">Unassigned</span>';
            return `
                <tr>
                    <td data-label="Course">
                        <span class="course-code">${course.code || 'N/A'}</span>
                        <span class="course-name">${course.title}</span>
                    </td>
                    <td data-label="Lecturer">${lecturerCell}</td>
                    <td data-label="Actions" class="actions-col">
                        <div class="course-actions">
                            <button class="course-action course-action--assign" data-assign="${course.id}" title="Assign a lecturer">
                                <i class="bi bi-person-plus"></i> ${assigned ? 'Reassign' : 'Assign'}
                            </button>
                            ${assigned ? `
                            <button class="course-action course-action--resign" data-resign="${course.id}" title="Resign the lecturer from this course">
                                <i class="bi bi-person-dash"></i> Resign
                            </button>` : ''}
                            <button class="course-action course-action--danger" data-delete="${course.id}" title="Delete course">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    async function loadCourses() {
        try {
            const courses = await authFetch(`${API_BASE}/api/courses/`)
                .then(r => r.ok ? r.json() : [])
                .catch(() => []);

            if (!Array.isArray(courses) || courses.length === 0) {
                deptCourses = [];
                courseCount.textContent = 'No courses yet';
                courseList.innerHTML = `
                    <tr>
                        <td colspan="3" class="empty-cell">
                            <p class="text-muted">No department courses found yet.</p>
                        </td>
                    </tr>`;
            } else {
                deptCourses = courses;
                populateLecturerFilter(courses);
                renderDeptTable();
            }
        } catch (err) {
            console.error('Department courses error:', err);
            courseCount.textContent = '';
            courseList.innerHTML = `
                <tr>
                    <td colspan="3" class="empty-cell">
                        <p class="text-muted">Unable to load department courses.</p>
                    </td>
                </tr>`;
            showToast('Unable to load department courses.', 'error');
        }
    }

    courseList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-assign], button[data-resign], button[data-delete]');
        if (!btn) return;
        const courseId = btn.dataset.assign || btn.dataset.resign || btn.dataset.delete;
        const course = deptCourses.find(c => c.id === courseId);
        if (!course) return;
        if (btn.hasAttribute('data-assign')) openAssignModal(course);
        else if (btn.hasAttribute('data-resign')) resignCourse(course);
        else if (btn.hasAttribute('data-delete')) openDeleteModal(course);
    });

    confirmDeleteBtn.addEventListener('click', confirmDelete);
    confirmAssignBtn.addEventListener('click', confirmAssign);
    lecturerFilter.addEventListener('change', renderDeptTable);

    loadCourses();
});
