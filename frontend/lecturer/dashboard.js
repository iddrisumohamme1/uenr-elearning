/*
   LECTURER DASHBOARD LOGIC
   frontend/lecturer/dashboard.js
   Fetches real data from Supabase via FastAPI backend.
   Renders the Class Pulse, stat tiles, Chart.js distribution charts,
   and the at-risk student queue.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;

    const firstName = user.full_name ? user.full_name.split(' ')[0] : 'Lecturer';
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('welcome-text').textContent = `${timeGreeting}, ${firstName}`;
    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();

    const pulseScoreEl = document.getElementById('pulse-score');
    const pulseAtRiskEl = document.getElementById('pulse-at-risk');
    const pulseSegRisk = document.getElementById('pulse-seg-risk');
    const pulseSegMod = document.getElementById('pulse-seg-mod');
    const pulseSegEngaged = document.getElementById('pulse-seg-engaged');
    const pulseCaption = document.getElementById('pulse-caption');
    const totalStudentsEl = document.getElementById('total-students');
    const totalCoursesEl = document.getElementById('total-courses');
    const criticalStudentsEl = document.getElementById('critical-students');
    const tableBody = document.getElementById('real-time-body');

    let engagementChart = null;
    let comprehensionChart = null;

    attachLogout('logout-btn');
    initProfilePopup();

    function setPulse(atRisk, moderate, engaged, caption) {
        const total = atRisk + moderate + engaged;
        if (total === 0) {
            pulseScoreEl.textContent = '--';
            pulseSegRisk.style.width = '0%';
            pulseSegMod.style.width = '0%';
            pulseSegEngaged.style.width = '0%';
            pulseAtRiskEl.textContent = '0';
            pulseCaption.textContent = caption || 'No engagement data yet.';
            return;
        }
        pulseScoreEl.textContent = Math.round(((moderate + engaged) / total) * 100);
        pulseSegRisk.style.width = `${(atRisk / total) * 100}%`;
        pulseSegMod.style.width = `${(moderate / total) * 100}%`;
        pulseSegEngaged.style.width = `${(engaged / total) * 100}%`;
        pulseAtRiskEl.textContent = String(atRisk);
        pulseCaption.textContent = caption || 'Reach out to the students flagged below.';
    }

    function renderCharts(engagementCounts, comprehensionCounts) {
        const engCtx = document.getElementById('engagement-chart');
        const compCtx = document.getElementById('comprehension-chart');
        if (!engCtx || !compCtx || typeof Chart === 'undefined') return;

        const chartFont = { family: "'Inter', sans-serif", weight: '600' };
        const baseOptions = {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { font: chartFont, padding: 12, usePointStyle: true, pointStyleWidth: 9 }
                }
            }
        };

        if (engagementChart) engagementChart.destroy();
        if (comprehensionChart) comprehensionChart.destroy();

        engagementChart = new Chart(engCtx, {
            type: 'doughnut',
            data: {
                labels: ['At Risk', 'Moderate', 'Engaged'],
                datasets: [{
                    data: [engagementCounts.atRisk, engagementCounts.moderate, engagementCounts.highlyEngaged],
                    backgroundColor: ['#ef4444', '#f59e0b', '#06b6d4'],
                    borderWidth: 0,
                    hoverOffset: 6
                }]
            },
            options: { ...baseOptions }
        });

        comprehensionChart = new Chart(compCtx, {
            type: 'doughnut',
            data: {
                labels: ['Low', 'Moderate', 'Good'],
                datasets: [{
                    data: [comprehensionCounts.low, comprehensionCounts.moderate, comprehensionCounts.good],
                    backgroundColor: ['#ef4444', '#f59e0b', '#22c55e'],
                    borderWidth: 0,
                    hoverOffset: 6
                }]
            },
            options: { ...baseOptions }
        });
    }

    async function loadDashboard() {
        try {
            const coursesRes = await authFetch(`${API_BASE}/api/courses/mine`);
            const courses = await coursesRes.json().catch(() => []);

            if (!Array.isArray(courses) || courses.length === 0) {
                setPulse(0, 0, 0, 'No courses assigned yet. Upload content or create a quiz to get started.');
                totalCoursesEl.textContent = '0';
                totalStudentsEl.textContent = '0';
                criticalStudentsEl.textContent = '0';
                tableBody.innerHTML = '<tr><td colspan="4" class="table-loading"><p class="text-muted">No courses assigned yet. Upload content or create a quiz to get started.</p></td></tr>';
                return;
            }

            totalCoursesEl.textContent = String(courses.length);

            const summaries = await Promise.all(
                courses.map(c => authFetch(`${API_BASE}/api/analytics/course/${c.id}/summary`)
                    .then(r => r.json().catch(() => null))
                    .catch(() => null))
            );

            let totalAtRisk = 0;
            let totalModerate = 0;
            let totalEngaged = 0;
            let totalUniqueStudents = 0;
            let engagementCounts = { atRisk: 0, moderate: 0, highlyEngaged: 0 };
            let comprehensionCounts = { low: 0, moderate: 0, good: 0 };

            summaries.forEach(s => {
                if (!s || typeof s !== 'object') return;
                totalUniqueStudents += s.unique_students || 0;
                engagementCounts.atRisk += s.engagement?.at_risk?.count || 0;
                engagementCounts.moderate += s.engagement?.moderate?.count || 0;
                engagementCounts.highlyEngaged += s.engagement?.highly_engaged?.count || 0;
                comprehensionCounts.low += s.comprehension?.low?.count || 0;
                comprehensionCounts.moderate += s.comprehension?.moderate?.count || 0;
                comprehensionCounts.good += s.comprehension?.good?.count || 0;
            });

            totalAtRisk = engagementCounts.atRisk;
            totalModerate = engagementCounts.moderate;
            totalEngaged = engagementCounts.highlyEngaged;

            const caption = totalAtRisk > 0
                ? 'Reach out to the students flagged below.'
                : 'All students are keeping pace.';

            setPulse(totalAtRisk, totalModerate, totalEngaged, caption);
            totalStudentsEl.textContent = String(totalUniqueStudents);
            criticalStudentsEl.textContent = String(totalAtRisk);

            renderCharts(engagementCounts, comprehensionCounts);

            const atRiskResults = await Promise.all(
                courses.map(c =>
                    authFetch(`${API_BASE}/api/analytics/course/${c.id}/at-risk`)
                        .then(r => r.json().catch(() => null))
                        .then(data => ({ course: c, students: data && data.students || [] }))
                        .catch(() => ({ course: c, students: [] }))
                )
            );

            const atRiskRows = [];
            atRiskResults.forEach(({ course, students }) => {
                (students || []).forEach(s => {
                    atRiskRows.push({
                        student_id: s.student_id,
                        full_name: s.full_name || null,
                        course: `${course.code || 'N/A'} - ${course.title}`,
                        comprehension: s.comprehension_label || 'Unknown'
                    });
                });
            });

            if (atRiskRows.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="4" class="table-loading"><p class="text-muted">No students are at risk right now.</p></td></tr>';
            } else {
                tableBody.innerHTML = atRiskRows.slice(0, 15).map(row => {
                    const displayName = row.full_name || (row.student_id || 'Unknown').substring(0, 8) + '…';
                    return `
                        <tr>
                            <td class="student-cell">${displayName}</td>
                            <td>${row.course}</td>
                            <td><span class="badge badge--warning">${row.comprehension}</span></td>
                            <td><span class="badge badge--danger">At Risk</span></td>
                        </tr>
                    `;
                }).join('');
            }
        } catch (err) {
            console.error('Lecturer dashboard error:', err);
            setPulse(0, 0, 0, "Couldn't reach the server. Refresh to try again.");
            totalStudentsEl.textContent = '--';
            totalCoursesEl.textContent = '--';
            criticalStudentsEl.textContent = '--';
            tableBody.innerHTML = '<tr><td colspan="4" class="table-loading"><p style="color:var(--clr-danger)">Unable to load dashboard data.</p></td></tr>';
            showToast('Unable to load dashboard data.', 'error');
        }
    }

    loadDashboard();
});
