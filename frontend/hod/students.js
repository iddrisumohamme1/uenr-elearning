/*
   HOD DEPARTMENT STUDENTS PAGE
   frontend/hod/students.js
   Lists every student registered in the HOD's department as a searchable,
   sortable roster. Each row surfaces an at-risk/on-track status with a
   plain-language reason (aggregated from per-course analytics), supports
   direct and multi-select messaging, CSV export, and a per-student profile
   drill-down. Renders a full table on desktop and an equivalent card grid
   on small screens.
*/

function escapeHTML(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(str).replace(/[&<>"']/g, c => map[c]);
}

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'H').charAt(0).toUpperCase();
    document.getElementById('dept-name').textContent = `${user.department || 'Department'} · Students`;

    const body       = document.getElementById('roster-body');
    const cardList   = document.getElementById('roster-cards');
    const searchBox  = document.getElementById('roster-search');
    const qfButtons  = Array.from(document.querySelectorAll('.qf-btn'));
    const countAll   = document.getElementById('rf-count-all');
    const countRisk  = document.getElementById('rf-count-risk');
    const countOk    = document.getElementById('rf-count-ok');
    const countEl    = document.getElementById('roster-count');
    const exportBtn  = document.getElementById('export-csv');
    const msgSelBtn  = document.getElementById('message-selected');
    const selectAllChk = document.getElementById('select-all');
    const statTotal  = document.getElementById('stat-total');
    const statRisk   = document.getElementById('stat-at-risk');
    const statOk     = document.getElementById('stat-ontrack');

    let students      = [];
    let courseNames   = {};
    let riskByStudent = new Map();   // student_id -> { courses: [{id,title,reason}] , worstDays }
    let sortKey       = 'risk';
    let sortDir       = 1;
    let riskFilter    = 'all';       // 'all' | 'risk' | 'ok'
    let selected      = new Set();

    function openModal(modal) { modal.hidden = false; document.body.style.overflow = 'hidden'; }
    function closeModal(modal) { modal.hidden = true; document.body.style.overflow = ''; }

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(document.getElementById(btn.dataset.closeModal)));
    });
    document.querySelectorAll('.modal-overlay').forEach(ov => {
        ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(ov); });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
            document.querySelectorAll('.modal-overlay:not([hidden])').forEach(closeModal);
        }
    });

    /* ── Load roster + department courses ────────────────────────────── */
    async function loadData() {
        try {
            const [roster, catalog] = await Promise.all([
                swrGet('hod-students', `${API_BASE}/api/users/students`).catch(() => []),
                swrGet('hod-students-catalog', `${API_BASE}/api/courses/`).catch(() => []),
            ]);

            students = Array.isArray(roster) ? roster : [];
            courseNames = {};
            (Array.isArray(catalog) ? catalog : []).forEach(c => { courseNames[c.id] = c.title || c.code || 'Course'; });

            await buildRiskMap(catalog);

            const riskCount = [...riskByStudent.values()].filter(r => r.courses.length).length;
            statTotal.textContent = students.length;
            statRisk.textContent = riskCount;
            statOk.textContent = Math.max(0, students.length - riskCount);
            countAll.textContent = students.length;
            countRisk.textContent = riskCount;
            countOk.textContent = Math.max(0, students.length - riskCount);

            render();
        } catch (err) {
            console.error('Unable to load students:', err);
            body.innerHTML = '<tr><td colspan="5" class="empty-cell">Unable to load students. Give it another try.</td></tr>';
            cardList.innerHTML = '<p class="empty-cell">Unable to load students. Give it another try.</p>';
            showToast('Unable to load students.', 'error');
        }
    }

    async function buildRiskMap(catalog) {
        riskByStudent = new Map();
        const courses = Array.isArray(catalog) ? catalog : [];
        const perCourse = await Promise.all(
            courses.map(c =>
                swrGet(`roster-at-risk:${c.id}`, `${API_BASE}/api/analytics/course/${c.id}/at-risk`)
                    .then(d => ({ course: c, data }))
                    .catch(() => ({ course: c, data: null }))
            )
        );
        for (const { course, data } of perCourse) {
            const flagged = (data && Array.isArray(data.students)) ? data.students : [];
            for (const s of flagged) {
                const sid = s.student_id;
                if (!sid || !students.some(st => st.id === sid)) continue;  // only department roster members
                let entry = riskByStudent.get(sid);
                if (!entry) entry = { courses: [], worstDays: null };
                const days = s.days_since_last_activity;
                if (typeof days === 'number') entry.worstDays = entry.worstDays == null ? days : Math.max(entry.worstDays, days);
                const reason = buildReason(s);
                entry.courses.push({ id: course.id, title: courseNames[course.id] || course.title || 'course', reason });
                riskByStudent.set(sid, entry);
            }
        }
    }

    function buildReason(s) {
        const parts = [];
        if (typeof s.reading_minutes === 'number' && s.reading_minutes > 0) parts.push(`${s.reading_minutes} min read`);
        if (typeof s.latest_quiz_score === 'number') parts.push(`quiz ${s.latest_quiz_score}%`);
        if (typeof s.days_since_last_activity === 'number') parts.push(`${s.days_since_last_activity} d inactive`);
        return parts.length ? parts.join(' · ') : 'flagged at risk';
    }

    /* ── Filtering / sorting ─────────────────────────────────────────── */
    function filtered() {
        const q = (searchBox.value || '').trim().toLowerCase();
        return students
            .filter(st => {
                const atRisk = (riskByStudent.get(st.id) || { courses: [] }).courses.length > 0;
                if (riskFilter === 'risk' && !atRisk) return false;
                if (riskFilter === 'ok' && atRisk) return false;
                if (!q) return true;
                return (st.full_name || '').toLowerCase().includes(q)
                    || (st.index_number || '').toLowerCase().includes(q);
            })
            .sort((a, b) => {
                const riskA = riskByStudent.get(a.id) || { courses: [] };
                const riskB = riskByStudent.get(b.id) || { courses: [] };
                if (sortKey === 'risk') {
                    const r = (riskB.courses.length - riskA.courses.length) * sortDir;
                    return r || (a.full_name || '').localeCompare(b.full_name || '');
                }
                if (sortKey === 'index') return (a.index_number || '').localeCompare(b.index_number || '') * sortDir;
                return (a.full_name || '').localeCompare(b.full_name || '') * sortDir;
            });
    }

    function statusHTML(st) {
        const risk = riskByStudent.get(st.id) || { courses: [] };
        if (!risk.courses.length) return '<span class="risk-chip risk-chip--ok">On track</span>';
        return `
            <span class="risk-chip risk-chip--risk">At risk</span>
            <span class="risk-reason">${escapeHTML(risk.courses[0].reason)} — ${risk.courses.length} course${risk.courses.length !== 1 ? 's' : ''}</span>`;
    }

    /* ── Rendering (table on desktop, cards on mobile) ───────────────── */
    function render() {
        const list = filtered();
        selected = new Set([...selected].filter(id => students.some(s => s.id === id)));
        selectAllChk.checked = list.length > 0 && list.every(s => selected.has(s.id));
        updateMsgSelBtn();
        countEl.textContent = `${list.length} student${list.length !== 1 ? 's' : ''}`;
        qfButtons.forEach(b => b.classList.toggle('is-active', b.dataset.rf === riskFilter));

        if (!list.length) {
            const msg = students.length ? 'No students match your filters.' : 'No students in this department yet.';
            body.innerHTML = `<tr><td colspan="5" class="empty-cell">${msg}</td></tr>`;
            cardList.innerHTML = `<p class="empty-cell">${msg}</p>`;
            return;
        }

        body.innerHTML = list.map(st => {
            const risk = riskByStudent.get(st.id) || { courses: [] };
            const rk = risk.courses.length ? 'risk' : 'ok';
            const checked = selected.has(st.id) ? ' checked' : '';
            return `
            <tr class="roster-row${rk === 'risk' ? ' row-risk' : ''}">
                <td class="col-check"><input type="checkbox" data-id="${st.id}" class="row-check"${checked}></td>
                <td>
                    <button class="name-link" data-profile="${st.id}">
                        <span class="avatar-sm">${escapeHTML((st.full_name || '?').charAt(0).toUpperCase())}</span>
                        <span class="name-text">${escapeHTML(st.full_name || '—')}</span>
                    </button>
                </td>
                <td class="mono">${escapeHTML(st.index_number || '—')}</td>
                <td>${statusHTML(st)}</td>
                <td><button class="btn-msg btn-sm" data-msg="${st.id}">Message</button></td>
            </tr>`;
        }).join('');

        cardList.innerHTML = list.map(st => {
            const risk = riskByStudent.get(st.id) || { courses: [] };
            const rk = risk.courses.length ? 'risk' : 'ok';
            const checked = selected.has(st.id) ? ' checked' : '';
            return `
            <article class="roster-card-m${rk === 'risk' ? ' is-risk' : ''}">
                <div class="rcm-head">
                    <input type="checkbox" data-id="${st.id}" class="row-check"${checked} aria-label="Select ${escapeHTML(st.full_name || 'student')}">
                    <button class="name-link" data-profile="${st.id}">
                        <span class="avatar-sm">${escapeHTML((st.full_name || '?').charAt(0).toUpperCase())}</span>
                        <span class="name-text">${escapeHTML(st.full_name || '—')}</span>
                    </button>
                </div>
                <div class="rcm-meta">
                    <span class="mono">${escapeHTML(st.index_number || '—')}</span>
                    <span class="roster-email">${escapeHTML(st.email || '—')}</span>
                </div>
                <div class="rcm-status">${statusHTML(st)}</div>
                <div class="rcm-actions">
                    <button class="btn-msg btn-sm" data-msg="${st.id}"><i class="bi bi-send"></i> Message</button>
                </div>
            </article>`;
        }).join('');
    }

    searchBox.addEventListener('input', () => { selectAllChk.checked = false; render(); });
    qfButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            riskFilter = btn.dataset.rf;
            render();
        });
    });

    document.querySelectorAll('.roster-table th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
            render();
        });
    });

    /* ── Selection ───────────────────────────────────────────────────── */
    function updateMsgSelBtn() {
        const n = selected.size;
        msgSelBtn.disabled = false;
        const badge = document.getElementById('msg-count');
        if (n > 0) {
            badge.textContent = n;
            badge.hidden = false;
        } else {
            badge.hidden = true;
        }
    }
    function syncSelection() {
        selectAllChk.checked = filtered().length > 0 && filtered().every(s => selected.has(s.id));
        updateMsgSelBtn();
    }
    selectAllChk.addEventListener('change', () => {
        const list = filtered();
        if (selectAllChk.checked) list.forEach(s => selected.add(s.id));
        else selected.clear();
        render();
    });
    document.addEventListener('change', (e) => {
        if (!e.target.classList.contains('row-check')) return;
        const id = e.target.dataset.id;
        if (e.target.checked) selected.add(id); else selected.delete(id);
        syncSelection();
    });

    /* ── Profile drill-down ──────────────────────────────────────────── */
    document.addEventListener('click', async (e) => {
        const profileBtn = e.target.closest('[data-profile]');
        if (profileBtn) {
            const st = students.find(s => s.id === profileBtn.dataset.profile);
            if (st) await openProfile(st);
        }
    });

    async function openProfile(st) {
        if (!st) return;
        const modal = document.getElementById('profile-modal');
        document.getElementById('profile-name').textContent = st.full_name || 'Student profile';
        document.getElementById('profile-body').innerHTML =
            '<div class="loading-wrapper"><div class="spinner"></div><p>Loading profile…</p></div>';
        openModal(modal);
        try {
            const courses = await swrGet(`roster-profile:${st.id}`, `${API_BASE}/api/students/${st.id}/courses`);
            const risk = riskByStudent.get(st.id);
            const riskLine = risk && risk.courses.length
                ? `<p class="profile-line"><span class="risk-chip risk-chip--risk">At risk</span> ${escapeHTML(risk.courses.map(c => c.reason).join('; '))}</p>`
                : '<p class="profile-line"><span class="risk-chip risk-chip--ok">On track</span> No current at-risk flags across the department.</p>';
            const courseRows = (Array.isArray(courses) ? courses : [])
                .map(c => `<li><span class="mono">${escapeHTML(c.code || '—')}</span> ${escapeHTML(c.title)} <em class="text-muted">${c.progress || 0}%</em></li>`)
                .join('') || '<li class="text-muted">Not enrolled in any courses.</li>';
            document.getElementById('profile-body').innerHTML = `
                <p class="profile-line"><strong>${escapeHTML(st.email || '—')}</strong> · <span class="mono">${escapeHTML(st.index_number || 'no index')}</span></p>
                ${riskLine}
                <hr class="profile-hr">
                <h4 class="profile-subhead">Enrolled Courses</h4>
                <ul class="profile-courses">${courseRows}</ul>
                <div class="modal-actions">
                    <button class="btn-tool btn-tool--ghost" data-close-modal="profile-modal">Close</button>
                    <button class="btn-tool btn-tool--primary" data-msg-profile="${st.id}"><i class="bi bi-send"></i><span>Message</span></button>
                </div>`;
            const msgProfile = document.querySelector('[data-msg-profile]');
            msgProfile && msgProfile.addEventListener('click', () => {
                closeModal(modal);
                openMessage(st.full_name, st.id);
            });
            const closeInBody = document.querySelector('#profile-body [data-close-modal="profile-modal"]');
            closeInBody && closeInBody.addEventListener('click', () => closeModal(modal));
        } catch (err) {
            document.getElementById('profile-body').innerHTML = '<p class="text-muted">Unable to load this profile.</p>';
        }
    }

    /* ── Messaging (single + multi-select) ───────────────────────────── */
    let messageRecipients = [];

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-msg]:not([data-msg-profile])');
        if (btn) {
            const st = students.find(s => s.id === btn.dataset.msg);
            if (st) openMessage(st.full_name, st.id);
        }
    });

    function recipientLabel() {
        return messageRecipients.length
            ? `${messageRecipients.length} student${messageRecipients.length !== 1 ? 's' : ''}`
            : 'a student';
    }

    function openMessage(studentLabel, studentId) {
        messageRecipients = [{ student_id: studentId }];
        document.getElementById('message-to').textContent = `Message ${studentLabel}`;
        document.getElementById('message-course').textContent = studentLabel;
        document.getElementById('message-content').value = '';
        openModal(document.getElementById('message-modal'));
        document.getElementById('message-content').focus();
    }

    msgSelBtn.addEventListener('click', () => {
        const picked = [...selected].map(id => students.find(s => s.id === id)).filter(Boolean);
        if (!picked.length) {
            showToast('Tick the boxes next to students to message them.', 'info');
            selectAllChk.focus();
            return;
        }
        messageRecipients = picked.map(s => ({ student_id: s.id, name: s.full_name }));
        document.getElementById('message-to').textContent = `Message ${picked.length} student${picked.length !== 1 ? 's' : ''}`;
        document.getElementById('message-course').textContent = picked.map(s => s.full_name).join(', ');
        document.getElementById('message-content').value = '';
        openModal(document.getElementById('message-modal'));
        document.getElementById('message-content').focus();
    });

    document.getElementById('message-send').addEventListener('click', async () => {
        const content = document.getElementById('message-content').value;
        if (!content.trim()) { showToast('Write a message before sending.', 'error'); return; }
        const btn = document.getElementById('message-send');
        const prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        let okCount = 0;
        try {
            for (const r of messageRecipients) {
                try {
                    const res = await authFetch(`${API_BASE}/api/messages/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ recipient_id: r.student_id, course_id: null, content }),
                    });
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        showToast(data.detail || `Could not message ${r.name || 'a student'}.`, 'error');
                    } else {
                        okCount += 1;
                    }
                } catch (err) {
                    showToast(`Could not message ${r.name || 'a student'}.`, 'error');
                }
            }
            if (okCount > 0) {
                showToast(`Message sent to ${okCount === messageRecipients.length ? recipientLabel() : `${okCount} of ${messageRecipients.length}`}.`, 'success');
                closeModal(document.getElementById('message-modal'));
            }
        } finally {
            btn.disabled = false;
            btn.textContent = prev;
        }
    });

    /* ── CSV export (honours current filter + sort) ──────────────────── */
    exportBtn.addEventListener('click', () => {
        const rows = filtered().map(st => {
            const risk = riskByStudent.get(st.id) || { courses: [] };
            return [st.full_name || '', st.index_number || '', st.email || '', risk.courses.length ? 'At risk' : 'On track'];
        });
        const header = ['Name', 'Index Number', 'Email', 'Status'];
        const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `students-${(user.department || 'dept').replace(/\s+/g, '-').toLowerCase()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Roster exported to CSV.', 'success');
    });

    /* Sticky header offset is set by the shared sidebar.js (--sticky-header-top);
       the toolbar's sticky top falls back to 0px via CSS if it ever runs here
       without the sidebar. */

    await loadData();
});
