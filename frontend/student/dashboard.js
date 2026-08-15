/* 
   STUDENT DASHBOARD LOGIC
   frontend/student/dashboard.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    // Update Profile Info
    document.getElementById('welcome-text').textContent = `Welcome, ${user.full_name.split(' ')[0]}`;
    document.querySelector('.avatar').textContent = user.full_name.charAt(0).toUpperCase();

    attachLogout('logout-btn');
    initProfilePopup();

    async function loadStats() {
        try {
            const res = await authFetch(`${API_BASE}/api/students/${user.id}/stats`);
            if (!res.ok) throw new Error('Stats fetch failed');
            const stats = await res.json();
            document.getElementById('engagement-value').textContent = `${stats.engagement_score}%`;
            document.getElementById('courses-count').textContent = stats.enrolled_courses;
            document.getElementById('completed-count').textContent = stats.completed_topics;
        } catch (err) {
            console.error('Error loading stats:', err);
        }
    }

    async function loadStudyInsights() {
        try {
            const res = await authFetch(`${API_BASE}/api/study/summary/${user.id}`);
            if (!res.ok) throw new Error('Study summary failed');
            const data = await res.json();
            const overall = data.overall || {};
            document.getElementById('predicted-grade').textContent = overall.predicted_grade || '–';

            const warning = document.getElementById('study-warning');
            if (overall.active_warnings) {
                warning.hidden = false;
                document.getElementById('study-warning-text').textContent =
                    `${overall.active_warnings} of your courses need more study time this week. Click through to see how to improve your predicted grade.`;
            } else {
                warning.hidden = true;
            }
        } catch (err) {
            console.error('Error loading study insights:', err);
        }
    }

    async function loadCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/students/${user.id}/courses`);
            if (!res.ok) throw new Error('Courses fetch failed');
            const courses = await res.json();
            const grid = document.getElementById('course-grid');

            if (!courses.length) {
                grid.innerHTML = '<p class="text-muted">No courses enrolled yet. <a href="../courses/courses.html">Browse courses</a></p>';
                return;
            }

            grid.innerHTML = courses.map(course => `
                <div class="stat-card course-click" onclick="window.location.href='../materials/materials.html?id=${course.id}'">
                    <h4>${course.title}</h4>
                    <p class="text-muted course-lecturer-name">${course.lecturer_name || 'Unknown Lecturer'}</p>
                    <div class="progress-track">
                        <div class="progress-fill" style="width: ${course.progress || 0}%"></div>
                    </div>
                </div>
            `).join('');
        } catch (err) {
            console.error('Error loading courses:', err);
            grid.innerHTML = '<p style="color:var(--text-muted); padding:var(--s6);">Unable to load courses.</p>';
            showToast('Unable to load courses.', 'error');
        }
    }

    async function loadUnreadMessages() {
        try {
            const res = await authFetch(`${API_BASE}/api/messages/unread-count`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.unread_count > 0) {
                showToast(
                    `You have ${data.unread_count} unread message${data.unread_count > 1 ? 's' : ''} from your lecturer. Open the Inbox.`,
                    'info',
                    { title: 'New Message', duration: 8000 }
                );
            }
        } catch (err) {
            console.error('Error checking unread messages:', err);
        }
    }

    loadStats();
    loadStudyInsights();
    loadCourses();
    loadUnreadMessages();
});
