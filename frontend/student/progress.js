/* 
   STUDENT PROGRESS PAGE LOGIC
   frontend/student/progress.js
   Renders the grade-projection gauge (output) driven by a study-time lever
   (input), the per-course ledger and the attendance self-log.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.getElementById('user-name').textContent = user.full_name;
    document.querySelector('.avatar').textContent = user.full_name.charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    const ARC_LENGTH = 283; // π·r for r=90
    const state = { courses: [], overall: {}, selected: 'overall' };

    const dialGrade = document.getElementById('dialGrade');
    const dialPct = document.getElementById('dialPct');
    const dialArc = document.getElementById('dialArc');
    const dialNeedle = document.getElementById('dialNeedle');
    const dialDelta = document.getElementById('dialDelta');
    const leverWrap = document.getElementById('leverWrap');
    const studyLever = document.getElementById('studyLever');
    const leverVal = document.getElementById('leverVal');
    const leverNote = document.getElementById('leverNote');
    const dialEyebrow = document.getElementById('dialEyebrow');

    // -- Gauge ticks -------------------------------------------------------
    (function renderTicks() {
        const group = document.getElementById('gaugeTicks');
        const NS = 'http://www.w3.org/2000/svg';
        for (let p = 0; p <= 100; p += 10) {
            const ang = (180 - p * 1.8) * Math.PI / 180;
            const x1 = 120 + 100 * Math.cos(ang);
            const y1 = 130 - 100 * Math.sin(ang);
            const x2 = 120 + 110 * Math.cos(ang);
            const y2 = 130 - 110 * Math.sin(ang);
            const tick = document.createElementNS(NS, 'line');
            tick.setAttribute('x1', x1.toFixed(1));
            tick.setAttribute('y1', y1.toFixed(1));
            tick.setAttribute('x2', x2.toFixed(1));
            tick.setAttribute('y2', y2.toFixed(1));
            group.appendChild(tick);
        }
    })();

    function gradeBand(pct) {
        if (pct == null) return '–';
        if (pct >= 80) return 'A';
        if (pct >= 75) return 'B+';
        if (pct >= 70) return 'B';
        if (pct >= 65) return 'C+';
        if (pct >= 60) return 'C';
        if (pct >= 55) return 'D+';
        if (pct >= 50) return 'D';
        return 'F';
    }

    function setDial(pct, grade, pctLabel) {
        const p = Math.max(0, Math.min(100, pct == null ? 0 : pct));
        const dash = (p / 100) * ARC_LENGTH;
        dialArc.setAttribute('stroke-dashoffset', String(ARC_LENGTH - dash));
        const ang = (180 - p * 1.8) * Math.PI / 180;
        dialNeedle.setAttribute('cx', (120 + 90 * Math.cos(ang)).toFixed(1));
        dialNeedle.setAttribute('cy', (130 - 90 * Math.sin(ang)).toFixed(1));
        dialGrade.textContent = grade || '–';
        dialPct.textContent = pctLabel != null ? pctLabel : (pct == null ? 'Insufficient data' : `${Math.round(pct)}%`);
    }

    function setDelta(course) {
        if (course && course.what_if && course.what_if.projected_percentage != null && course.predicted_percentage != null) {
            const diff = course.what_if.projected_percentage - course.predicted_percentage;
            if (diff > 0) {
                dialDelta.hidden = false;
                dialDelta.textContent = `+${Math.round(diff)}% if you hit your weekly target`;
                return;
            }
        }
        dialDelta.hidden = true;
    }

    function projectPercent(basePct, projectedPct, coverage, newCoverage) {
        if (coverage == null || projectedPct == null) return basePct;
        if (projectedPct <= basePct) return basePct;
        const span = projectedPct - basePct;
        const t = (newCoverage - coverage) / (100 - coverage);
        return Math.round(basePct + span * Math.max(0, Math.min(1, t)));
    }

    function renderLever(course) {
        const cov = course.study_coverage;
        if (course.predicted_percentage == null || !course.what_if || cov == null || cov >= 100) {
            leverWrap.hidden = true;
            return;
        }
        leverWrap.hidden = false;
        studyLever.max = 100;
        studyLever.value = cov;
        leverVal.textContent = `${course.time_spent_minutes} of ${course.recommended_minutes} min`;
        leverNote.textContent = 'Drag the lever to see how raising your weekly study time changes your projected grade.';
    }

    function renderDial() {
        const sel = state.selected;
        if (sel === 'overall') {
            dialEyebrow.textContent = 'Semester projection';
            const o = state.overall;
            setDial(o.predicted_percentage, o.predicted_grade, o.predicted_percentage == null ? null : `${Math.round(o.predicted_percentage)}%`);
            leverWrap.hidden = true;
            setDelta(null);
        } else {
            const course = state.courses.find(c => c.course_id === sel);
            if (!course) return;
            dialEyebrow.textContent = `${course.course_code || 'Course'} · ${course.course_title}`;
            setDial(course.predicted_percentage, course.predicted_grade, course.predicted_percentage == null ? null : `${Math.round(course.predicted_percentage)}%`);
            renderLever(course);
            setDelta(course);
        }
        document.querySelectorAll('.ledger-row').forEach(row => {
            row.classList.toggle('active', row.dataset.id === sel);
        });
    }

    function renderDialPills() {
        const wrap = document.getElementById('dialCourses');
        const pills = [{
            id: 'overall',
            label: 'All courses',
        }, ...state.courses.map(c => ({
            id: c.course_id,
            label: c.course_code || c.course_title,
        }))];
        wrap.innerHTML = pills.map(p => `
            <button class="dial-pill ${state.selected === p.id ? 'active' : ''}" data-id="${p.id}">${p.label}</button>
        `).join('');
        wrap.querySelectorAll('.dial-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                state.selected = btn.dataset.id;
                renderDialPills();
                renderDial();
            });
        });
    }

    studyLever.addEventListener('input', () => {
        const course = state.courses.find(c => c.course_id === state.selected);
        if (!course || !course.what_if) return;
        const cov = course.study_coverage;
        const newCov = Number(studyLever.value);
        const pct = projectPercent(course.predicted_percentage, course.what_if.projected_percentage, cov, newCov);
        leverVal.textContent = `${course.time_spent_minutes} → ${Math.round(course.recommended_minutes * newCov / 100)} min`;
        setDial(pct, gradeBand(pct), `${pct}%`);
        if (newCov >= 100) {
            leverNote.textContent = `At this pace you could reach ${course.what_if.projected_grade}. ${course.what_if.note}`;
        }
    });

    // -- Course ledger ------------------------------------------------------
    function renderCourseLedger() {
        const ledger = document.getElementById('course-ledger');
        if (!state.courses.length) {
            ledger.innerHTML = '<div class="empty-state">You are not enrolled in any courses yet. <a href="../courses/courses.html">Browse courses</a></div>';
            return;
        }
        ledger.innerHTML = state.courses.map((c, i) => {
            const cov = c.study_coverage != null ? Math.round(c.study_coverage) : 0;
            const fillClass = c.warning == null ? 'on-target' : (cov < 50 ? 'low' : '');
            const warnClass = c.warning == null ? 'ok' : 'warn';
            const warnIcon = c.warning == null ? 'bi-check-circle' : 'bi-exclamation-triangle';
            const onTime = c.assignments_on_time || 0;
            const warningHtml = c.warning == null
                ? 'You are meeting your weekly study target. Keep it up.'
                : c.warning;
            return `
            <div class="ledger-row ${state.selected === c.course_id ? 'active' : ''}" data-id="${c.course_id}" style="animation-delay: ${i * 60}ms" role="button" tabindex="0" aria-label="Focus gauge on ${c.course_title}">
                <span class="ledger-grade">${c.predicted_grade || '–'}</span>
                <div class="ledger-head">
                    <h3>${c.course_title}</h3>
                    <span class="ledger-code">${c.course_code || ''} · ${c.weeks_covered > 0 ? `${c.weeks_covered} week${c.weeks_covered === 1 ? '' : 's'} of materials` : (c.materials_count > 0 ? 'Full-semester materials' : 'No materials yet')}</span>
                </div>
                <div class="ledger-body">
                    <div class="ledger-bar-label">
                        <span>Weekly study time</span>
                        <span><b>${c.time_spent_minutes} min</b> of ${c.recommended_minutes} min target</span>
                    </div>
                    <div class="ledger-track"><div class="ledger-fill ${fillClass}" style="width:${cov}%"></div></div>
                    <div class="ledger-meta">
                        <span>${c.materials_count} materials</span>
                        <span>Quiz ${c.quiz_avg != null ? c.quiz_avg + '%' : 'n/a'}</span>
                        <span>Assignments ${c.assignments_submitted}/${c.assignments_total}${c.assignments_total ? ` (${onTime} on time)` : ''}</span>
                        <span>Attendance ${c.attendance_present_rate != null ? c.attendance_present_rate + '%' : 'n/a'}</span>
                    </div>
                    <div class="ledger-warning ${warnClass}">
                        <i class="bi ${warnIcon}"></i>
                        <span>${warningHtml}</span>
                    </div>
                </div>
            </div>`;
        }).join('');

        const focus = cid => {
            state.selected = cid;
            renderDialPills();
            renderDial();
        };
        ledger.querySelectorAll('.ledger-row').forEach(row => {
            row.addEventListener('click', () => focus(row.dataset.id));
            row.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    focus(row.dataset.id);
                }
            });
        });
    }

    // -- Hero readings + warnings -------------------------------------------
    function renderHero() {
        const o = state.overall;
        document.getElementById('quiz-avg').textContent = o.quiz_avg != null ? `${Math.round(o.quiz_avg)}%` : '–';
        document.getElementById('attendance-rate').textContent = o.attendance_present_rate != null ? `${Math.round(o.attendance_present_rate)}%` : '–';
        document.getElementById('warning-count').textContent = o.active_warnings || 0;

        const strip = document.getElementById('warning-strip');
        if (o.active_warnings) {
            strip.hidden = false;
            strip.innerHTML = `
                <i class="bi bi-exclamation-triangle-fill"></i>
                <span>${o.active_warnings} of your courses need more study time this week. Choose a course and try the study-time lever to see how it could change your projected grade.</span>`;
        } else {
            strip.hidden = true;
        }
    }

    // -- Attendance self-log --------------------------------------------------
    async function loadAttendance() {
        const list = document.getElementById('attendance-log');
        if (!state.courses.length) {
            list.innerHTML = '<div class="empty-state">No courses to mark yet.</div>';
            return;
        }
        const today = new Date().toISOString().slice(0, 10);
        let todayLogs = {};
        try {
            const res = await authFetch(`${API_BASE}/api/attendance/student/${user.id}`);
            if (res.ok) {
                const logs = await res.json();
                logs.forEach(l => {
                    if (String(l.logged_date).slice(0, 10) === today && l.course_id) {
                        todayLogs[l.course_id] = l.status;
                    }
                });
            }
        } catch (err) { /* attendance history unavailable */ }

        list.innerHTML = state.courses.map((c, i) => {
            const logged = todayLogs[c.course_id];
            const actions = ['present', 'late', 'absent'].map(s => {
                const label = s.charAt(0).toUpperCase() + s.slice(1);
                return `<button class="attend-btn ${logged === s ? 'selected' : ''}" data-status="${s}" data-course="${c.course_id}" ${logged ? 'disabled' : ''}>${label}</button>`;
            }).join('');
            return `
            <div class="attend-card" style="animation-delay: ${i * 50}ms">
                <h4>${c.course_title}</h4>
                <p class="text-muted">${c.course_code || ''}</p>
                ${logged
                    ? `<div class="attend-logged"><i class="bi bi-check-circle-fill"></i> Marked ${logged} today</div>`
                    : `<div class="attend-actions">${actions}</div>`}
            </div>`;
        }).join('');

        list.querySelectorAll('.attend-btn:not(:disabled)').forEach(btn => {
            btn.addEventListener('click', async () => {
                const status = btn.dataset.status;
                const courseId = btn.dataset.course;
                try {
                    const res = await authFetch(`${API_BASE}/api/attendance/log`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ course_id: courseId, status }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                        showToast(data.message || `Marked ${status}.`, 'success');
                        loadAttendance();
                    } else {
                        showToast(data.detail || 'Could not mark attendance today.', 'error');
                    }
                } catch (err) {
                    showToast('Could not mark attendance today.', 'error');
                }
            });
        });
    }

    // -- Attendance toggle (lazy-load on first open) -------------------------
    const attendToggle = document.getElementById('attend-toggle');
    const attendList = document.getElementById('attendance-log');
    let attendanceLoaded = false;
    attendToggle.addEventListener('click', () => {
        const opening = attendList.hidden;
        attendList.hidden = !opening;
        attendToggle.setAttribute('aria-expanded', String(opening));
        const icon = attendToggle.querySelector('i');
        icon.className = opening ? 'bi bi-dash-lg' : 'bi bi-plus-lg';
        attendToggle.querySelector('span').textContent = opening ? 'Hide attendance' : 'Mark today\'s attendance';
        if (opening && !attendanceLoaded) {
            attendanceLoaded = true;
            loadAttendance();
        }
    });

    // -- Load data ------------------------------------------------------------
    async function load() {
        try {
            const res = await authFetch(`${API_BASE}/api/study/summary/${user.id}`);
            if (!res.ok) throw new Error(`Study summary failed (${res.status})`);
            const data = await res.json();
            state.courses = data.courses || [];
            state.overall = data.overall || {};
            renderDialPills();
            renderDial();
            renderHero();
            renderCourseLedger();
        } catch (err) {
            console.error('Error loading progress:', err);
            document.getElementById('course-ledger').innerHTML =
                '<div class="empty-state">Unable to load your progress. Please try again later.</div>';
            showToast('Unable to load your progress.', 'error');
        }
    }

    load();
});
