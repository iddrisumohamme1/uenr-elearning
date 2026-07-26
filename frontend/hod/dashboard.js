/*
   HOD DASHBOARD LOGIC
   frontend/hod/dashboard.js
   Fetches real data from Supabase via FastAPI backend.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    const deptName = document.getElementById('dept-name');
    const statCourses = document.getElementById('stat-courses');
    const statEngagement = document.getElementById('stat-engagement');
    const statAtRisk = document.getElementById('stat-at-risk');
    const topCoursesList = document.getElementById('top-courses-list');
    const courseList = document.getElementById('hod-course-list');

    deptName.textContent = user.department || 'Department of Computer Science & Informatics';

    const userNameEl = document.getElementById('user-name');
    const userAvatarEl = document.getElementById('user-avatar');
    if (userNameEl) userNameEl.textContent = user.full_name;
    if (userAvatarEl) userAvatarEl.textContent = user.full_name.charAt(0).toUpperCase();

    attachLogout('logout-btn');
    initProfilePopup();

    async function loadStats() {
        try {
            const deptSummary = await authFetch(`${API_BASE}/api/analytics/department/summary`).then(r => r.json());
            const courses = await authFetch(`${API_BASE}/api/courses/`).then(r => r.json());

            statCourses.textContent = courses.length || 0;

            if (deptSummary.total_records > 0) {
                const eng = deptSummary.department_engagement;
                const moderatePct = eng.moderate.pct || 0;
                const highPct = eng.highly_engaged.pct || 0;
                const avgScore = Math.round((moderatePct + highPct * 2) / 2);
                statEngagement.textContent = `${avgScore}%`;
                statAtRisk.textContent = eng.at_risk.count || 0;
            } else {
                statEngagement.textContent = '0%';
                statAtRisk.textContent = '0';
            }

            if (deptSummary.by_course && Object.keys(deptSummary.by_course).length > 0) {
                const sorted = Object.entries(deptSummary.by_course)
                    .map(([id, data]) => ({ id, ...data }))
                    .sort((a, b) => b.high - a.high);

                const courseMap = {};
                courses.forEach(c => { courseMap[c.id] = c; });

                const topHtml = sorted.slice(0, 5).map(c => {
                    const info = courseMap[c.id];
                    const name = info ? `${info.code || 'N/A'} - ${info.title}` : c.id;
                    const healthPct = c.total > 0 ? Math.round((c.high / c.total) * 100) : 0;
                    const healthLabel = healthPct >= 60 ? 'Healthy' : healthPct >= 30 ? 'Moderate' : 'At Risk';
                    const healthClass = healthPct >= 60 ? 'text-success' : healthPct >= 30 ? 'text-warning' : 'text-danger';
                    return `
                        <div class="course-item">
                            <span>${name}</span>
                            <span class="${healthClass}">${healthLabel} (${healthPct}%)</span>
                        </div>
                    `;
                }).join('');

                topCoursesList.innerHTML = topHtml || '<p class="text-muted">No engagement data yet.</p>';
            } else {
                topCoursesList.innerHTML = '<p class="text-muted">No engagement data yet.</p>';
            }
        } catch (err) {
            console.error('Error loading stats:', err);
            statCourses.textContent = '--';
            statEngagement.textContent = '--%';
            statAtRisk.textContent = '--';
            topCoursesList.innerHTML = '<p style="color:var(--clr-danger); padding:var(--s4);">Failed to load analytics.</p>';
            showToast('Failed to load analytics.', 'error');
        }
    }

    async function loadDepartmentCourses() {
        try {
            const courses = await authFetch(`${API_BASE}/api/courses/`).then(r => r.json());

            if (courses.length === 0) {
                courseList.innerHTML = '<p class="text-muted">No department courses found yet.</p>';
                return;
            }

            courseList.innerHTML = courses.map(course => `
                <div class="course-item">
                    <span>${course.code || 'N/A'} - ${course.title}</span>
                    <span>${course.lecturer_name || 'Unassigned'}</span>
                </div>
            `).join('');
        } catch (err) {
            console.error('Error loading department courses:', err);
            courseList.innerHTML = '<p style="color:var(--clr-danger); padding:var(--s4);">Failed to load department courses.</p>';
            showToast('Failed to load department courses.', 'error');
        }
    }

    await Promise.all([loadStats(), loadDepartmentCourses()]);
});
