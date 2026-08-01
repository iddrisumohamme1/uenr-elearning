/*
   HOD DEPARTMENT ANALYTICS LOGIC
   frontend/hod/department_analytics.js
   Fetches all department analytics from Supabase via FastAPI backend.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    document.getElementById('dept-subtitle').textContent =
        `Aggregated data across all courses in ${user.department || 'your department'}`;

    attachLogout('logout-btn');
    initProfilePopup();

    async function loadAnalytics() {
        try {
            const [deptSummary, courses] = await Promise.all([
                authFetch(`${API_BASE}/api/analytics/department/summary`).then(r => r.ok ? r.json() : null),
                authFetch(`${API_BASE}/api/courses/`).then(r => r.ok ? r.json() : [])
            ]);

            document.getElementById('stat-total-courses').textContent = Array.isArray(courses) ? courses.length : 0;
            document.getElementById('stat-total-logs').textContent = (deptSummary && deptSummary.total_records) || 0;

            if (deptSummary && deptSummary.total_records > 0) {
                const eng = deptSummary.department_engagement;
                document.getElementById('stat-at-risk').textContent = eng.at_risk.count || 0;

                document.getElementById('bar-at-risk').style.width = `${eng.at_risk.pct}%`;
                document.getElementById('pct-at-risk').textContent = `${eng.at_risk.pct}%`;

                document.getElementById('bar-moderate').style.width = `${eng.moderate.pct}%`;
                document.getElementById('pct-moderate').textContent = `${eng.moderate.pct}%`;

                document.getElementById('bar-high').style.width = `${eng.highly_engaged.pct}%`;
                document.getElementById('pct-high').textContent = `${eng.highly_engaged.pct}%`;
            }

            const courseMap = {};
            (Array.isArray(courses) ? courses : []).forEach(c => { courseMap[c.id] = c; });

            if (deptSummary.by_course && Object.keys(deptSummary.by_course).length > 0) {
                const tbody = document.getElementById('course-table-body');
                const rows = Object.entries(deptSummary.by_course).map(([id, data]) => {
                    const info = courseMap[id];
                    const name = info ? `${info.code || 'N/A'} - ${info.title}` : id;
                    const healthPct = data.total > 0 ? Math.round((data.high / data.total) * 100) : 0;
                    const healthLabel = healthPct >= 60 ? 'Healthy' : healthPct >= 30 ? 'Moderate' : 'At Risk';
                    const healthClass = healthPct >= 60 ? 'text-success' : healthPct >= 30 ? 'text-warning' : 'text-danger';
                    return `
                        <tr>
                            <td style="padding: 1rem">${name}</td>
                            <td style="padding: 1rem">${data.total}</td>
                            <td style="padding: 1rem; color: var(--clr-danger)">${data.at_risk}</td>
                            <td style="padding: 1rem; color: var(--clr-warning)">${data.moderate}</td>
                            <td style="padding: 1rem; color: var(--clr-success)">${data.high}</td>
                            <td style="padding: 1rem"><span class="${healthClass}">${healthLabel}</span></td>
                        </tr>
                    `;
                }).join('');

                tbody.innerHTML = rows;
            } else {
                document.getElementById('course-table-body').innerHTML =
                    '<tr><td colspan="6" style="padding:1rem;text-align:center" class="text-muted">No engagement data available yet.</td></tr>';
            }
        } catch (err) {
            console.error('Error loading analytics:', err);
        }
    }

    async function loadAtRiskStudents() {
        const atRiskList = document.getElementById('at-risk-list');
        try {
            const courses = await authFetch(`${API_BASE}/api/courses/`).then(r => r.ok ? r.json() : []);
            const allAtRisk = [];

            if (!Array.isArray(courses)) {
                atRiskList.innerHTML = '<p class="text-muted">No at-risk students detected.</p>';
                return;
            }

            for (const course of courses) {
                try {
                    const atRisk = await authFetch(`${API_BASE}/api/analytics/course/${course.id}/at-risk`).then(r => r.json());
                    if (atRisk.students && atRisk.students.length > 0) {
                        atRisk.students.forEach(s => {
                            allAtRisk.push({
                                ...s,
                                course_name: `${course.code || 'N/A'} - ${course.title}`
                            });
                        });
                    }
                } catch (_) { /* skip courses without data */ }
            }

            if (allAtRisk.length === 0) {
                atRiskList.innerHTML = '<p class="text-muted">No at-risk students detected.</p>';
                return;
            }

            atRiskList.innerHTML = allAtRisk.slice(0, 10).map(s => `
                <div class="course-item">
                    <span>${s.course_name}</span>
                    <span class="text-danger">Student: ${(s.student_id || 'unknown').substring(0, 8)}...</span>
                </div>
            `).join('');
        } catch (err) {
            console.error('Error loading at-risk students:', err);
            atRiskList.innerHTML = '<p style="color:var(--clr-danger); padding:var(--s4);">Failed to load at-risk data.</p>';
            showToast('Failed to load at-risk data.', 'error');
        }
    }

    await Promise.all([loadAnalytics(), loadAtRiskStudents()]);
});
