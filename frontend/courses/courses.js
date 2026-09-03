/* 
   COURSES MODULE LOGIC
   frontend/courses/courses.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.getElementById('user-avatar').textContent = (user.full_name || 'U').charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    let enrolledCourseIds = new Set();
    let progressById = new Map(); // courseId -> progress (from students endpoint)
    let allCourses = [];
    let currentTab = 'enrolled';
    const LEVELS = [100, 200, 300, 400];
    const SEMESTERS = ['First', 'Second'];
    const browse = { level: null, semester: null };

    // Per-course accent derived from the course code so every card gets a
    // distinct, stable visual identity without a hardcoded palette. We
    // rotate a base hue around the emerald brand with the code as a seed.
    function accentFor(code, progress) {
        let seed = 0;
        const key = String(code || 'UENR');
        for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
        // Stage completed courses into a calm green; everything else rotates.
        if (progress >= 100) { return { grad: 'linear-gradient(135deg,#22c55e,#16a34a)', glow: 'rgba(34,197,94,0.4)', ink: 'var(--clr-success)' }; }
        const hue = (150 + (seed % 90)) ; // 150..239 — around green→blue
        return {
            grad: `linear-gradient(135deg,hsl(${hue},70%,52%),hsl(${hue},72%,40%))`,
            glow: `hsla(${hue},70%,52%,0.45)`,
            ink: `hsl(${hue},70%,58%)`,
        };
    }

    function monogramFor(title) {
        const words = String(title || '?').trim().split(/\s+/);
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    }

    async function loadEnrolledCourses() {
        try {
            await swrGet('my-courses', `${API_BASE}/api/students/${user.id}/courses`, courses => {
                enrolledCourseIds = new Set(courses.map(c => c.id));
                progressById = new Map(courses.map(c => [c.id, c.progress]));
                filterAndRender();
            });
        } catch (err) {
            console.error('Error loading enrolled courses:', err);
        }
    }

    async function loadAllCourses() {
        try {
            // Full catalogue across all departments (includes level/semester).
            await swrGet('catalog', `${API_BASE}/api/courses/catalog`, courses => {
                allCourses = courses;
                filterAndRender();
            });
        } catch (err) {
            console.error('Error loading courses:', err);
            allCourses = [];
            filterAndRender();
        }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]
        ));
    }

    const findCourse = (courseId) => allCourses.find(c => c.id === courseId);

    function updateTabCounts() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            const count = btn.dataset.tab === 'enrolled'
                ? allCourses.filter(c => enrolledCourseIds.has(c.id)).length
                : allCourses.length;
            const pill = btn.querySelector('.tab-count');
            if (pill) pill.textContent = count;
        });
    }

    function emptyStateHtml(courses) {
        const query = document.getElementById('course-search').value.trim();
        if (query) {
            return `
                <div class="empty-state">
                    <i class="bi bi-search" aria-hidden="true"></i>
                    <h3>No matches</h3>
                    <p>Nothing matches "${escapeHtml(query)}". Try a course code, title, or lecturer name.</p>
                </div>`;
        }
        if (currentTab === 'enrolled') {
            return `
                <div class="empty-state">
                    <i class="bi bi-mortarboard" aria-hidden="true"></i>
                    <h3>No enrollments yet</h3>
                    <p>Open the All Courses tab and enroll to see your courses here.</p>
                </div>`;
        }
        if (currentTab === 'all' && (browse.level != null || browse.semester != null)) {
            const scope = semLabel(browse.semester)
                ? `${levelLabel(browse.level)} · ${semLabel(browse.semester)}`
                : levelLabel(browse.level);
            return `
                <div class="empty-state">
                    <i class="bi bi-collection" aria-hidden="true"></i>
                    <h3>No courses here</h3>
                    <p>There are no courses in <strong>${escapeHtml(scope)}</strong>. Try a different level or semester.</p>
                </div>`;
        }
        return `
            <div class="empty-state">
                <i class="bi bi-collection" aria-hidden="true"></i>
                <h3>No courses available</h3>
                <p>No courses have been published yet. Check back later.</p>
            </div>`;
    }

    function renderCourses(courses) {
        const grid = document.getElementById('courses-grid');
        updateTabCounts();

        const showAllBtn = grid.querySelector('.show-all-btn');

        if (!courses.length) {
            grid.innerHTML = emptyStateHtml(courses);
            return;
        }

        grid.classList.remove('clamped');
        grid.innerHTML = courses.map(course => {
            const isEnrolled = enrolledCourseIds.has(course.id);
            const progress = Math.min(100, Math.max(0, course.progress || 0));
            const accent = accentFor(course.code, progress);
            const mono = monogramFor(course.title);

            const badge = (course.level != null || course.semester)
                ? `<span class="course-levelbadge"><i class="bi bi-mortarboard" aria-hidden="true"></i>${course.level != null ? `Level ${course.level}` : ''}${course.level != null && course.semester ? ' · ' : ''}${escapeHtml(course.semester || '')}</span>`
                : '';

            // Status is read from progress so the card never lies about state.
            let statusHtml;
            if (isEnrolled) {
                const cls = progress >= 100 ? 'course-status--completed' : progress > 0 ? 'course-status--inprogress' : 'course-status--notstarted';
                const icon = progress >= 100 ? 'bi-check-circle-fill' : progress > 0 ? 'bi-arrow-repeat' : 'bi-hourglass-split';
                const label = progress >= 100 ? 'Completed' : progress > 0 ? 'In progress' : 'Not started';
                statusHtml = `<span class="course-status ${cls}"><i class="bi ${icon}" aria-hidden="true"></i>${label}</span>`;
            } else {
                statusHtml = `<span class="course-status course-status--notenrolled"><i class="bi bi-bookmark-plus" aria-hidden="true"></i>Not enrolled</span>`;
            }

            // Enrolled cards show only the Unenroll action (no Continue link,
            // no progress track); non-enrolled cards get the Enroll button.
            let actionsHtml;
            if (isEnrolled) {
                actionsHtml = `<button class="btn-unenroll" onclick="window.unenroll('${escapeHtml(course.id)}')">Unenroll</button>`;
            } else {
                actionsHtml = `<button class="btn-enroll" onclick="window.enroll('${escapeHtml(course.id)}', this)"><span class="btn-label">Enroll Now</span><span class="btn-spinner" hidden></span></button>`;
            }

            return `
                <div class="course-card" style="--card-accent:${accent.grad};--card-accent-glow:${accent.glow};--card-accent-ink:${accent.ink};">
                    <div class="course-card-head">
                        <div class="course-monogram" style="background:${accent.grad};box-shadow:0 6px 18px -6px ${accent.glow};">${escapeHtml(mono)}</div>
                        <span class="course-code">${escapeHtml(course.code || 'UENR')}</span>
                    </div>
                    ${statusHtml}
                    <h3 class="course-title">${escapeHtml(course.title)}</h3>
                    <p class="course-lecturer"><i class="bi bi-person" aria-hidden="true"></i>${escapeHtml(course.lecturer_name || 'Unknown Lecturer')}</p>
                    ${badge}
                    <div class="card-actions">${actionsHtml}</div>
                </div>
            `;
        }).join('');

        // Clamp long lists so the page doesn't become an overwhelming wall —
        // reveal the rest only on demand. Enrolled tab defaults to showing all.
        if (currentTab === 'all' && courses.length > 8) {
            grid.classList.add('clamped');
            const btn = showAllBtn || document.createElement('button');
            btn.type = 'button';
            btn.className = 'show-all-btn';
            btn.textContent = `Show all ${courses.length} courses`;
            btn.setAttribute('aria-expanded', 'false');
            btn.onclick = () => {
                const expanded = grid.classList.toggle('clamped');
                btn.textContent = expanded ? `Show all ${courses.length} courses` : 'Show fewer';
                btn.setAttribute('aria-expanded', String(!expanded));
            };
            grid.appendChild(btn);
        } else if (showAllBtn) {
            showAllBtn.remove();
        }
    }

    // ── Level -> semester drill-down navigation ──────────────────────────────
    const browseNav = document.getElementById('browse-nav');
    const browseTrail = document.getElementById('browse-trail');
    const browseChoices = document.getElementById('browse-choices');
    const browseBack = document.getElementById('browse-back');

    const levelOf = (c) => (c.level != null ? Number(c.level) : null);
    const semesterOf = (c) => (c.semester ? String(c.semester) : null);
    const inLevel = (c, level) => {
        if (level == null) return true;
        if (level === 'unassigned') return levelOf(c) == null;
        return levelOf(c) === level;
    };
    const inSemester = (c, sem) => {
        if (sem == null) return true;
        if (sem === 'unassigned') return semesterOf(c) == null;
        return semesterOf(c) === sem;
    };
    const levelLabel = (level) => (level == null ? 'All Courses' : level === 'unassigned' ? 'Unassigned' : `Level ${level}`);
    const semLabel = (sem) => (sem == null ? '' : sem === 'unassigned' ? 'Unassigned' : `${sem} Semester`);

    function resetBrowse() { browse.level = null; browse.semester = null; }

    function countFor(pred) {
        return allCourses.filter(c => pred(c) && (!queryValue() || matchesQuery(c))).length;
    }
    function queryValue() { return document.getElementById('course-search').value.toLowerCase(); }
    function matchesQuery(c) {
        const q = queryValue();
        if (!q) return true;
        return (c.title || '').toLowerCase().includes(q)
            || (c.lecturer_name || '').toLowerCase().includes(q)
            || (c.code || '').toLowerCase().includes(q);
    }

    function renderBrowseNav() {
        if (currentTab !== 'all') {
            browseNav.hidden = true;
            return;
        }
        browseNav.hidden = false;

        const trail = [];
        if (browse.level != null) trail.push(['All Courses', () => { browse.level = null; browse.semester = null; filterAndRender(); }]);
        if (browse.semester != null) {
            trail.push([levelLabel(browse.level), () => { browse.semester = null; filterAndRender(); }]);
            trail.push([semLabel(browse.semester), () => {}]);
        } else if (browse.level != null) {
            trail.push([levelLabel(browse.level), () => {}]);
        }
        browseTrail.innerHTML = trail.map(([label, _fn], i) => `
            <span class="browse-step ${i === trail.length - 1 ? 'is-current' : ''}" ${i < trail.length - 1 ? 'data-step role="button" tabindex="0"' : ''}>${escapeHtml(label)}</span>
            ${i < trail.length - 1 ? '<span class="browse-sep">/</span>' : ''}
        `).join('');
        browseTrail.querySelectorAll('[data-step]').forEach(step => {
            const idx = [...browseTrail.querySelectorAll('[data-step]')].indexOf(step);
            step.addEventListener('click', () => { trail[idx][1](); });
        });

        browseBack.hidden = browse.level == null && browse.semester == null;
        browseBack.onclick = () => {
            if (browse.semester != null) browse.semester = null;
            else if (browse.level != null) browse.level = null;
            filterAndRender();
        };

        let html = '';
        if (browse.level == null) {
            // Level picker.
            const items = LEVELS.map(lv => {
                const n = countFor(c => inLevel(c, lv));
                return choiceHtml(`${lv}`, `Level ${lv}`, `${n} course${n === 1 ? '' : 's'}`, () => { browse.level = lv; filterAndRender(); });
            });
            const unassigned = countFor(c => levelOf(c) == null);
            if (unassigned > 0) {
                items.push(choiceHtml('unassigned', 'Unassigned', `${unassigned} course${unassigned === 1 ? '' : 's'}`, () => { browse.level = 'unassigned'; filterAndRender(); }));
            }
            html = items.join('');
        } else {
            // Semester picker within the selected level.
            const inLevelPred = (c) => inLevel(c, browse.level);
            const semItems = SEMESTERS.map(sem => {
                const n = countFor(c => inLevelPred(c) && inSemester(c, sem));
                return choiceHtml(sem.toLowerCase(), `${sem} Semester`, `${n} course${n === 1 ? '' : 's'}`, () => { browse.semester = sem; filterAndRender(); }, browse.semester === sem.toLowerCase());
            });
            const unassignedSem = countFor(c => inLevelPred(c) && semesterOf(c) == null);
            if (unassignedSem > 0) {
                semItems.push(choiceHtml('unassigned-sem', 'Unassigned', `${unassignedSem} course${unassignedSem === 1 ? '' : 's'}`, () => { browse.semester = 'unassigned'; filterAndRender(); }, browse.semester === 'unassigned'));
            }
            html = semItems.join('');
        }
        browseChoices.innerHTML = html;
        browseChoices.querySelectorAll('[data-choice]').forEach(el => {
            el.addEventListener('click', () => {
                const fnKey = el.dataset.fn;
                choiceFns[fnKey] && choiceFns[fnKey]();
            });
        });
    }

    const choiceFns = {};
    let choiceCounter = 0;
    function choiceHtml(key, title, sub, fn, selected = false) {
        const fnKey = `fn${++choiceCounter}`;
        choiceFns[fnKey] = fn;
        return `
            <button type="button" class="browse-choice ${selected ? 'is-selected' : ''}" data-choice data-fn="${fnKey}">
                <span class="browse-choice-title">${escapeHtml(title)}</span>
                <span class="browse-choice-sub">${escapeHtml(sub)}</span>
            </button>`;
    }

    function filterAndRender() {
        let filtered = allCourses;

        if (currentTab === 'enrolled') {
            // The catalogue has no progress data, so merge in the real progress
            // from the students/{id}/courses endpoint so the status pill matches
            // the dashboard's "Continue learning" card.
            filtered = allCourses
                .filter(c => enrolledCourseIds.has(c.id))
                .map(c => ({ ...c, progress: progressById.has(c.id) ? progressById.get(c.id) : c.progress }));
            renderBrowseNav(); // hides nav
            renderCourses(filtered);
            return;
        }

        // All Courses tab — apply drill-down browse filter.
        if (browse.level != null) filtered = filtered.filter(c => inLevel(c, browse.level));
        if (browse.semester != null) filtered = filtered.filter(c => inSemester(c, browse.semester));
        filtered = filtered.filter(matchesQuery);
        renderBrowseNav();
        renderCourses(filtered);
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            if (currentTab === 'enrolled') resetBrowse();
            filterAndRender();
        });
    });

    document.getElementById('course-search').addEventListener('input', filterAndRender);

    // Courses with an enrollment request in flight — blocks duplicate clicks.
    const enrollingCourses = new Set();

    window.enroll = async (courseId, btn) => {
        if (enrollingCourses.has(courseId)) return;
        enrollingCourses.add(courseId);

        // Swap the clicked button into a loading state so the student can't
        // fire another enrollment while this one is in flight.
        setButtonBusy(btn, true);

        const restoreBtn = () => {
            if (!btn || !btn.isConnected) return; // grid re-rendered; skip
            setButtonBusy(btn, false);
        };

        try {
            const res = await authFetch(`${API_BASE}/api/courses/enroll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ student_id: user.id, course_id: courseId })
            });

            if (res.ok) {
                const course = findCourse(courseId);
                enrolledCourseIds.add(courseId);
                invalidateApiCache('my-courses');
                invalidateApiCache('stats');
                invalidateApiCache('study-summary');
                invalidateApiCache('nav-stats');
                filterAndRender();
                showToast(
                    `You're enrolled in ${course ? course.title : 'the course'}.`,
                    'success',
                    { title: 'Enrolled' }
                );
            } else {
                let detail = 'Enrollment failed.';
                try {
                    const data = await res.json();
                    detail = data.detail || detail;
                } catch (_) { /* non-JSON error body */ }
                showToast(detail, 'error');
                restoreBtn();
            }
        } catch (err) {
            console.error('Enrollment error:', err);
            showToast('Enrollment failed. Please try again.', 'error');
            restoreBtn();
        } finally {
            enrollingCourses.delete(courseId);
        }
    };

    // Courses with an unenrollment request in flight — blocks duplicate clicks.
    const unenrollingCourses = new Set();

    const unenrollModal = document.getElementById('unenroll-modal');
    const unenrollCourseName = document.getElementById('unenroll-course-name');
    const confirmUnenrollBtn = document.getElementById('confirm-unenroll-btn');

    let pendingUnenrollId = null;
    let lastFocused = null;

    function openUnenrollModal(courseId) {
        const course = findCourse(courseId);
        if (!course || unenrollingCourses.has(courseId)) return;
        pendingUnenrollId = courseId;
        unenrollCourseName.textContent = course.title;
        lastFocused = document.activeElement;
        unenrollModal.hidden = false;
        unenrollModal.querySelector('.btn-ghost').focus(); // safe action first
    }

    function hideUnenrollModal() {
        unenrollModal.hidden = true;
        pendingUnenrollId = null;
        if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    }

    function closeUnenrollModal() {
        if (confirmUnenrollBtn.disabled) return; // request in flight — user dismissals blocked
        hideUnenrollModal();
    }

    unenrollModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', closeUnenrollModal));
    unenrollModal.addEventListener('click', e => {
        if (e.target === unenrollModal) closeUnenrollModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !unenrollModal.hidden) closeUnenrollModal();
    });

    confirmUnenrollBtn.addEventListener('click', async () => {
        const courseId = pendingUnenrollId;
        if (!courseId || unenrollingCourses.has(courseId)) return;
        unenrollingCourses.add(courseId);

        // Spinner inside the confirm button; modal stays put until we know
        // the outcome, so the student can't miss what happened.
        setButtonBusy(confirmUnenrollBtn, true);

        try {
            const res = await authFetch(`${API_BASE}/api/courses/${courseId}/enroll`, { method: 'DELETE' });

            if (res.ok) {
                const course = findCourse(courseId);
                enrolledCourseIds.delete(courseId);
                invalidateApiCache('my-courses');
                invalidateApiCache('stats');
                invalidateApiCache('study-summary');
                invalidateApiCache('nav-stats');
                hideUnenrollModal();
                filterAndRender();
                showToast(
                    `You're no longer enrolled in ${course ? course.title : 'the course'}.`,
                    'success',
                    { title: 'Unenrolled' }
                );
            } else {
                let detail = 'Failed to unenroll.';
                try {
                    const data = await res.json();
                    detail = data.detail || detail;
                } catch (_) { /* non-JSON error body */ }
                showToast(detail, 'error');
                hideUnenrollModal();
            }
        } catch (err) {
            console.error('Unenrollment error:', err);
            showToast('Failed to unenroll. Please try again.', 'error');
            hideUnenrollModal();
        } finally {
            unenrollingCourses.delete(courseId);
            setButtonBusy(confirmUnenrollBtn, false);
        }
    });

    window.unenroll = openUnenrollModal;

    await Promise.all([loadEnrolledCourses(), loadAllCourses()]);
    document.getElementById('courses-grid').classList.add('fade-in');
    filterAndRender();
});
