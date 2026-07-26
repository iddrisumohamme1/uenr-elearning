/* 
   COURSES MODULE LOGIC
   frontend/courses/courses.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();

    let enrolledCourseIds = new Set();
    let allCourses = [];
    let currentTab = 'enrolled';

    async function loadEnrolledCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/students/${user.id}/courses`);
            if (!res.ok) throw new Error('Failed');
            const courses = await res.json();
            enrolledCourseIds = new Set(courses.map(c => c.id));
        } catch (err) {
            console.error('Error loading enrolled courses:', err);
        }
    }

    async function loadAllCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/courses/`);
            if (!res.ok) throw new Error('Failed');
            allCourses = await res.json();
        } catch (err) {
            console.error('Error loading courses:', err);
            allCourses = [];
        }
    }

    function renderCourses(courses) {
        const grid = document.getElementById('courses-grid');
        if (!courses.length) {
            grid.innerHTML = '<p class="text-muted">No courses found.</p>';
            return;
        }

        grid.innerHTML = courses.map(course => {
            const isEnrolled = enrolledCourseIds.has(course.id);
            return `
                <div class="course-card">
                    <span class="course-code">${course.code || 'UENR'}</span>
                    <h3 class="course-title">${course.title}</h3>
                    <p class="course-lecturer">By ${course.lecturer_name || 'Unknown Lecturer'}</p>
                    ${isEnrolled
                        ? '<button class="btn-enroll enrolled" disabled>Enrolled</button>'
                        : `<button class="btn-enroll" onclick="window.enroll('${course.id}')">Enroll Now</button>`
                    }
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

    window.enroll = async (courseId) => {
        try {
            const res = await authFetch(`${API_BASE}/api/courses/enroll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ student_id: user.id, course_id: courseId })
            });

            if (res.ok) {
                enrolledCourseIds.add(courseId);
                filterAndRender();
            } else {
                const data = await res.json();
                showToast(data.detail || 'Enrollment failed.', 'error');
            }
        } catch (err) {
            console.error('Enrollment error:', err);
            showToast('Enrollment failed. Please try again.', 'error');
        }
    };

    await Promise.all([loadEnrolledCourses(), loadAllCourses()]);
    filterAndRender();
});
