/*
   LECTURER DASHBOARD LOGIC
   frontend/lecturer/dashboard.js
   Fetches real data from Supabase via FastAPI backend.
   Renders the Class Pulse, stat tiles, Chart.js distribution charts,
   and the at-risk student queue. All GETs go through the persist-until-
   reload cache: revisits within the session paint instantly without
   hitting the server; F5 or a stale cache refreshes.
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
    const legendRisk = document.getElementById('legend-risk');
    const legendMod = document.getElementById('legend-mod');
    const legendEngaged = document.getElementById('legend-eng');
    const totalStudentsEl = document.getElementById('total-students');
    const totalCoursesEl = document.getElementById('total-courses');
    const criticalStudentsEl = document.getElementById('critical-students');
    const queueBody = document.getElementById('queue-body');
    const cohortStrip = document.getElementById('cohort-strip');
    const attentionCount = document.getElementById('attention-count');
    const attentionCountSub = document.getElementById('attention-count-sub');

    let engagementChart = null;
    let comprehensionChart = null;

    attachLogout('logout-btn');
    initProfilePopup();

    // ── Messaging ─────────────────────────────────────────────────────────────
    const messageModal = document.getElementById('message-modal');
    let messageRecipient = null;

    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );
    messageModal.addEventListener('click', (e) => { if (e.target === messageModal) closeModal(messageModal); });

    function openMessage(studentName, studentId, courseLabel, courseId) {
        messageRecipient = { student_id: studentId, course_id: courseId };
        document.getElementById('message-to').textContent = `Message ${studentName}`;
        document.getElementById('message-course').textContent = courseLabel || '';
        document.getElementById('message-content').value = '';
        messageModal.hidden = false;
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

    function animateCount(el, target) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const dur = reduce ? 0 : 650;
        const start = performance.now();
        const from = 0;
        function step(now) {
            const t = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = String(Math.round(from + (target - from) * eased));
            if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function setPulse(atRisk, moderate, engaged, caption) {
        const total = atRisk + moderate + engaged;
        if (total === 0) {
            pulseScoreEl.textContent = '--';
            pulseSegRisk.style.width = '0%';
            pulseSegMod.style.width = '0%';
            pulseSegEngaged.style.width = '0%';
            pulseAtRiskEl.textContent = '0';
            legendRisk.textContent = '0';
            legendMod.textContent = '0';
            legendEngaged.textContent = '0';
            pulseCaption.textContent = caption || 'No engagement data yet.';
            return;
        }
        const score = Math.round(((moderate + engaged) / total) * 100);
        animateCount(pulseScoreEl, score);
        pulseSegRisk.style.width = `${(atRisk / total) * 100}%`;
        pulseSegMod.style.width = `${(moderate / total) * 100}%`;
        pulseSegEngaged.style.width = `${(engaged / total) * 100}%`;
        pulseAtRiskEl.textContent = String(atRisk);
        legendRisk.textContent = String(atRisk);
        legendMod.textContent = String(moderate);
        legendEngaged.textContent = String(engaged);
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
        return `
            <div class="attention-row" data-sev="${sev}">
                <span class="attention-ring" aria-hidden="true"></span>
                <div class="attention-main">
                    <div class="attention-name">${escapeHTML(displayName)}</div>
                    <div class="attention-meta">
                        <span class="meta-readout">${flagAgeLabel(row.created_at)}</span>
                        ${quizReadout(row.latest_quiz_score)}
                        <span class="meta-readout">${row.reading_minutes ? `read ${Math.round(row.reading_minutes)} min` : 'no reading logged'}</span>
                        <span class="meta-readout">${idleLabel(row.days_since_last_activity)}</span>
                    </div>
                </div>
                <div class="attention-comp" aria-label="Comprehension: ${escapeHTML(row.comprehension_label || 'Unknown')}">
                    <div class="comp-meter">
                        <span class="comp-seg ${1 <= lit ? 'is-on' : ''}"></span>
                        <span class="comp-seg ${2 <= lit ? 'is-on' : ''}"></span>
                        <span class="comp-seg ${3 <= lit ? 'is-on' : ''}"></span>
                    </div>
                    <span class="comp-label comp-label--${sev}">${escapeHTML(row.comprehension_label || 'Unknown')}</span>
                </div>
                <button class="attention-action btn-msg"
                    data-name="${escapeHTML(displayName)}"
                    data-id="${row.student_id}"
                    data-course="${escapeHTML(courseLabel)}"
                    data-course-id="${row.course_id}">Reach out</button>
            </div>
        `;
    }

    async function loadDashboard() {
        try {
            const courses = await swrGet('lect-my-courses', `${API_BASE}/api/courses/mine`);

            if (!Array.isArray(courses) || courses.length === 0) {
                setPulse(0, 0, 0, 'No courses assigned yet. Upload content or create a quiz to get started.');
                totalCoursesEl.textContent = '0';
                totalStudentsEl.textContent = '0';
                criticalStudentsEl.textContent = '0';
                attentionCount.textContent = '0';
                attentionCountSub.textContent = 'no courses yet';
                cohortStrip.hidden = true;
                queueBody.innerHTML = allClearHTML('No courses assigned yet. Upload content or create a quiz to get started.');
                return;
            }

            totalCoursesEl.textContent = String(courses.length);

            const summaries = await Promise.all(
                courses.map(c => swrGet(`lect-summary:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/summary`)
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
                    swrGet(`lect-at-risk:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/at-risk`)
                        .then(data => ({ course: c, students: data && data.students || [] }))
                        .catch(() => ({ course: c, students: [] }))
                )
            );

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
                        ${g.students.map(row => renderAttentionRow(row, g.label)).join('')}
                    </div>
                `).join('');

                queueBody.querySelectorAll('.attention-action').forEach(btn => {
                    btn.addEventListener('click', () => openMessage(btn.dataset.name, btn.dataset.id, btn.dataset.course, btn.dataset.courseId || null));
                });
            }
        } catch (err) {
            console.error('Lecturer dashboard error:', err);
            setPulse(0, 0, 0, "Couldn't reach the server. Refresh to try again.");
            totalStudentsEl.textContent = '--';
            totalCoursesEl.textContent = '--';
            criticalStudentsEl.textContent = '--';
            attentionCount.textContent = '--';
            attentionCountSub.textContent = '';
            cohortStrip.hidden = true;
            queueBody.innerHTML = '<div class="queue-error"><p class="text-muted" style="color:var(--clr-danger)">Unable to load dashboard data.</p></div>';
            showToast('Unable to load dashboard data.', 'error');
        }
    }

    loadDashboard();
});
