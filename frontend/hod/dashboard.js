/*
   HOD DASHBOARD LOGIC
   frontend/hod/dashboard.js
   Fetches real data from Supabase via FastAPI backend.
   Renders the Department Pulse, stat tiles, dept-wide charts and the
   Attention Queue (HODs also act as lecturers), course-wise metrics,
   and the HOD's own classes. The department course ledger lives on
   department_courses.html (department_courses.js). All GETs go through
   the persist-until-reload cache: revisits within the session paint
   instantly without hitting the server; F5 or a stale cache refreshes.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    const deptName = document.getElementById('dept-name');
    const statCourses = document.getElementById('stat-courses');
    const statStudents = document.getElementById('stat-students');
    const courseMetricsList = document.getElementById('course-metrics-list');
    const myClassesList = document.getElementById('my-classes-list');
    const myClassesSub = document.getElementById('my-classes-sub');
    const queueBody = document.getElementById('queue-body');
    const cohortStrip = document.getElementById('cohort-strip');
    const attentionCount = document.getElementById('attention-count');
    const attentionCountSub = document.getElementById('attention-count-sub');

    const messageModal = document.getElementById('message-modal');
    let messageRecipient = null;
    let comprehensionChart = null;

    let deptCourses = [];

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

    deptName.textContent = user.department || 'Department';

    const firstName = user.full_name ? user.full_name.split(' ')[0] : 'Head of Department';
    document.getElementById('welcome-text').textContent = ghanaGreeting(firstName);
    document.getElementById('user-avatar').textContent = (user.full_name || 'H').charAt(0).toUpperCase();

    attachLogout('logout-btn');
    initProfilePopup();

    function animateCount(el, target) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const dur = reduce ? 0 : 650;
        const start = performance.now();
        function step(now) {
            const t = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = String(Math.round(target * eased));
            if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function setDeptPulse(atRisk, moderate, engaged, total, caption) {
        const pulseScoreEl = document.getElementById('dept-pulse-score');
        const pulseAtRiskEl = document.getElementById('dept-pulse-at-risk');
        const captionEl = document.getElementById('dept-pulse-caption');
        const segs = {
            risk: document.getElementById('dept-seg-risk'),
            mod: document.getElementById('dept-seg-mod'),
            engaged: document.getElementById('dept-seg-engaged'),
        };
        const legendRisk = document.getElementById('dept-legend-risk');
        const legendMod = document.getElementById('dept-legend-mod');
        const legendEngaged = document.getElementById('dept-legend-eng');
        if (total === 0) {
            pulseScoreEl.textContent = '--';
            pulseAtRiskEl.textContent = '0';
            segs.risk.style.width = '0%';
            segs.mod.style.width = '0%';
            segs.engaged.style.width = '0%';
            legendRisk.textContent = '0';
            legendMod.textContent = '0';
            legendEngaged.textContent = '0';
            captionEl.textContent = caption || 'No engagement data yet.';
            return;
        }
        animateCount(pulseScoreEl, Math.round(((moderate + engaged) / total) * 100));
        pulseAtRiskEl.textContent = String(atRisk);
        segs.risk.style.width = `${(atRisk / total) * 100}%`;
        segs.mod.style.width = `${(moderate / total) * 100}%`;
        segs.engaged.style.width = `${(engaged / total) * 100}%`;
        legendRisk.textContent = String(atRisk);
        legendMod.textContent = String(moderate);
        legendEngaged.textContent = String(engaged);
        captionEl.textContent = caption;
    }

    function renderCharts(comprehension) {
        const compCtx = document.getElementById('comprehension-chart');
        if (!compCtx || typeof Chart === 'undefined') return;

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

        if (comprehensionChart) comprehensionChart.destroy();

        const compData = (comprehension && typeof comprehension === 'object')
            ? [comprehension.low?.count || 0, comprehension.moderate?.count || 0, comprehension.good?.count || 0]
            : [0, 0, 0];

        comprehensionChart = new Chart(compCtx, {
            type: 'doughnut',
            data: {
                labels: ['Low', 'Moderate', 'Good'],
                datasets: [{
                    data: compData,
                    backgroundColor: ['#ef4444', '#f59e0b', '#22c55e'],
                    borderWidth: 0,
                    hoverOffset: 6
                }]
            },
            options: { ...baseOptions }
        });
    }

    // ── Attention queue helpers ─────────────────────────────────────────────
    function escapeHTML(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(str).replace(/[&<>"']/g, c => map[c]);
    }

    function severityOf(s) {
        const cls = Number(s.comprehension_class);
        if (cls === 0) return 0;   // low  -> highest urgency
        if (cls === 2) return 2;   // good
        return 1;                  // moderate
    }

    function severityClass(s) {
        const sev = severityOf(s);
        return sev === 0 ? 'low' : sev === 2 ? 'good' : 'mod';
    }

    function daysBetween(iso) {
        if (!iso) return null;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
    }

    function flagAgeLabel(iso) {
        const days = daysBetween(iso);
        if (days == null) return '';
        if (days === 0) return 'flagged today';
        return days === 1 ? 'flagged 1 day ago' : `flagged ${days} days ago`;
    }

    function idleLabel(days) {
        if (days == null) return 'last active —';
        if (days === 0) return 'active today';
        return days === 1 ? 'idle 1 day' : `idle ${days} days`;
    }

    function quizReadout(score) {
        if (score == null) return '<span class="meta-readout">quiz —</span>';
        const cls = score < 50 ? 'low' : score < 70 ? 'mod' : 'good';
        return `<span class="meta-readout meta-quiz quiz--${cls}">quiz ${Math.round(score)}%</span>`;
    }

    function allClearHTML(message) {
        return `
            <div class="queue-empty">
                <span class="queue-clear-ring"></span>
                <div>
                    <h4>All clear</h4>
                    <p class="text-muted">${message}</p>
                </div>
            </div>
        `;
    }

    function renderAttentionRow(row, courseLabel) {
        const displayName = row.full_name || (row.student_id || 'Unknown').substring(0, 8) + '…';
        const sev = severityClass(row);
        const lit = sev === 'low' ? 1 : sev === 'mod' ? 2 : 3;
        const reading = row.reading_minutes ? `${Math.round(row.reading_minutes)} min` : '—';
        return `
            <article class="attention-card" data-sev="${sev}">
                <div class="attention-card-head">
                    <div class="student-cell">
                        <span class="attention-ring" aria-hidden="true"></span>
                        <span class="attention-name">${escapeHTML(displayName)}</span>
                    </div>
                    <button class="attention-action btn-msg"
                        data-name="${escapeHTML(displayName)}"
                        data-id="${row.student_id}"
                        data-course="${escapeHTML(courseLabel)}"
                        data-course-id="${row.course_id}"><i class="bi bi-send" aria-hidden="true"></i> Reach out</button>
                </div>
                <div class="attention-card-meta">
                    <span class="status-cell">${flagAgeLabel(row.created_at)}</span>
                    <span>${quizReadout(row.latest_quiz_score)}</span>
                    <span class="meta-readout">reading ${reading}</span>
                    <span class="meta-readout">${idleLabel(row.days_since_last_activity)}</span>
                </div>
                <div class="attention-card-foot" aria-label="Comprehension: ${escapeHTML(row.comprehension_label || 'Unknown')}">
                    <div class="attention-comp">
                        <div class="comp-meter">
                            <span class="comp-seg ${1 <= lit ? 'is-on' : ''}"></span>
                            <span class="comp-seg ${2 <= lit ? 'is-on' : ''}"></span>
                            <span class="comp-seg ${3 <= lit ? 'is-on' : ''}"></span>
                        </div>
                        <span class="comp-label comp-label--${sev}">${escapeHTML(row.comprehension_label || 'Unknown')}</span>
                    </div>
                </div>
            </article>
        `;
    }

    // ── Messaging ─────────────────────────────────────────────────────────────
    function openMessage(studentName, studentId, courseLabel, courseId) {
        messageRecipient = { student_id: studentId, course_id: courseId };
        document.getElementById('message-to').textContent = `Message ${studentName}`;
        document.getElementById('message-course').textContent = courseLabel || '';
        document.getElementById('message-content').value = '';
        openModal(messageModal);
        document.getElementById('message-content').focus();
    }

    document.getElementById('message-send').addEventListener('click', async () => {
        const content = document.getElementById('message-content').value;
        if (!content.trim()) {
            showToast('Write a message before sending.', 'error');
            return;
        }
        const btn = document.getElementById('message-send');
        btn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/messages/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipient_id: messageRecipient.student_id,
                    course_id: messageRecipient.course_id,
                    content,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast(data.message || 'Message sent.', 'success');
                closeModal(messageModal);
            } else {
                showToast(data.detail || 'Could not send message.', 'error');
            }
        } catch (err) {
            showToast('Could not send message.', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    function renderCourseMetrics(summary, courseMap) {
        const byCourse = (summary && summary.by_course) || {};
        const entries = Object.entries(byCourse);
        if (entries.length === 0) {
            courseMetricsList.innerHTML = '<p class="text-muted">No engagement data yet — metrics will appear as students learn.</p>';
            return;
        }
        const sorted = entries
            .map(([id, d]) => ({ id, ...d }))
            .sort((a, b) => (b.high / b.total) - (a.high / a.total));

        courseMetricsList.innerHTML = sorted.map(c => {
            const info = courseMap[c.id];
            const name = info ? `${info.code || 'N/A'} · ${info.title}` : c.id;
            const riskPct = c.total > 0 ? (c.at_risk / c.total) * 100 : 0;
            const modPct = c.total > 0 ? (c.moderate / c.total) * 100 : 0;
            const goodPct = c.total > 0 ? (c.high / c.total) * 100 : 0;
            const atRiskPct = c.total > 0 ? (c.at_risk / c.total) * 100 : 0;
            let healthLabel, healthClass;
            if (c.total === 0) {
                healthLabel = 'No data';
                healthClass = 'muted';
            } else if (atRiskPct >= 30) {
                healthLabel = 'At Risk';
                healthClass = 'danger';
            } else if (atRiskPct >= 10) {
                healthLabel = 'Moderate';
                healthClass = 'warning';
            } else {
                healthLabel = 'Healthy';
                healthClass = 'success';
            }
            return `
                <div class="metric-item">
                    <div class="metric-head">
                        <span class="metric-name">${escapeHTML(name)}</span>
                        <span class="metric-health metric-health--${healthClass}">${healthLabel}</span>
                    </div>
                    <div class="metric-bar" role="img" aria-label="Engagement split for ${escapeHTML(name)}">
                        <span class="metric-seg metric-seg--risk" style="width:${riskPct}%"></span>
                        <span class="metric-seg metric-seg--mod" style="width:${modPct}%"></span>
                        <span class="metric-seg metric-seg--good" style="width:${goodPct}%"></span>
                    </div>
                    <div class="metric-meta">
                        <span>AT RISK <b>${c.at_risk}</b></span>
                        <span>MODERATE <b>${c.moderate}</b></span>
                        <span>HIGH <b>${c.high}</b></span>
                        <span>STUDENTS <b>${c.total}</b></span>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderAttentionQueue(courses) {
        const results = [];
        const courseMap = {};
        (Array.isArray(courses) ? courses : []).forEach(c => { courseMap[c.id] = c; });

        return Promise.all(courses.map(c =>
            swrGet(`lect-at-risk:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/at-risk`)
                .then(data => ({ course: c, students: data && data.students || [] }))
                .catch(() => ({ course: c, students: [] }))
        )).then(atRiskResults => {
            const groups = [];
            const groupMap = {};
            atRiskResults.forEach(({ course, students }) => {
                (students || []).forEach(s => {
                    if (!s || !s.student_id) return;
                    if (!groupMap[course.id]) {
                        groupMap[course.id] = {
                            courseId: course.id,
                            label: `${course.code || 'N/A'} · ${course.title}`,
                            students: [],
                        };
                        groups.push(groupMap[course.id]);
                    }
                    groupMap[course.id].students.push({
                        student_id: s.student_id,
                        course_id: course.id,
                        full_name: s.full_name || null,
                        comprehension_label: s.comprehension_label || 'Unknown',
                        comprehension_class: s.comprehension_class,
                        created_at: s.created_at,
                        reading_minutes: s.reading_minutes,
                        days_since_last_activity: s.days_since_last_activity,
                        latest_quiz_score: s.latest_quiz_score,
                    });
                });
            });

            // Worst first: lowest comprehension, then the flag that has sat longest.
            groups.forEach(g => {
                g.students.sort((a, b) => {
                    const sev = severityOf(a) - severityOf(b);
                    if (sev !== 0) return sev;
                    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
                });
            });
            groups.sort((a, b) => b.students.length - a.students.length);

            const totalFlagged = groups.reduce((n, g) => n + g.students.length, 0);
            attentionCount.textContent = String(totalFlagged);
            attentionCountSub.textContent = totalFlagged
                ? `across ${groups.length} course${groups.length === 1 ? '' : 's'}`
                : 'no one flagged';

            if (totalFlagged === 0) {
                cohortStrip.hidden = true;
                queueBody.innerHTML = allClearHTML('No students are flagged right now — everyone is keeping pace.');
            } else {
                cohortStrip.hidden = false;
                cohortStrip.innerHTML = groups.map(g => `
                    <span class="cohort-group" title="${escapeHTML(g.label)}">
                        ${g.students.map(s => {
                            const name = s.full_name || s.student_id.substring(0, 8);
                            return `<span class="cohort-dot cohort-dot--${severityClass(s)}" title="${escapeHTML(name)}"></span>`;
                        }).join('')}
                    </span>
                `).join('');

                queueBody.innerHTML = groups.map(g => `
                    <div class="queue-course">
                        <div class="queue-course-head">
                            <span class="queue-course-code">${escapeHTML(g.label.split(' · ')[0])}</span>
                            <h4 class="queue-course-title">${escapeHTML(g.label.split(' · ').slice(1).join(' · '))}</h4>
                            <span class="queue-course-count">${g.students.length} flagged</span>
                        </div>
                        <div class="queue-cards">
                            ${g.students.map(row => renderAttentionRow(row, g.label)).join('')}
                        </div>
                    </div>
                `).join('');

                queueBody.querySelectorAll('.attention-action').forEach(btn => {
                    btn.addEventListener('click', () => openMessage(btn.dataset.name, btn.dataset.id, btn.dataset.course, btn.dataset.courseId || null));
                });
            }
        });
    }

    async function loadDashboard() {
        try {
            const [deptSummary, courses] = await Promise.all([
                swrGet('hod-dept-summary', `${API_BASE}/api/analytics/department/summary`).catch(() => null),
                swrGet('hod-catalog', `${API_BASE}/api/courses/`).catch(() => []),
            ]);

            statCourses.textContent = Array.isArray(courses) ? courses.length : 0;
            statStudents.textContent = (deptSummary && deptSummary.total_students) || 0;

            if (deptSummary && deptSummary.total_records > 0) {
                const eng = deptSummary.department_engagement || {};
                const atRisk = eng.at_risk?.count || 0;
                const moderate = eng.moderate?.count || 0;
                const high = eng.highly_engaged?.count || 0;
                const total = deptSummary.classified_students || atRisk + moderate + high;

                setDeptPulse(atRisk, moderate, high, total,
                    atRisk > 0
                        ? `${atRisk} student${atRisk === 1 ? '' : 's'} across the department need attention right now.`
                        : 'All students across the department are keeping pace.');
            } else {
                setDeptPulse(0, 0, 0, 0, 'No engagement data yet. When students start learning, their pulse will show here.');
            }

            renderCharts(
                deptSummary ? deptSummary.department_comprehension : null
            );

            const courseMap = {};
            deptCourses = Array.isArray(courses) ? courses : [];
            deptCourses.forEach(c => { courseMap[c.id] = c; });

            renderCourseMetrics(deptSummary, courseMap);

            // Attention queue — department-wide
            await renderAttentionQueue(deptCourses);

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
                        const s = await swrGet(`lect-summary:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/summary`)
                            .catch(() => null);
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
                                <span class="student-cell">${escapeHTML(row.course.code || 'N/A')} - ${escapeHTML(row.course.title)}</span>
                            </div>
                            <p class="text-muted my-class-none">No signals yet — students haven't engaged.</p>
                        </div>`
                    : `
                        <div class="my-class-item">
                            <div class="my-class-head">
                                <span class="student-cell">${escapeHTML(row.course.code || 'N/A')} - ${escapeHTML(row.course.title)}</span>
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
        } catch (err) {
            console.error('HOD dashboard error:', err);
            statCourses.textContent = '--';
            statStudents.textContent = '--';
            courseMetricsList.innerHTML = '<p class="text-muted">Unable to load analytics.</p>';
            myClassesList.innerHTML = '<p class="text-muted">Unable to load your classes.</p>';
            attentionCount.textContent = '--';
            attentionCountSub.textContent = '';
            cohortStrip.hidden = true;
            queueBody.innerHTML = '<div class="queue-error"><p class="text-muted" style="color:var(--clr-danger)">Unable to load dashboard data.</p></div>';
            showToast('Unable to load dashboard data.', 'error');
        }
    }

    loadDashboard();
});
