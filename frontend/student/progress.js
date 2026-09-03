/* 
   STUDENT PROGRESS PAGE LOGIC
   frontend/student/progress.js
   Renders the grade-projection gauge (output) driven by a study-time lever
   (input), the per-course ledger and the attendance self-log.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.querySelector('.avatar').textContent = user.full_name.charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    function escapeHTML(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    const ARC_LENGTH = 283; // π·r for r=90
    const state = { courses: [], overall: {}, selected: 'overall', materialsCache: {} };

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
            const assignAvg = c.assignments_grade_avg != null ? ` · avg ${c.assignments_grade_avg}%` : '';
            const attText = c.attendance_sessions != null
                ? (c.attendance_total != null
                    ? `Attended ${c.attendance_sessions} of ${c.attendance_total} sessions`
                    : `Attended ${c.attendance_sessions} ${c.attendance_sessions === 1 ? 'session' : 'sessions'}`)
                : 'Attendance n/a';
            const warningHtml = c.warning == null
                ? 'You are meeting your weekly study target. Keep it up.'
                : c.warning;
            return `
            <div class="ledger-row ${state.selected === c.course_id ? 'active' : ''}" data-id="${c.course_id}" style="animation-delay: ${i * 60}ms" role="button" tabindex="0" aria-label="Focus gauge on ${c.course_title}">
                <span class="ledger-grade">${c.predicted_grade || '–'}</span>
                <div class="ledger-head">
                    <h3>${escapeHTML(c.course_title)}</h3>
                    <span class="ledger-code">${escapeHTML(c.course_code || '')} · ${c.weeks_covered > 0 ? `${c.weeks_covered} week${c.weeks_covered === 1 ? '' : 's'} of materials` : (c.materials_count > 0 ? 'Full-semester materials' : 'No materials yet')}</span>
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
                        <span>Assignments ${c.assignments_submitted}/${c.assignments_total}${c.assignments_total ? ` (${onTime} on time)` : ''}${assignAvg}</span>
                        <span>${escapeHTML(attText)}</span>
                    </div>
                    <div class="ledger-warning ${warnClass}">
                        <i class="bi ${warnIcon}"></i>
                        <span>${escapeHTML(warningHtml)}</span>
                    </div>
                </div>
                <span class="ledger-chevron"><i class="bi bi-chevron-down"></i> Course materials</span>
                <div class="ledger-materials" id="materials-${c.course_id}" hidden></div>
            </div>`;
        }).join('');

        const focus = cid => {
            state.selected = cid;
            renderDialPills();
            renderDial();
        };
        ledger.querySelectorAll('.ledger-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.ledger-material-row')) return; // handled separately
                focus(row.dataset.id);
                toggleCourseMaterials(row.dataset.id, row);
            });
            row.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    focus(row.dataset.id);
                    toggleCourseMaterials(row.dataset.id, row);
                }
            });
        });
    }

    // -- Course-material dropdown + per-material popup -----------------------
    function collapseCourseMaterials() {
        document.querySelectorAll('.ledger-row.open').forEach(row => {
            row.classList.remove('open');
            const box = row.querySelector('.ledger-materials');
            if (box) box.hidden = true;
        });
    }

    async function toggleCourseMaterials(courseId, row) {
        const box = document.getElementById(`materials-${courseId}`);
        if (!box) return;

        if (!row.classList.contains('open')) {
            // Collapse any other open dropdown, then open this one.
            collapseCourseMaterials();
            row.classList.add('open');
            box.hidden = false;
            if (!state.materialsCache[courseId]) {
                box.innerHTML = '<div class="ledger-materials-loading"><span class="spinner"></span> Loading materials...</div>';
                try {
                    const res = await authFetch(`${API_BASE}/api/materials/course/${encodeURIComponent(courseId)}`);
                    if (!res.ok) throw new Error('failed');
                    const data = await res.json();
                    const materials = data.materials || [];
                    state.materialsCache[courseId] = materials;
                    renderMaterialsDropdown(box, courseId, materials);
                } catch (err) {
                    console.error('Failed to load course materials:', err);
                    box.innerHTML = '<p class="ledger-materials-empty">Could not load materials for this course.</p>';
                }
            } else {
                renderMaterialsDropdown(box, courseId, state.materialsCache[courseId]);
            }
        } else {
            row.classList.remove('open');
            box.hidden = true;
        }
    }

    function renderMaterialsDropdown(box, courseId, materials) {
        if (!materials || !materials.length) {
            box.innerHTML = '<p class="ledger-materials-empty">No course materials published yet.</p>';
            return;
        }
        const course = state.courses.find(c => c.course_id === courseId);
        const courseCode = course ? course.course_code : '';
        box.innerHTML = `
            <span class="ledger-materials-head">${escapeHTML(courseCode || 'Course')} materials (${materials.length})</span>
            ${materials.map(m => {
                const tag = m.unit_label
                    ? `Unit ${escapeHTML(m.unit_label)}`
                    : (m.week_number != null ? `Week ${m.week_number}` : (m.semester ? `Sem ${escapeHTML(m.semester)}` : ''));
                return `
                <button type="button" class="ledger-material-row" data-material-id="${m.id}" data-material-title="${escapeHTML(m.title)}">
                    <span class="ledger-material-tags">
                        <span class="ledger-material-title">${escapeHTML(m.title)}</span>
                        ${tag ? `<span class="ledger-material-tag">${tag}</span>` : ''}
                    </span>
                    <i class="bi bi-graph-up-arrow" aria-hidden="true"></i>
                </button>`;
            }).join('')}
        `;
        box.querySelectorAll('.ledger-material-row').forEach(btn => {
            btn.addEventListener('click', () => {
                openMaterialModal(courseCode || courseId, courseId, btn.dataset.materialId, btn.dataset.materialTitle);
            });
        });
    }

    // Grade-based tone for the per-material quiz/assignment values.
    function gradeTone(value) {
        if (value == null) return '';
        if (value >= 75) return 'is-high';
        if (value >= 50) return 'is-mid';
        return 'is-low';
    }

    // Small in-memory caches for the student's quiz results and a course's
    // assignments so the popup doesn't re-fetch on every material click.
    const quizCache = { loaded: false, data: null };
    const assignmentCache = {};

    async function openMaterialModal(courseLabel, courseId, materialId, materialTitle) {
        const modal = document.getElementById('material-modal');
        const titleEl = document.getElementById('material-modal-title');
        const subEl = document.getElementById('material-modal-sub');
        const quizEl = document.getElementById('pm-quiz');
        const assignEl = document.getElementById('pm-assignment');
        const noteEl = document.getElementById('pm-note');
        if (!modal || !quizEl || !assignEl) return;

        titleEl.textContent = materialTitle || 'Course material';
        subEl.textContent = `${courseLabel || 'Course'} · quiz & assignment`;
        quizEl.textContent = '—';
        assignEl.textContent = '—';
        quizEl.className = 'progress-modal-value';
        assignEl.className = 'progress-modal-value';
        noteEl.textContent = 'Loading your quiz and assignment results for this material...';
        modal.hidden = false;

        try {
            const quizR = await loadStudentQuizzes();
            const assignR = await loadCourseAssignments(courseId);

            const quizResults = (quizR.results || []).filter(r => r.material_id === materialId);
            const assignRows = (assignR.assignments || []).filter(a => a.source_material_id === materialId);

            // Quiz cell: average score + attempt count
            if (quizResults.length) {
                const scores = quizResults.map(r => r.score).filter(s => s != null);
                const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
                quizEl.textContent = avg != null
                    ? `${avg}% · ${quizResults.length} quiz${quizResults.length === 1 ? '' : 'zes'}`
                    : `${quizResults.length} quiz${quizResults.length === 1 ? '' : 'zes'}`;
                quizEl.classList.add(gradeTone(avg));
            } else {
                quizEl.textContent = 'n/a';
                quizEl.classList.add('is-mid');
            }

            // Assignment cell: submitted/total + average score
            if (assignRows.length) {
                const submitted = assignRows.filter(a => a.submitted).length;
                const scored = assignRows.map(a => a.score).filter(s => s != null);
                const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
                assignEl.textContent = avg != null
                    ? `${submitted}/${assignRows.length} · ${avg}%`
                    : `${submitted}/${assignRows.length}`;
                assignEl.classList.add(gradeTone(avg));
            } else {
                assignEl.textContent = 'n/a';
                assignEl.classList.add('is-mid');
            }

            if (!quizResults.length && !assignRows.length) {
                noteEl.textContent = "No quizzes or assignments recorded for this material yet. Take the comprehension check or download the material to start.";
            } else if (!quizResults.length) {
                noteEl.textContent = `${assignRows.length} assignment${assignRows.length === 1 ? '' : 's'} for this material. No quiz taken on it yet.`;
            } else if (!assignRows.length) {
                noteEl.textContent = `${quizResults.length} quiz attempt${quizResults.length === 1 ? '' : 's'} on this material. No assignment linked to it.`;
            } else {
                noteEl.textContent = `Your quiz and assignment performance for this material.`;
            }
        } catch (err) {
            console.error('Failed to load material quiz/assignment progress:', err);
            quizEl.textContent = '—';
            assignEl.textContent = '—';
            noteEl.textContent = 'Could not load this material\'s results. Please try again.';
        }
    }

    async function loadStudentQuizzes() {
        if (quizCache.loaded) return quizCache.data;
        const res = await authFetch(`${API_BASE}/api/quiz/student/${encodeURIComponent(user.id)}`);
        if (!res.ok) throw new Error('failed');
        quizCache.data = await res.json();
        quizCache.loaded = true;
        return quizCache.data;
    }

    async function loadCourseAssignments(courseId) {
        if (assignmentCache[courseId]) return assignmentCache[courseId];
        const res = await authFetch(`${API_BASE}/api/assignments/course/${encodeURIComponent(courseId)}`);
        if (!res.ok) throw new Error('failed');
        assignmentCache[courseId] = await res.json();
        return assignmentCache[courseId];
    }

    // -- Hero readings + warnings -------------------------------------------
    function renderHero() {
        const o = state.overall;
        document.getElementById('quiz-avg').textContent = o.quiz_avg != null ? `${Math.round(o.quiz_avg)}%` : '–';
        const present = o.attendance_sessions;
        const total = o.attendance_total;
        const attRate = document.getElementById('attendance-rate');
        const attNote = document.getElementById('attendance-note');
        if (present == null) {
            attRate.textContent = '–';
            attNote.hidden = true;
        } else if (total != null) {
            attRate.textContent = `${present} / ${total}`;
            attNote.textContent = 'sessions attended';
            attNote.hidden = false;
        } else {
            attRate.textContent = `${present}`;
            attNote.textContent = `${present === 1 ? 'session' : 'sessions'} attended`;
            attNote.hidden = false;
        }
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
        const buildMap = (logs) => {
            const map = {};
            (logs || []).forEach(l => {
                if (String(l.logged_date).slice(0, 10) === today && l.course_id) {
                    map[l.course_id] = l.status;
                }
            });
            return map;
        };

        function renderList(todayLogs) {
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
                        invalidateApiCache('attendance');
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

        // Cached logs paint instantly; the fetch revalidates.
        let painted = false;
        const paint = (logs) => { painted = true; renderList(buildMap(logs)); };
        const cachedLogs = cachedRead('attendance');
        if (cachedLogs) paint(cachedLogs);
        try {
            const res = await authFetch(`${API_BASE}/api/attendance/student/${user.id}`);
            if (res.ok) {
                const logs = await res.json();
                cachedWrite('attendance', logs);
                paint(logs);
            }
        } catch (err) { /* attendance history unavailable */ }
        if (!painted) renderList({});
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

    // -- Material modal close wiring ----------------------------------------
    const materialModal = document.getElementById('material-modal');
    if (materialModal) {
        materialModal.querySelectorAll('[data-close="true"]').forEach(btn => {
            btn.addEventListener('click', () => { materialModal.hidden = true; });
        });
        materialModal.addEventListener('click', e => {
            if (e.target === materialModal) materialModal.hidden = true;
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !materialModal.hidden) materialModal.hidden = true;
        });
    }

    // -- Tab switching (Progress / Analytics) --------------------------------
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.panel !== btn.dataset.tab);
        });
    });

    // -- Load data ------------------------------------------------------------
    async function load() {
        try {
            await swrGet('study-summary', `${API_BASE}/api/study/summary/${user.id}`, data => {
                state.courses = data.courses || [];
                state.overall = data.overall || {};
                renderDialPills();
                renderDial();
                renderHero();
                renderCourseLedger();
            });
        } catch (err) {
            console.error('Error loading progress:', err);
            document.getElementById('course-ledger').innerHTML =
                '<div class="empty-state">Unable to load your progress. Please try again later.</div>';
            showToast('Unable to load your progress.', 'error');
        }
    }

    load();
});
