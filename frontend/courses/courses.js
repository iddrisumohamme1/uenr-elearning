/* 
   COURSES MODULE LOGIC
   frontend/courses/courses.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.getElementById('user-avatar').textContent = (user.full_name || 'U').charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    let enrolledCourseIds = new Set();
    let allCourses = [];
    let currentTab = 'enrolled';

    async function loadEnrolledCourses() {
        try {
            await swrGet('my-courses', `${API_BASE}/api/students/${user.id}/courses`, courses => {
                enrolledCourseIds = new Set(courses.map(c => c.id));
                filterAndRender();
            });
        } catch (err) {
            console.error('Error loading enrolled courses:', err);
        }
    }

    async function loadAllCourses() {
        try {
            await swrGet('catalog', `${API_BASE}/api/courses/`, courses => {
                allCourses = courses;
                filterAndRender();
            });
        } catch (err) {
            console.error('Error loading courses:', err);
            allCourses = [];
        }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]
        ));
    }

    const findCourse = (courseId) => allCourses.find(c => c.id === courseId);

    function updateTabCounts() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            const count = btn.dataset.tab === 'enrolled'
                ? allCourses.filter(c => enrolledCourseIds.has(c.id)).length
                : allCourses.length;
            const pill = btn.querySelector('.tab-count');
            if (pill) pill.textContent = count;
        });
    }

    function emptyStateHtml(courses) {
        const query = document.getElementById('course-search').value.trim();
        if (query) {
            return `
                <div class="empty-state">
                    <i class="bi bi-search" aria-hidden="true"></i>
                    <h3>No matches</h3>
                    <p>Nothing matches "${escapeHtml(query)}". Try a course code, title, or lecturer name.</p>
                </div>`;
        }
        if (currentTab === 'enrolled') {
            return `
                <div class="empty-state">
                    <i class="bi bi-mortarboard" aria-hidden="true"></i>
                    <h3>No enrollments yet</h3>
                    <p>Open the All Courses tab and enroll to see your courses here.</p>
                </div>`;
        }
        return `
            <div class="empty-state">
                <i class="bi bi-collection" aria-hidden="true"></i>
                <h3>No courses available</h3>
                <p>Your department hasn't published any courses yet. Check back later.</p>
            </div>`;
    }

    function renderCourses(courses) {
        const grid = document.getElementById('courses-grid');
        updateTabCounts();

        if (!courses.length) {
            grid.innerHTML = emptyStateHtml(courses);
            return;
        }

        grid.innerHTML = courses.map(course => {
            const isEnrolled = enrolledCourseIds.has(course.id);
            return `
                <div class="course-card${isEnrolled ? ' is-enrolled' : ''}">
                    <span class="course-code">${escapeHtml(course.code || 'UENR')}</span>
                    <h3 class="course-title">${escapeHtml(course.title)}</h3>
                    <p class="course-lecturer"><i class="bi bi-person" aria-hidden="true"></i>${escapeHtml(course.lecturer_name || 'Unknown Lecturer')}</p>
                    <div class="card-actions">
                        ${isEnrolled
                            ? `<div class="card-state-row">
                                   <span class="enrolled-pill"><i class="bi bi-check-circle-fill" aria-hidden="true"></i>Enrolled</span>
                                   <button class="btn-unenroll" onclick="window.unenroll('${course.id}')">Unenroll</button>
                               </div>`
                            : `<button class="btn-enroll" onclick="window.enroll('${course.id}', this)">Enroll Now</button>`
                        }
                    </div>
                </div>
            `;
        }).join('');
    }

    function filterAndRender() {
        const query = document.getElementById('course-search').value.toLowerCase();
        let filtered = allCourses;

        if (currentTab === 'enrolled') {
            filtered = allCourses.filter(c => enrolledCourseIds.has(c.id));
        }

        if (query) {
            filtered = filtered.filter(c =>
                c.title.toLowerCase().includes(query) ||
                (c.lecturer_name && c.lecturer_name.toLowerCase().includes(query)) ||
                (c.code && c.code.toLowerCase().includes(query))
            );
        }

        renderCourses(filtered);
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            filterAndRender();
        });
    });

    document.getElementById('course-search').addEventListener('input', filterAndRender);

    // Courses with an enrollment request in flight — blocks duplicate clicks.
    const enrollingCourses = new Set();

    window.enroll = async (courseId, btn) => {
        if (enrollingCourses.has(courseId)) return;
        enrollingCourses.add(courseId);

        // Swap the clicked button into a loading state so the student can't
        // fire another enrollment while this one is in flight.
        const originalLabel = btn ? btn.textContent : 'Enroll Now';
        if (btn) {
            btn.classList.add('btn-loading');
            btn.disabled = true;
            btn.textContent = '';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            btn.appendChild(spinner);
        }

        const restoreBtn = () => {
            if (!btn || !btn.isConnected) return; // grid re-rendered; skip
            btn.classList.remove('btn-loading');
            btn.disabled = false;
            btn.textContent = originalLabel;
        };

        try {
            const res = await authFetch(`${API_BASE}/api/courses/enroll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ student_id: user.id, course_id: courseId })
            });

            if (res.ok) {
                const course = findCourse(courseId);
                enrolledCourseIds.add(courseId);
                invalidateApiCache('my-courses');
                invalidateApiCache('stats');
                invalidateApiCache('study-summary');
                invalidateApiCache('nav-stats');
                filterAndRender();
                showToast(
                    `You're enrolled in ${course ? course.title : 'the course'}.`,
                    'success',
                    { title: 'Enrolled' }
                );
            } else {
                let detail = 'Enrollment failed.';
                try {
                    const data = await res.json();
                    detail = data.detail || detail;
                } catch (_) { /* non-JSON error body */ }
                showToast(detail, 'error');
                restoreBtn();
            }
        } catch (err) {
            console.error('Enrollment error:', err);
            showToast('Enrollment failed. Please try again.', 'error');
            restoreBtn();
        } finally {
            enrollingCourses.delete(courseId);
        }
    };

    // Courses with an unenrollment request in flight — blocks duplicate clicks.
    const unenrollingCourses = new Set();

    const unenrollModal = document.getElementById('unenroll-modal');
    const unenrollCourseName = document.getElementById('unenroll-course-name');
    const confirmUnenrollBtn = document.getElementById('confirm-unenroll-btn');

    let pendingUnenrollId = null;
    let lastFocused = null;

    function openUnenrollModal(courseId) {
        const course = findCourse(courseId);
        if (!course || unenrollingCourses.has(courseId)) return;
        pendingUnenrollId = courseId;
        unenrollCourseName.textContent = course.title;
        lastFocused = document.activeElement;
        unenrollModal.hidden = false;
        unenrollModal.querySelector('.btn-ghost').focus(); // safe action first
    }

    function hideUnenrollModal() {
        unenrollModal.hidden = true;
        pendingUnenrollId = null;
        if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    }

    function closeUnenrollModal() {
        if (confirmUnenrollBtn.disabled) return; // request in flight — user dismissals blocked
        hideUnenrollModal();
    }

    unenrollModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', closeUnenrollModal));
    unenrollModal.addEventListener('click', e => {
        if (e.target === unenrollModal) closeUnenrollModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !unenrollModal.hidden) closeUnenrollModal();
    });

    confirmUnenrollBtn.addEventListener('click', async () => {
        const courseId = pendingUnenrollId;
        if (!courseId || unenrollingCourses.has(courseId)) return;
        unenrollingCourses.add(courseId);

        // Spinner inside the confirm button; modal stays put until we know
        // the outcome, so the student can't miss what happened.
        confirmUnenrollBtn.classList.add('btn-loading');
        confirmUnenrollBtn.disabled = true;
        confirmUnenrollBtn.textContent = '';
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        confirmUnenrollBtn.appendChild(spinner);

        try {
            const res = await authFetch(`${API_BASE}/api/courses/${courseId}/enroll`, { method: 'DELETE' });

            if (res.ok) {
                const course = findCourse(courseId);
                enrolledCourseIds.delete(courseId);
                invalidateApiCache('my-courses');
                invalidateApiCache('stats');
                invalidateApiCache('study-summary');
                invalidateApiCache('nav-stats');
                hideUnenrollModal();
                filterAndRender();
                showToast(
                    `You're no longer enrolled in ${course ? course.title : 'the course'}.`,
                    'success',
                    { title: 'Unenrolled' }
                );
            } else {
                let detail = 'Failed to unenroll.';
                try {
                    const data = await res.json();
                    detail = data.detail || detail;
                } catch (_) { /* non-JSON error body */ }
                showToast(detail, 'error');
                hideUnenrollModal();
            }
        } catch (err) {
            console.error('Unenrollment error:', err);
            showToast('Failed to unenroll. Please try again.', 'error');
            hideUnenrollModal();
        } finally {
            unenrollingCourses.delete(courseId);
            confirmUnenrollBtn.classList.remove('btn-loading');
            confirmUnenrollBtn.disabled = false;
            confirmUnenrollBtn.textContent = 'Unenroll';
        }
    });

    window.unenroll = openUnenrollModal;

    await Promise.all([loadEnrolledCourses(), loadAllCourses()]);
    filterAndRender();
});
