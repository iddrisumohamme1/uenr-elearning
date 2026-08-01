/*
   HOD DASHBOARD LOGIC
   frontend/hod/dashboard.js
   Fetches real data from Supabase via FastAPI backend.
   Renders the Department Pulse, stat tiles, the HOD's own classes
   (HODs can teach too), and department course lists.
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
    const myClassesList = document.getElementById('my-classes-list');
    const myClassesSub = document.getElementById('my-classes-sub');

    deptName.textContent = user.department || 'Department';

    const firstName = user.full_name ? user.full_name.split(' ')[0] : 'Head of Department';
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('welcome-text').textContent = `${timeGreeting}, ${firstName}`;
    document.getElementById('user-avatar').textContent = (user.full_name || 'H').charAt(0).toUpperCase();

    attachLogout('logout-btn');
    initProfilePopup();

    function setDeptPulse(atRisk, moderate, engaged, total, caption) {
        const pulseScoreEl = document.getElementById('dept-pulse-score');
        const pulseAtRiskEl = document.getElementById('dept-pulse-at-risk');
        const captionEl = document.getElementById('dept-pulse-caption');
        const segs = {
            risk: document.getElementById('dept-seg-risk'),
            mod: document.getElementById('dept-seg-mod'),
            engaged: document.getElementById('dept-seg-engaged'),
        };
        if (total === 0) {
            pulseScoreEl.textContent = '--';
            pulseAtRiskEl.textContent = '0';
            segs.risk.style.width = '0%';
            segs.mod.style.width = '0%';
            segs.engaged.style.width = '0%';
            captionEl.textContent = caption || 'No engagement data yet.';
            return;
        }
        pulseScoreEl.textContent = Math.round(((moderate + engaged) / total) * 100);
        pulseAtRiskEl.textContent = String(atRisk);
        segs.risk.style.width = `${(atRisk / total) * 100}%`;
        segs.mod.style.width = `${(moderate / total) * 100}%`;
        segs.engaged.style.width = `${(engaged / total) * 100}%`;
        captionEl.textContent = caption;
    }

    async function loadDashboard() {
        try {
            const [deptSummary, courses] = await Promise.all([
                authFetch(`${API_BASE}/api/analytics/department/summary`).then(r => r.ok ? r.json() : null).catch(() => null),
                authFetch(`${API_BASE}/api/courses/`).then(r => r.ok ? r.json() : []).catch(() => []),
            ]);

            statCourses.textContent = Array.isArray(courses) ? courses.length : 0;

            if (deptSummary && deptSummary.total_records > 0) {
                const eng = deptSummary.department_engagement || {};
                const atRisk = eng.at_risk?.count || 0;
                const moderate = eng.moderate?.count || 0;
                const high = eng.highly_engaged?.count || 0;
                const total = deptSummary.total_records;

                setDeptPulse(atRisk, moderate, high, total,
                    atRisk > 0
                        ? `${atRisk} student${atRisk === 1 ? '' : 's'} across the department need attention right now.`
                        : 'All students across the department are keeping pace.');

                const moderatePct = eng.moderate?.pct || 0;
                const highPct = eng.highly_engaged?.pct || 0;
                statEngagement.textContent = `${Math.round((moderatePct + highPct * 2) / 2)}%`;
                statAtRisk.textContent = String(atRisk);
            } else {
                setDeptPulse(0, 0, 0, 0, 'No engagement data yet. When students start learning, their pulse will show here.');
                statEngagement.textContent = '0%';
                statAtRisk.textContent = '0';
            }

            const courseMap = {};
            (Array.isArray(courses) ? courses : []).forEach(c => { courseMap[c.id] = c; });

            // My Classes — HODs can teach too
            const myCourses = (Array.isArray(courses) ? courses : []).filter(c => c.lecturer_id === user.id);
            if (myCourses.length === 0) {
                myClassesSub.textContent = 'You teach 0 courses';
                myClassesList.innerHTML = `
                    <div class="my-class-empty">
                        <p class="text-muted">You're not teaching a course yet.</p>
                        <a href="create_course.html" class="btn-auth btn-sm">Add a course and assign yourself</a>
                    </div>
                `;
            } else {
                myClassesSub.textContent = `You teach ${myCourses.length} course${myCourses.length === 1 ? '' : 's'}`;
                const rows = await Promise.all(myCourses.map(async c => {
                    try {
                        const s = await authFetch(`${API_BASE}/api/analytics/course/${c.id}/summary`)
                            .then(r => r.ok ? r.json() : null);
                        if (!s || !s.total_logs) return { course: c, empty: true };
                        const e = s.engagement || {};
                        const total = s.total_logs;
                        const r = e.at_risk?.count || 0;
                        const m = e.moderate?.count || 0;
                        const h = e.highly_engaged?.count || 0;
                        return {
                            course: c, empty: false, atRisk: r,
                            riskPct: Math.round((r / total) * 100),
                            modPct: Math.round((m / total) * 100),
                            engPct: Math.round((h / total) * 100),
                        };
                    } catch {
                        return { course: c, empty: true };
                    }
                }));
                myClassesList.innerHTML = rows.map(row => row.empty
                    ? `
                        <div class="my-class-item">
                            <div class="my-class-head">
                                <span class="student-cell">${row.course.code || 'N/A'} - ${row.course.title}</span>
                            </div>
                            <p class="text-muted my-class-none">No signals yet — students haven't engaged.</p>
                        </div>`
                    : `
                        <div class="my-class-item">
                            <div class="my-class-head">
                                <span class="student-cell">${row.course.code || 'N/A'} - ${row.course.title}</span>
                                <span class="badge badge--danger">${row.atRisk} at risk</span>
                            </div>
                            <div class="pulse-bar pulse-bar--sm">
                                <span class="pulse-seg pulse-seg--risk" style="width:${row.riskPct}%"></span>
                                <span class="pulse-seg pulse-seg--mod" style="width:${row.modPct}%"></span>
                                <span class="pulse-seg pulse-seg--engaged" style="width:${row.engPct}%"></span>
                            </div>
                        </div>`
                ).join('');
            }

            // Top performing courses
            if (deptSummary && deptSummary.by_course && Object.keys(deptSummary.by_course).length > 0) {
                const sorted = Object.entries(deptSummary.by_course)
                    .map(([id, data]) => ({ id, ...data }))
                    .sort((a, b) => (b.high / b.total) - (a.high / a.total));

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

            // Department courses
            if (!Array.isArray(courses) || courses.length === 0) {
                courseList.innerHTML = '<p class="text-muted">No department courses found yet.</p>';
            } else {
                courseList.innerHTML = courses.map(course => `
                    <div class="course-item">
                        <span>${course.code || 'N/A'} - ${course.title}</span>
                        <span>${course.lecturer_name || 'Unassigned'}${course.lecturer_id === user.id ? ' (you)' : ''}</span>
                    </div>
                `).join('');
            }
        } catch (err) {
            console.error('HOD dashboard error:', err);
            statCourses.textContent = '--';
            statEngagement.textContent = '--%';
            statAtRisk.textContent = '--';
            topCoursesList.innerHTML = '<p class="text-muted">Unable to load analytics.</p>';
            courseList.innerHTML = '<p class="text-muted">Unable to load department courses.</p>';
            myClassesList.innerHTML = '<p class="text-muted">Unable to load your classes.</p>';
            showToast('Unable to load dashboard data.', 'error');
        }
    }

    loadDashboard();
});
