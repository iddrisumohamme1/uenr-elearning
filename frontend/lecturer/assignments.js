/*
   LECTURER ASSIGNMENTS PAGE LOGIC
   frontend/lecturer/assignments.js
   Two creation paths: AI-generate (questions from course material, reviewed
   before assigning to students) or import (upload an existing question file).
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer', 'hod').catch(() => null);
    if (!user) return;

    const coursesEndpoint = (user.role === 'hod')
        ? `${API_BASE}/api/courses/`
        : `${API_BASE}/api/courses/mine`;

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();

    /* ── DOM refs ─────────────────────────────────────────────────────── */
    const choiceSection    = document.getElementById('create-choice');
    const panelAI          = document.getElementById('panel-ai');
    const panelImport      = document.getElementById('panel-import');
    const choiceAI         = document.getElementById('choice-ai');
    const choiceImport     = document.getElementById('choice-import');
    const backAI           = document.getElementById('back-ai');
    const backImport       = document.getElementById('back-import');

    const listEl           = document.getElementById('assign-list');
    const subsModal        = document.getElementById('subs-modal');
    const detailModal      = document.getElementById('sub-detail-modal');
    const detailTitle      = document.getElementById('sub-detail-title');
    const detailBody       = document.getElementById('sub-detail-body');

    // AI path
    const aiCourseSelect   = document.getElementById('ai-course-select');
    const aiGenerateBtn    = document.getElementById('ai-generate-btn');
    const aiGenSpinner     = document.getElementById('ai-gen-spinner');
    const aiGenText        = document.getElementById('ai-gen-text');
    const aiStepConfig     = document.getElementById('ai-step-config');
    const aiStepReview     = document.getElementById('ai-step-review');
    const reviewList       = document.getElementById('review-list');
    const reviewCount      = document.getElementById('review-count');
    const reviewSource     = document.getElementById('review-source');
    const reviewCreateBtn  = document.getElementById('review-create-btn');
    const reviewCreateSpinner = document.getElementById('review-create-spinner');
    const reviewCreateText = document.getElementById('review-create-text');
    const reviewEditConfig = document.getElementById('review-edit-config');

    // Import path
    const impCourseSelect = document.getElementById('imp-course-select');
    const impDropZone     = document.getElementById('imp-drop-zone');
    const impFileInput    = document.getElementById('imp-file');
    const impDropLabel    = document.getElementById('imp-drop-label');
    const impFileError    = document.getElementById('imp-file-error');
    const impParseBtn     = document.getElementById('imp-parse-btn');
    const impParseSpinner = document.getElementById('imp-parse-spinner');
    const impParseText    = document.getElementById('imp-parse-text');

    let courseNames = {};
    let generatedQuestions = [];  // raw from AI / import
    let selectedIndices = new Set();  // indices of selected questions
    let activeSource = 'ai';  // 'ai' | 'import' — which panel backs the review step

    /* ── Helpers ──────────────────────────────────────────────────────── */
    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );
    subsModal && subsModal.addEventListener('click', (e) => { if (e.target === subsModal) closeModal(subsModal); });
    detailModal && detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeModal(detailModal); });

    /* ── Path switching ───────────────────────────────────────────────── */
    function showChoice() {
        choiceSection.hidden = false;
        panelAI.hidden = true;
        panelImport.hidden = true;
    }
    function showAI() {
        choiceSection.hidden = true;
        panelAI.hidden = false;
        panelImport.hidden = true;
    }
    function showImport() {
        choiceSection.hidden = true;
        panelAI.hidden = true;
        panelImport.hidden = false;
    }
    choiceAI.addEventListener('click', showAI);
    choiceImport.addEventListener('click', showImport);
    backAI.addEventListener('click', showChoice);
    backImport.addEventListener('click', showChoice);

    /* ── Load courses ─────────────────────────────────────────────────── */
    async function loadCourses() {
        try {
            const courses = await swrGet('catalog', coursesEndpoint);
            if (!Array.isArray(courses) || !courses.length) {
                aiCourseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                impCourseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }
            courses.forEach(c => { if (c.id) courseNames[c.id] = c.title; });
            const opts = courses.map(c => `<option value="${c.id}">${escapeHTML(c.title)} (${escapeHTML(c.code || 'No code')})</option>`).join('');
            aiCourseSelect.innerHTML = `<option value="" disabled selected>Select a course</option>${opts}`;
            impCourseSelect.innerHTML = `<option value="" disabled selected>Select a course</option>${opts}`;
        } catch (err) {
            console.error('Error loading courses:', err);
            aiCourseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
            impCourseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    /* ── AI path: generate questions ──────────────────────────────────── */
    aiGenerateBtn.addEventListener('click', async () => {
        const courseId = aiCourseSelect.value;
        if (!courseId) {
            showToast('Select a course first.', 'warning');
            return;
        }
        const topic = document.getElementById('ai-topic').value.trim();
        const numObj = Number(document.getElementById('ai-num-obj').value) || 5;
        const numTheory = Number(document.getElementById('ai-num-theory').value) || 2;
        const difficulty = document.getElementById('ai-difficulty').value || 'medium';

        setButtonBusy(aiGenerateBtn, true);

        try {
            const res = await authFetch(`${API_BASE}/api/assignments/generate-questions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    course_id: courseId,
                    topic,
                    num_objective: numObj,
                    num_theory: numTheory,
                    difficulty,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showToast(data.detail || 'Could not generate questions.', 'error');
                return;
            }
            generatedQuestions = [];
            activeSource = 'ai';
            const obj = data.questions?.objective || [];
            const th  = data.questions?.theory || [];
            obj.forEach(q => generatedQuestions.push({ ...q, _type: 'objective' }));
            th.forEach(q  => generatedQuestions.push({ ...q, _type: 'theory' }));

            if (!generatedQuestions.length) {
                showToast('No questions were generated. Try different settings.', 'warning');
                return;
            }

            selectedIndices = new Set(generatedQuestions.map((_, i) => i));
            const matTitles = data.material_titles || [];
            reviewSource.textContent = matTitles.length
                ? `Based on: ${matTitles.slice(0, 3).join(', ')}${matTitles.length > 3 ? '…' : ''}`
                : '';
            renderReview();
            aiStepConfig.hidden = true;
            aiStepReview.hidden = false;
            showToast(`${generatedQuestions.length} questions generated. Review and select.`, 'success');
        } catch (err) {
            showToast('Could not generate questions.', 'error');
        } finally {
            setButtonBusy(aiGenerateBtn, false);
        }
    });

    /* ── Import path: file picker + parse ───────────────────────────────── */
    impDropZone.addEventListener('click', () => impFileInput.click());
    impDropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); impFileInput.click(); }
    });
    impDropZone.addEventListener('dragover', (e) => { e.preventDefault(); impDropZone.classList.add('drop-zone--over'); });
    impDropZone.addEventListener('dragleave', () => impDropZone.classList.remove('drop-zone--over'));
    impDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        impDropZone.classList.remove('drop-zone--over');
        if (e.dataTransfer.files.length) impFileInput.files = e.dataTransfer.files;
        updateImpFileLabel();
    });
    impFileInput.addEventListener('change', updateImpFileLabel);
    function updateImpFileLabel() {
        const f = impFileInput.files && impFileInput.files[0];
        impDropLabel.textContent = f ? f.name : 'Drag and drop a question file here';
        impDropZone.classList.toggle('drop-zone--has-file', Boolean(f));
    }

    async function parseImported() {
        const courseId = impCourseSelect.value;
        const file = impFileInput.files && impFileInput.files[0];
        if (!courseId) { showToast('Select a course first.', 'warning'); return; }
        if (!file) { showToast('Choose a question file to import.', 'warning'); return; }

        setButtonBusy(impParseBtn, true);

        const fd = new FormData();
        fd.append('course_id', courseId);
        fd.append('file', file);

        try {
            const res = await authFetch(`${API_BASE}/api/assignments/import-file`, {
                method: 'POST',
                body: fd,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showToast(data.detail || 'Could not import the questions.', 'error');
                return;
            }

            generatedQuestions = [];
            (data.questions?.objective || []).forEach(q => generatedQuestions.push({ ...q, _type: 'objective' }));
            (data.questions?.theory || []).forEach(q => generatedQuestions.push({ ...q, _type: 'theory' }));

            if (!generatedQuestions.length) {
                showToast('No questions were found in this file. Check the format.', 'warning');
                return;
            }

            activeSource = 'import';
            selectedIndices = new Set(generatedQuestions.map((_, i) => i));

            const fromFile = data.source === 'ai' ? 'From file (AI import — verify answer keys): ' : 'From file: ';
            reviewSource.textContent = fromFile + (data.filename || '');
            renderReview();
            panelImport.hidden = true;
            panelAI.hidden = false;
            aiStepConfig.hidden = true;
            aiStepReview.hidden = false;
            showToast(`${generatedQuestions.length} questions imported. Review and select.`, 'success');
            if (data.skipped && data.skipped.length) {
                showToast(`${data.skipped.length} line(s) could not be read — missing answer keys.`, 'warning');
            }
        } catch (err) {
            showToast('Could not import the questions. Try again.', 'error');
        } finally {
            setButtonBusy(impParseBtn, false);
        }
    }
    impParseBtn.addEventListener('click', parseImported);

    /* ── AI path: review UI ───────────────────────────────────────────── */
    function renderReview() {
        const total = generatedQuestions.length;
        const sel = selectedIndices.size;
        reviewCount.textContent = `${sel} of ${total} selected`;

        reviewList.innerHTML = generatedQuestions.map((q, i) => {
            const isSelected = selectedIndices.has(i);
            const isObj = q._type === 'objective';
            const typeBadge = isObj
                ? '<span class="q-badge q-badge--obj">MCQ</span>'
                : '<span class="q-badge q-badge--theory">Theory</span>';

            let body = '';
            if (isObj) {
                const correctIdx = q.correct_answer_index ?? 0;
                const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                body = `<div class="q-options">
                    ${(q.options || []).map((opt, oi) => `
                        <div class="q-option${oi === correctIdx ? ' q-option--correct' : ''}">
                            <label class="q-opt-radio" title="Mark as the correct answer">
                                <input type="radio" name="correct-${i}" data-correct-qi="${i}" data-oi="${oi}" ${oi === correctIdx ? 'checked' : ''}>
                                <span class="q-option-marker">${letters[oi] || oi + 1}</span>
                            </label>
                            <input class="q-opt-text" type="text" value="${escapeHTML(opt)}" data-opt-qi="${i}" data-oi="${oi}">
                        </div>`).join('')}
                </div>
                <p class="q-opt-hint">Tip: click a letter to mark the correct answer; edit option text directly.</p>`;
            } else {
                body = q.suggested_answer_rubric
                    ? `<div class="q-rubric"><strong>Model answer:</strong> ${escapeHTML(q.suggested_answer_rubric)}</div>`
                    : '';
            }

            return `
                <div class="q-card${isSelected ? '' : ' q-card--deselected'}" data-qi="${i}">
                    <div class="q-card-head">
                        <div class="q-card-head-left">
                            <span class="q-num">Q${i + 1}</span>
                            ${typeBadge}
                        </div>
                        <div class="q-card-head-right">
                            <label class="q-toggle" title="${isSelected ? 'Deselect' : 'Select'} this question">
                                <input type="checkbox" ${isSelected ? 'checked' : ''} data-toggle-qi="${i}">
                                <span class="q-toggle-track"></span>
                            </label>
                        </div>
                    </div>
                    <div class="q-text" id="q-text-${i}">${escapeHTML(q.question)}</div>
                    <textarea class="q-textarea" id="q-edit-${i}" hidden rows="2">${escapeHTML(q.question)}</textarea>
                    ${body}
                    <div class="q-actions">
                        <button class="btn-text" type="button" data-edit-qi="${i}"><i class="bi bi-pencil"></i> Edit</button>
                        <button class="btn-text" type="button" data-regen-qi="${i}"><i class="bi bi-arrow-clockwise"></i> Regenerate</button>
                    </div>
                </div>`;
        }).join('');

        // Toggle handlers
        reviewList.querySelectorAll('[data-toggle-qi]').forEach(cb => {
            cb.addEventListener('change', () => {
                const qi = Number(cb.dataset.toggleQi);
                if (cb.checked) selectedIndices.add(qi);
                else selectedIndices.delete(qi);
                const card = reviewList.querySelector(`[data-qi="${qi}"]`);
                if (card) card.classList.toggle('q-card--deselected', !cb.checked);
                reviewCount.textContent = `${selectedIndices.size} of ${generatedQuestions.length} selected`;
            });
        });

        // Correct-answer radios
        reviewList.querySelectorAll('[data-correct-qi]').forEach(radio => {
            radio.addEventListener('change', () => {
                const qi = Number(radio.dataset.correctQi);
                const oi = Number(radio.dataset.oi);
                if (radio.checked && generatedQuestions[qi]) {
                    generatedQuestions[qi].correct_answer_index = oi;
                    renderReview();
                }
            });
        });

        // Option text edits
        reviewList.querySelectorAll('[data-opt-qi]').forEach(inp => {
            inp.addEventListener('change', () => {
                const qi = Number(inp.dataset.optQi);
                const oi = Number(inp.dataset.oi);
                const q = generatedQuestions[qi];
                if (!q || !Array.isArray(q.options)) return;
                q.options[oi] = inp.value.trim() || q.options[oi];
                inp.value = q.options[oi];
            });
        });

        // Edit handlers
        reviewList.querySelectorAll('[data-edit-qi]').forEach(btn => {
            btn.addEventListener('click', () => {
                const qi = Number(btn.dataset.editQi);
                const textEl = document.getElementById(`q-text-${qi}`);
                const editEl = document.getElementById(`q-edit-${qi}`);
                const isEditing = !editEl.hidden;
                if (isEditing) {
                    // Save edit
                    generatedQuestions[qi].question = editEl.value.trim() || generatedQuestions[qi].question;
                    textEl.textContent = generatedQuestions[qi].question;
                    editEl.hidden = true;
                    textEl.hidden = false;
                    btn.innerHTML = '<i class="bi bi-pencil"></i> Edit';
                } else {
                    editEl.hidden = false;
                    textEl.hidden = true;
                    editEl.focus();
                    btn.innerHTML = '<i class="bi bi-check-lg"></i> Save';
                }
            });
        });

        // Regenerate handlers
        reviewList.querySelectorAll('[data-regen-qi]').forEach(btn => {
            btn.addEventListener('click', () => regenerateQuestion(Number(btn.dataset.regenQi)));
        });
    }

    async function regenerateQuestion(qi) {
        const q = generatedQuestions[qi];
        const courseId = aiCourseSelect.value;
        const topic = document.getElementById('ai-topic').value.trim();
        const difficulty = document.getElementById('ai-difficulty').value || 'medium';
        const isObj = q._type === 'objective';

        const card = reviewList.querySelector(`[data-qi="${qi}"]`);
        if (card) card.style.opacity = '0.5';

        try {
            const res = await authFetch(`${API_BASE}/api/assignments/generate-questions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    course_id: courseId,
                    topic: topic || q.question,
                    num_objective: isObj ? 1 : 0,
                    num_theory: isObj ? 0 : 1,
                    difficulty,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.questions) {
                const newQs = isObj ? (data.questions.objective || []) : (data.questions.theory || []);
                if (newQs.length) {
                    generatedQuestions[qi] = { ...newQs[0], _type: q._type };
                    renderReview();
                    showToast('Question regenerated.', 'success');
                    return;
                }
            }
            showToast('Could not regenerate. Keeping original.', 'warning');
        } catch {
            showToast('Could not regenerate. Keeping original.', 'warning');
        } finally {
            if (card) card.style.opacity = '';
        }
    }

    // Select all / deselect all
    document.getElementById('review-select-all').addEventListener('click', () => {
        selectedIndices = new Set(generatedQuestions.map((_, i) => i));
        renderReview();
    });
    document.getElementById('review-deselect-all').addEventListener('click', () => {
        selectedIndices = new Set();
        renderReview();
    });
    document.getElementById('review-regen-all').addEventListener('click', async () => {
        for (let i = 0; i < generatedQuestions.length; i++) {
            await regenerateQuestion(i);
        }
    });

    // Back to config
    reviewEditConfig.addEventListener('click', () => {
        aiStepReview.hidden = true;
        if (activeSource === 'import') {
            panelAI.hidden = true;
            panelImport.hidden = false;
        } else {
            aiStepConfig.hidden = false;
        }
    });

    /* ── AI path: create assignment with selected questions ────────────── */
    function activeMeta() {
        const isImport = activeSource === 'import';
        const courseId = isImport ? impCourseSelect.value : aiCourseSelect.value;
        const title = (isImport
            ? document.getElementById('imp-assign-title').value
            : document.getElementById('ai-assign-title').value).trim();
        return {
            courseId,
            title,
            instructions: (isImport
                ? document.getElementById('imp-instructions').value
                : document.getElementById('ai-instructions').value).trim() || 'Answer all the questions.',
            dueDate: (isImport
                ? document.getElementById('imp-due').value
                : document.getElementById('ai-due').value) || null,
            weekNum: (isImport
                ? document.getElementById('imp-week').value
                : document.getElementById('ai-week').value) ? Number(isImport
                ? document.getElementById('imp-week').value
                : document.getElementById('ai-week').value) : null,
        };
    }

    function resetSourcePanels() {
        aiStepConfig.hidden = false;
        aiStepReview.hidden = true;
        panelImport.hidden = true;
        document.getElementById('ai-assign-title').value = '';
        document.getElementById('ai-topic').value = '';
        document.getElementById('ai-instructions').value = '';
        document.getElementById('ai-due').value = '';
        document.getElementById('ai-week').value = '';
        document.getElementById('imp-assign-title').value = '';
        document.getElementById('imp-instructions').value = '';
        document.getElementById('imp-due').value = '';
        document.getElementById('imp-week').value = '';
        impFileInput.value = '';
        updateImpFileLabel();
    }

    reviewCreateBtn.addEventListener('click', async () => {
        const { courseId, title, instructions, dueDate, weekNum } = activeMeta();
        if (!courseId || !title) {
            showToast('Select a course and enter a title.', 'warning');
            return;
        }
        if (!selectedIndices.size) {
            showToast('Select at least one question.', 'warning');
            return;
        }

        // Build the questions payload from selected questions
        const objQs = [];
        const thQs = [];
        selectedIndices.forEach(i => {
            const q = generatedQuestions[i];
            if (q._type === 'objective') {
                objQs.push({
                    question: q.question,
                    options: q.options || [],
                    correct_answer_index: q.correct_answer_index ?? 0,
                });
            } else {
                thQs.push({
                    question: q.question,
                    suggested_answer_rubric: q.suggested_answer_rubric || '',
                });
            }
        });
        const questions = { objective: objQs, theory: thQs };

        setButtonBusy(reviewCreateBtn, true);

        try {
            const res = await authFetch(`${API_BASE}/api/assignments/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    course_id: courseId,
                    title,
                    instructions,
                    due_date: dueDate,
                    week_number: weekNum,
                    questions,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast('Assignment created.', 'success');
                invalidateApiCache(`assign:${courseId}`);
                loadAssignments();
                // Reset both flows
                generatedQuestions = [];
                selectedIndices = new Set();
                activeSource = 'ai';
                resetSourcePanels();
                showChoice();
            } else {
                showToast(data.detail || 'Could not create assignment.', 'error');
            }
        } catch {
            showToast('Could not create assignment.', 'error');
        } finally {
            setButtonBusy(reviewCreateBtn, false);
        }
    });

    /* ── View submissions table + per-student detail ──────────────────── */
    let subsRows = [];
    let subsSort = { key: 'student_name', dir: 1 };

    function sortSubs(rows) {
        const { key, dir } = subsSort;
        const val = (r) => {
            const v = r[key];
            if (key === 'submitted_at') return v ? new Date(v).getTime() : (dir === 1 ? Infinity : -Infinity);
            return v == null ? '' : String(v).toLowerCase();
        };
        return [...rows].sort((a, b) => {
            const va = val(a), vb = val(b);
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }

    function statusCell(s) {
        if (!s.submitted) return '<span class="badge badge--none">Not submitted</span>';
        if (s.score == null) return '<span class="badge badge--warning">Awaiting grade</span>';
        return '';
    }

    function renderSubsTable() {
        const body = document.getElementById('subs-body');
        const sorted = sortSubs(subsRows);
        const submittedCount = subsRows.filter(s => s.submitted).length;
        const onTimeCount = subsRows.filter(s => s.submitted && s.on_time).length;

        const th = (label, key) => {
            const active = subsSort.key === key;
            const arrow = active ? (subsSort.dir === 1 ? ' &uarr;' : ' &darr;') : '';
            return `<th class="subs-th" data-sort="${key}" role="columnheader" tabindex="0" aria-sort="${active ? (subsSort.dir === 1 ? 'ascending' : 'descending') : 'none'}">${label}${active ? arrow : ''}</th>`;
        };

        body.innerHTML = `
            <p class="text-muted subs-summary">${subsRows.length} student${subsRows.length === 1 ? '' : 's'} · ${submittedCount} submitted · ${onTimeCount} on time · ${subsRows.length - submittedCount} not submitted</p>
            <div class="data-table subs-table">
                <table>
                    <thead><tr>
                        ${th('Student', 'student_name')}
                        <th>Index</th>
                        ${th('Submitted', 'submitted_at')}
                        <th>Status</th>
                        ${th('Score', 'score')}
                        <th>Grade</th>
                    </tr></thead>
                    <tbody>
                    ${sorted.map(s => {
                        const grade = s.letter_grade
                            ? `<span class="grade-pill grade-pill--${statusTone(s)}">${s.letter_grade}</span>`
                            : '<span class="text-muted">–</span>';
                        const score = s.score != null
                            ? `<span class="score-num score-num--${scoreTone(s.score)}">${s.score}%</span>`
                            : '<span class="text-muted">–</span>';
                        return `
                        <tr class="subs-row" data-student-id="${s.student_id}" tabindex="0" role="button" aria-label="View submission for ${escapeHTML(s.student_name || '')}">
                            <td><span class="subs-student">${escapeHTML(s.student_name || 'Unknown student')}</span></td>
                            <td><span class="mono-id">${s.student_index ? escapeHTML(s.student_index) : '—'}</span></td>
                            <td class="subs-time">${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '—'}</td>
                            <td>${statusCell(s)}</td>
                            <td>${score}</td>
                            <td>${grade}</td>
                        </tr>`;
                    }).join('')}
                    </tbody>
                </table>
            </div>`;

        body.querySelectorAll('.subs-th').forEach(thEl => {
            thEl.addEventListener('click', () => {
                const key = thEl.dataset.sort;
                if (subsSort.key === key) subsSort.dir *= -1;
                else subsSort = { key, dir: 1 };
                renderSubsTable();
            });
            thEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); thEl.click(); }
            });
        });

        body.querySelectorAll('.subs-row').forEach(row => {
            const open = () => openSubDetail(sortSubs(subsRows).find(s => s.student_id === row.dataset.studentId));
            row.addEventListener('click', open);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
            });
        });
    }

    function statusTone(s) {
        if (!s.submitted) return 'none';
        if (s.score == null) return 'pending';
        const sc = s.score;
        if (sc >= 70) return 'high';
        if (sc >= 50) return 'mid';
        return 'low';
    }
    function scoreTone(sc) {
        if (sc >= 70) return 'high';
        if (sc >= 50) return 'mid';
        return 'low';
    }

    function openSubDetail(s) {
        if (!s) return;
        detailTitle.textContent = s.student_name || 'Submission detail';
        const notSubmitted = !s.submitted;
        const awaiting = !notSubmitted && s.score == null;
        detailBody.innerHTML = `
            <div class="detail-id-row">
                <span class="mono-id">${s.student_index ? escapeHTML(s.student_index) : 'No index number'}</span>
                <span class="badge ${notSubmitted ? 'badge--none' : (awaiting ? 'badge--warning' : 'badge--success')}">${notSubmitted ? 'Not submitted' : (awaiting ? 'Awaiting grade' : 'Graded')}</span>
            </div>
            ${notSubmitted ? `
                <div class="detail-empty">
                    <p>This student has not submitted an answer yet.</p>
                </div>` : `
                <div class="detail-grid">
                    <div class="detail-field">
                        <span class="detail-label">Submitted</span>
                        <span class="detail-value">${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '—'}</span>
                    </div>
                    <div class="detail-field">
                        <span class="detail-label">Timing</span>
                        <span class="detail-value ${s.on_time ? 'tone-ok' : 'tone-late'}">${s.on_time ? 'On time' : 'Late'}</span>
                    </div>
                    <div class="detail-field">
                        <span class="detail-label">Score</span>
                        <span class="detail-value">${s.score != null ? `${s.score}%` : '—'}</span>
                    </div>
                    <div class="detail-field">
                        <span class="detail-label">Grade</span>
                        <span class="detail-value">${s.letter_grade || '—'}</span>
                    </div>
                </div>
                ${s.content ? `<div class="detail-block"><span class="detail-label">Answer</span><div class="detail-content">${escapeHTML(s.content)}</div></div>` : ''}
                ${s.feedback ? `<div class="detail-block"><span class="detail-label">Feedback</span><div class="detail-feedback">${escapeHTML(s.feedback)}</div></div>` : ''}
            `}
        `;
        detailModal.hidden = false;
    }

    async function viewSubmissions(assignmentId, title) {
        document.getElementById('subs-title').textContent = title;
        const body = document.getElementById('subs-body');
        subsModal.hidden = false;
        body.innerHTML = '<div class="loading-wrapper loading-full"><div class="spinner"></div><p>Loading submissions…</p></div>';
        try {
            const data = await swrGet(`subs:${assignmentId}`, `${API_BASE}/api/assignments/${assignmentId}/submissions`);
            subsRows = data.submissions || [];
            if (!subsRows.length) {
                body.innerHTML = '<p class="text-muted">No students enrolled in this course yet.</p>';
                return;
            }
            subsSort = { key: 'student_name', dir: 1 };
            renderSubsTable();
        } catch (err) {
            body.innerHTML = '<p class="text-muted">Unable to load submissions.</p>';
            showToast('Unable to load submissions.', 'error');
        }
    }

    /* ── Load assignments list (unchanged) ────────────────────────────── */
    async function loadAssignments() {
        try {
            const courses = await swrGet('catalog', coursesEndpoint);
            if (!Array.isArray(courses) || !courses.length) {
                listEl.innerHTML = '<p class="text-muted">No courses assigned yet.</p>';
                return;
            }

            let rows = [];
            for (const course of courses) {
                let data = null;
                try {
                    data = await swrGet(`assign:${course.id}`, `${API_BASE}/api/assignments/course/${course.id}`);
                } catch (err) { continue; }
                ((data && data.assignments) || []).forEach(a => {
                    rows.push({
                        ...a,
                        course_id: course.id,
                        courseLabel: `${course.code || 'N/A'} · ${course.title}`,
                    });
                });
            }

            if (!rows.length) {
                listEl.innerHTML = '<p class="text-muted">You have not created any assignments yet.</p>';
                return;
            }

            rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            listEl.innerHTML = rows.map(a => {
                const total = a.submission_count || 0;
                const hasQuestions = Boolean(a.questions);
                const autoLabel = a.auto_generated ? ' <span class="badge badge--ontime">Auto</span>' : '';
                const aiLabel = hasQuestions && !a.auto_generated ? ' <span class="badge badge--count">AI</span>' : '';
                return `
                <div class="assign-item">
                    <div class="assign-item-head">
                        <div>
                            <h4>${escapeHTML(a.title)}${autoLabel}${aiLabel}</h4>
                            <div class="assign-meta">
                                <span>${escapeHTML(a.courseLabel)}</span>
                                <span>Week ${a.week_number || '–'}</span>
                                <span>Due ${a.due_date || 'flexible'}</span>
                            </div>
                        </div>
                        <div class="assign-badges">
                            <span class="badge badge--count">${total} submitted</span>
                            ${total ? `<span class="badge badge--ontime">${a.on_time_count || 0} on time</span>` : ''}
                        </div>
                    </div>
                    ${a.instructions ? `<p class="assign-instructions">${escapeHTML(a.instructions)}</p>` : ''}
                    <div class="assign-actions">
                        <button class="btn-msg" data-id="${a.id}" data-title="${escapeHTML(a.title)}">View submissions</button>
                    </div>
                </div>`;
            }).join('');

            listEl.querySelectorAll('.btn-msg').forEach(btn => {
                btn.addEventListener('click', () => viewSubmissions(btn.dataset.id, btn.dataset.title));
            });
        } catch (err) {
            console.error('Error loading assignments:', err);
            listEl.innerHTML = '<p class="text-muted">Unable to load assignments.</p>';
            showToast('Unable to load assignments.', 'error');
        }
    }

    function escapeHTML(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    /* ── Init ─────────────────────────────────────────────────────────── */
    await loadCourses();
    loadAssignments();
    showChoice();
});
