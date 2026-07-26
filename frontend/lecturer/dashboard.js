/*
   LECTURER DASHBOARD LOGIC
   frontend/lecturer/dashboard.js
   Fetches real data from Supabase via FastAPI backend.
   Renders Chart.js charts for engagement + comprehension distribution.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;

    document.getElementById('welcome-text').textContent = `Welcome, ${user.full_name.split(' ')[0]}`;
    document.getElementById('user-name').textContent = user.full_name;
    document.getElementById('user-avatar').textContent = user.full_name.charAt(0).toUpperCase();

    const totalStudentsEl = document.getElementById('total-students');
    const avgEngagementEl = document.getElementById('avg-engagement');
    const criticalStudentsEl = document.getElementById('critical-students');
    const tableBody = document.getElementById('real-time-body');

    let engagementChart = null;
    let comprehensionChart = null;

    attachLogout('logout-btn');
    initProfilePopup();

    function renderCharts(engagementCounts, comprehensionCounts) {
        const engCtx = document.getElementById('engagement-chart');
        const compCtx = document.getElementById('comprehension-chart');
        if (!engCtx || !compCtx || typeof Chart === 'undefined') return;

        const chartFont = { family: "'Inter', sans-serif" };

        if (engagementChart) engagementChart.destroy();
        if (comprehensionChart) comprehensionChart.destroy();

        engagementChart = new Chart(engCtx, {
            type: 'doughnut',
            data: {
                labels: ['At-Risk', 'Moderately Engaged', 'Highly Engaged'],
                datasets: [{
                    data: [engagementCounts.atRisk, engagementCounts.moderate, engagementCounts.highlyEngaged],
                    backgroundColor: ['#ef4444', '#f59e0b', '#22c55e'],
                    borderWidth: 0,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { font: chartFont, padding: 16, usePointStyle: true, pointStyleWidth: 10 }
                    }
                }
            }
        });

        comprehensionChart = new Chart(compCtx, {
            type: 'doughnut',
            data: {
                labels: ['Low Comprehension', 'Moderate', 'Good Comprehension'],
                datasets: [{
                    data: [comprehensionCounts.low, comprehensionCounts.moderate, comprehensionCounts.good],
                    backgroundColor: ['#ef4444', '#f59e0b', '#22c55e'],
                    borderWidth: 0,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { font: chartFont, padding: 16, usePointStyle: true, pointStyleWidth: 10 }
                    }
                }
            }
        });
    }

    async function loadDashboard() {
        try {
            const coursesRes = await authFetch(`${API_BASE}/api/courses/mine`);
            const courses = await coursesRes.json();

            if (!Array.isArray(courses) || courses.length === 0) {
                totalStudentsEl.textContent = '0';
                avgEngagementEl.textContent = '0%';
                criticalStudentsEl.textContent = '0';
                tableBody.innerHTML = '<tr><td colspan="4" class="table-loading" style="color:var(--text-muted); padding:var(--s6);">No courses assigned yet.</td></tr>';
                return;
            }

            const summaries = await Promise.all(
                courses.map(c => authFetch(`${API_BASE}/api/analytics/course/${c.id}/summary`).then(r => r.json()).catch(() => null))
            );

            let totalAtRisk = 0;
            let totalEngagedPct = 0;
            let validCount = 0;
            let totalUniqueStudents = 0;
            let engagementCounts = { atRisk: 0, moderate: 0, highlyEngaged: 0 };
            let comprehensionCounts = { low: 0, moderate: 0, good: 0 };

            summaries.forEach(s => {
                if (!s) return;
                totalUniqueStudents += s.unique_students || 0;
                totalAtRisk += s.engagement?.at_risk?.count || 0;
                if (s.engagement?.highly_engaged?.pct != null) {
                    totalEngagedPct += s.engagement.highly_engaged.pct;
                    validCount += 1;
                }
                engagementCounts.atRisk += s.engagement?.at_risk?.count || 0;
                engagementCounts.moderate += s.engagement?.moderate?.count || 0;
                engagementCounts.highlyEngaged += s.engagement?.highly_engaged?.count || 0;
                comprehensionCounts.low += s.comprehension?.low?.count || 0;
                comprehensionCounts.moderate += s.comprehension?.moderate?.count || 0;
                comprehensionCounts.good += s.comprehension?.good?.count || 0;
            });

            totalStudentsEl.textContent = String(totalUniqueStudents);
            avgEngagementEl.textContent = `${validCount ? Math.round(totalEngagedPct / validCount) : 0}%`;
            criticalStudentsEl.textContent = String(totalAtRisk);

            renderCharts(engagementCounts, comprehensionCounts);

            const atRiskResults = await Promise.all(
                courses.map(c =>
                    authFetch(`${API_BASE}/api/analytics/course/${c.id}/at-risk`)
                        .then(r => r.json())
                        .then(data => ({ course: c, students: data.students || [] }))
                        .catch(() => ({ course: c, students: [] }))
                )
            );

            const atRiskRows = [];
            atRiskResults.forEach(({ course, students }) => {
                students.forEach(s => {
                    atRiskRows.push({
                        student_id: s.student_id,
                        course: `${course.code || 'N/A'} - ${course.title}`,
                        comprehension: s.comprehension_label || 'Unknown'
                    });
                });
            });

            if (atRiskRows.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="4" class="table-loading" style="color:var(--text-muted); padding:var(--s6);">No at-risk students detected.</td></tr>';
            } else {
                tableBody.innerHTML = atRiskRows.slice(0, 15).map(row => `
                    <tr>
                        <td>${row.student_id.substring(0, 8)}...</td>
                        <td>${row.course}</td>
                        <td><span class="badge badge--warning">${row.comprehension}</span></td>
                        <td><span class="badge badge--danger">At Risk</span></td>
                    </tr>
                `).join('');
            }
        } catch (err) {
            console.error('Lecturer dashboard error:', err);
            totalStudentsEl.textContent = '0';
            avgEngagementEl.textContent = '0%';
            criticalStudentsEl.textContent = '0';
            tableBody.innerHTML = '<tr><td colspan="4" class="table-loading" style="color:var(--clr-danger); padding:var(--s6);">Unable to load dashboard data.</td></tr>';
            showToast('Unable to load dashboard data.', 'error');
        }
    }

    loadDashboard();
});
