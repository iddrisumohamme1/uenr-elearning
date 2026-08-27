/*
   LECTURER ASSIGNMENTS PAGE LOGIC
   frontend/lecturer/assignments.js
   Two creation paths: write-your-own (text assignment) or AI-generate
   (questions from course material, reviewed before assigning to students).
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();

    /* ── DOM refs ─────────────────────────────────────────────────────── */
    const choiceSection    = document.getElementById('create-choice');
    const panelWrite       = document.getElementById('panel-write');
    const panelAI          = document.getElementById('panel-ai');
    const choiceWrite      = document.getElementById('choice-write');
    const choiceAI         = document.getElementById('choice-ai');
    const backWrite        = document.getElementById('back-write');
    const backAI           = document.getElementById('back-ai');

    // Write path
    const courseSelect     = document.getElementById('course-select');
    const form             = document.getElementById('assign-form');
    const listEl           = document.getElementById('assign-list');
    const subsModal        = document.getElementById('subs-modal');

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

    let courseNames = {};
    let generatedQuestions = [];  // raw from AI
    let selectedIndices = new Set();  // indices of selected questions

    /* ── Helpers ──────────────────────────────────────────────────────── */
    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );
    subsModal && subsModal.addEventListener('click', (e) => { if (e.target === subsModal) closeModal(subsModal); });

    /* ── Path switching ───────────────────────────────────────────────── */
    function showChoice() {
        choiceSection.hidden = false;
        panelWrite.hidden = true;
        panelAI.hidden = true;
    }
    function showWrite() {
        choiceSection.hidden = true;
        panelWrite.hidden = false;
        panelAI.hidden = true;
    }
    function showAI() {
        choiceSection.hidden = true;
        panelWrite.hidden = true;
        panelAI.hidden = false;
    }
    choiceWrite.addEventListener('click', showWrite);
    choiceAI.addEventListener('click', showAI);
    backWrite.addEventListener('click', showChoice);
    backAI.addEventListener('click', showChoice);

    /* ── Load courses ─────────────────────────────────────────────────── */
    async function loadCourses() {
        try {
            const courses = await swrGet('catalog', `${API_BASE}/api/courses/`);
            if (!Array.isArray(courses) || !courses.length) {
                courseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                aiCourseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }
            courses.forEach(c => { if (c.id) courseNames[c.id] = c.title; });
            const opts = courses.map(c => `<option value="${c.id}">${c.title} (${c.code || 'No code'})</option>`).join('');
            courseSelect.innerHTML = `<option value="" disabled selected>Select a course</option>${opts}`;
            aiCourseSelect.innerHTML = `<option value="" disabled selected>Select a course</option>${opts}`;
        } catch (err) {
            console.error('Error loading courses:', err);
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
            aiCourseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    /* ── Write path: create assignment (unchanged logic) ──────────────── */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('assign-title').value.trim();
        const courseId = courseSelect.value;
        if (!title || !courseId) {
            showToast('Select a course and enter a title.', 'warning');
            return;
        }
        const payload = {
            course_id: courseId,
            title,
            instructions: document.getElementById('assign-instructions').value.trim() || null,
            due_date: document.getElementById('assign-due').value || null,
            week_number: document.getElementById('assign-week').value ? Number(document.getElementById('assign-week').value) : null,
        };
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/assignments/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast('Assignment created.', 'success');
                form.reset();
                invalidateApiCache(`assign:${courseId}`);
                loadAssignments();
                showChoice();
            } else {
                showToast(data.detail || 'Could not create assignment.', 'error');
            }
        } catch (err) {
            showToast('Could not create assignment.', 'error');
        } finally {
            btn.disabled = false;
        }
    });

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

        aiGenerateBtn.disabled = true;
        aiGenSpinner.hidden = false;
        aiGenText.textContent = 'Generating…';

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
            const obj = data.questions?.objective || [];
            const th  = data.questions?.theory || [];
            obj.forEach(q => generatedQuestions.push({ ...q, _type: 'objective' }));
            th.forEach(q  => generatedQuestions.push({ ...q, _type: 'theory' }));

            if (!generatedQuestions.length) {
                showToast('AI returned no questions. Try different settings.', 'warning');
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
            aiGenerateBtn.disabled = false;
            aiGenSpinner.hidden = true;
            aiGenText.textContent = 'Generate questions';
        }
    });

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
                            <span class="q-option-marker">${letters[oi] || oi + 1}</span>
                            <span>${escapeHTML(opt)}</span>
                        </div>`).join('')}
                </div>`;
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
        aiStepConfig.hidden = false;
        aiStepReview.hidden = true;
    });

    /* ── AI path: create assignment with selected questions ────────────── */
    reviewCreateBtn.addEventListener('click', async () => {
        const courseId = aiCourseSelect.value;
        const title = document.getElementById('ai-assign-title').value.trim();
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

        const instructions = document.getElementById('ai-instructions').value.trim()
            || `Answer all questions. Objective questions are scored automatically; theory answers are graded by AI.`;
        const dueDate = document.getElementById('ai-due').value || null;
        const weekNum = document.getElementById('ai-week').value ? Number(document.getElementById('ai-week').value) : null;

        reviewCreateBtn.disabled = true;
        reviewCreateSpinner.hidden = false;
        reviewCreateText.textContent = 'Creating…';

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
                showToast('Assignment created with AI questions.', 'success');
                invalidateApiCache(`assign:${courseId}`);
                loadAssignments();
                // Reset AI flow
                generatedQuestions = [];
                selectedIndices = new Set();
                aiStepConfig.hidden = false;
                aiStepReview.hidden = true;
                document.getElementById('ai-assign-title').value = '';
                document.getElementById('ai-topic').value = '';
                document.getElementById('ai-instructions').value = '';
                document.getElementById('ai-due').value = '';
                document.getElementById('ai-week').value = '';
                showChoice();
            } else {
                showToast(data.detail || 'Could not create assignment.', 'error');
            }
        } catch {
            showToast('Could not create assignment.', 'error');
        } finally {
            reviewCreateBtn.disabled = false;
            reviewCreateSpinner.hidden = true;
            reviewCreateText.textContent = 'Create assignment';
        }
    });

    /* ── View submissions modal (unchanged) ───────────────────────────── */
    async function viewSubmissions(assignmentId, title) {
        document.getElementById('subs-title').textContent = title;
        const body = document.getElementById('subs-body');
        subsModal.hidden = false;
        body.innerHTML = '<div class="loading-wrapper loading-full"><div class="spinner"></div><p>Loading submissions…</p></div>';
        try {
            const data = await swrGet(`subs:${assignmentId}`, `${API_BASE}/api/assignments/${assignmentId}/submissions`);
            const subs = data.submissions || [];
            if (!subs.length) {
                body.innerHTML = '<p class="text-muted">No submissions yet.</p>';
                return;
            }
            const onTimeCount = subs.filter(s => s.on_time).length;
            body.innerHTML = `
                <p class="text-muted" style="margin-bottom: var(--s4)">${subs.length} submission${subs.length === 1 ? '' : 's'} · ${onTimeCount} on time</p>
                ${subs.map(s => `
                    <div class="sub-card">
                        <div class="sub-head">
                            <span class="sub-name">${s.student_name || s.student_id}</span>
                            <div class="sub-head-right">
                                ${s.letter_grade ? `<span class="badge badge--ontime">${s.letter_grade}</span>` : ''}
                                <span class="badge ${s.on_time ? 'badge--ontime' : 'badge--none'}">${s.on_time ? 'On time' : 'Late'}</span>
                            </div>
                        </div>
                        <div class="sub-time">Submitted ${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '–'}</div>
                        ${s.score != null ? `<div class="sub-grade">Score ${s.score}%</div>` : ''}
                        ${s.feedback ? `<div class="sub-feedback">${s.feedback}</div>` : ''}
                        <div class="sub-content">${s.content}</div>
                    </div>
                `).join('')}
            `;
        } catch (err) {
            body.innerHTML = '<p class="text-muted">Unable to load submissions.</p>';
            showToast('Unable to load submissions.', 'error');
        }
    }

    /* ── Load assignments list (unchanged) ────────────────────────────── */
    async function loadAssignments() {
        try {
            const courses = await swrGet('catalog', `${API_BASE}/api/courses/`);
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
