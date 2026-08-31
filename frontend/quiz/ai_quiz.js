/* 
   AI COMPREHENSION QUIZ MODULE LOGIC
   frontend/quiz/ai_quiz.js
   Loads an AI-generated quiz for a material the student just finished reading.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    initProfilePopup();

    const urlParams = new URLSearchParams(window.location.search);
    const courseId = urlParams.get('course_id');
    const materialId = urlParams.get('material_id');
    const titleParam = urlParams.get('title');

    const loadingEl = document.getElementById('loading-area');
    const errorEl = document.getElementById('load-error');
    const quizAreaEl = document.getElementById('ai-quiz-area');
    const questionNumEl = document.getElementById('question-num');
    const questionTextEl = document.getElementById('question-text');
    const optionsGridEl = document.getElementById('options-grid');
    const theorySectionEl = document.getElementById('theory-section');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const submitBtn = document.getElementById('submit-btn');

    let quizId = null;
    let objective = [];
    let theory = [];
    let currentQ = 0;
    let selectedOption = null;
    let answers = [];
    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

    function buildQuestionMap() {
        const mapEl = document.getElementById('question-map');
        if (!mapEl) return;
        mapEl.innerHTML = objective.map((_, i) => `<span class="qmap-dot" data-idx="${i}"></span>`).join('');
    }

    function updateQuestionMap() {
        const dots = document.querySelectorAll('#question-map .qmap-dot');
        if (!dots.length) return;
        dots.forEach((dot, i) => {
            dot.classList.toggle('answered', answers[i] !== null);
            dot.classList.toggle('current', i === currentQ);
        });
    }

    async function loadQuiz() {
        try {
            const res = await authFetch(
                `${API_BASE}/api/quiz/generate?course_id=${encodeURIComponent(courseId)}&material_id=${encodeURIComponent(materialId)}`
            );
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to generate the quiz.');
            }
            const data = await res.json();
            quizId = data.quiz_id;
            objective = data.quiz.objective || [];
            theory = data.quiz.theory || [];
            answers = new Array(objective.length).fill(null);

            document.getElementById('quiz-title').textContent = titleParam ? titleParam : 'AI Comprehension Quiz';
            loadingEl.style.display = 'none';
            quizAreaEl.style.display = 'block';

            buildQuestionMap();

            // Show the start screen — questions appear only after the student
            // clicks Start, and the check is untimed.
            const parts = [`${objective.length} objective question${objective.length === 1 ? '' : 's'}`];
            if (theory.length) parts.push(`${theory.length} theory question${theory.length === 1 ? '' : 's'}`);
            document.getElementById('intro-count').textContent = parts.join(' · ');
            document.getElementById('quiz-intro').style.display = 'block';
            loadHighlightReview();
        } catch (err) {
            console.error('AI quiz load error:', err);
            loadingEl.style.display = 'none';
            errorEl.style.display = 'block';
            document.getElementById('error-text').textContent = err.message;
            const backLink = document.querySelector('#load-error a.btn-primary');
            if (backLink && courseId) backLink.href = `../materials/materials.html?id=${encodeURIComponent(courseId)}`;
        }
    }

    // Warn before leaving with an attempt in progress.
    function warnOnLeave(e) {
        e.preventDefault();
        e.returnValue = '';
    }
    function armLeaveGuard() { window.addEventListener('beforeunload', warnOnLeave); }
    function disarmLeaveGuard() { window.removeEventListener('beforeunload', warnOnLeave); }

    function startQuiz() {
        document.getElementById('quiz-intro').style.display = 'none';
        document.getElementById('question-map').style.display = 'flex';
        document.getElementById('quiz-body').style.display = 'block';
        armLeaveGuard();
        if (objective.length) {
            loadQuestion();
        } else {
            showTheory();
        }
    }

    function loadQuestion() {
        const q = objective[currentQ];
        selectedOption = answers[currentQ];

        questionNumEl.textContent = `Question ${currentQ + 1} of ${objective.length}`;
        questionTextEl.textContent = q.question;
        document.getElementById('progress-text').textContent = `${currentQ + 1} / ${objective.length}`;
        updateQuestionMap();

        optionsGridEl.style.display = 'flex';
        theorySectionEl.style.display = 'none';

        optionsGridEl.innerHTML = q.options.map((opt, i) => `
            <button type="button" class="option-card ${selectedOption === i ? 'selected' : ''}" data-index="${i}">
                <span class="opt-letter">${LETTERS[i] || i + 1}</span>
                <span>${escapeHTML(opt)}</span>
            </button>
        `).join('');

        optionsGridEl.querySelectorAll('.option-card').forEach(card => {
            card.addEventListener('click', () => {
                optionsGridEl.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedOption = parseInt(card.dataset.index);
                answers[currentQ] = selectedOption;
                updateQuestionMap();
            });
        });

        prevBtn.style.display = currentQ > 0 ? 'inline-block' : 'none';
        nextBtn.textContent = currentQ === objective.length - 1 ? 'Theory Questions' : 'Next';
        submitBtn.style.display = 'none';
    }

    function showTheory() {
        currentQ = -1;
        optionsGridEl.style.display = 'none';
        theorySectionEl.style.display = 'block';
        questionNumEl.textContent = `Theory Questions (${theory.length})`;
        questionTextEl.textContent = 'Answer the following short questions to complete the quiz.';
        document.getElementById('progress-text').textContent = `${objective.length} MCQ + ${theory.length} theory`;
        updateQuestionMap();

        document.getElementById('theory-questions').innerHTML = theory.map((t, i) => `
            <div class="theory-card">
                <p class="question-num">Theory ${i + 1} of ${theory.length}</p>
                <h3>${escapeHTML(t.question)}</h3>
                <textarea class="theory-input" data-idx="${i}" rows="3" placeholder="Type your answer..."></textarea>
            </div>
        `).join('');

        prevBtn.style.display = 'none';
        nextBtn.style.display = 'none';
        submitBtn.style.display = 'inline-block';
    }

    prevBtn.addEventListener('click', () => {
        if (currentQ > 0) {
            answers[currentQ] = selectedOption;
            currentQ--;
            loadQuestion();
        }
    });

    nextBtn.addEventListener('click', () => {
        if (selectedOption === null) { showToast('Please select an option.', 'warning'); return; }
        answers[currentQ] = selectedOption;
        if (currentQ === objective.length - 1) {
            showTheory();
        } else {
            currentQ++;
            loadQuestion();
        }
    });

    async function submitQuiz() {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';

        const theoryInputs = document.querySelectorAll('.theory-input');
        const theoryAnswers = Array.from(theoryInputs).map(t => t.value.trim());

        try {
            const res = await authFetch(`${API_BASE}/api/quiz/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quiz_id: quizId,
                    answers: { objective: answers, theory: theoryAnswers },
                })
            });
            if (!res.ok) throw new Error('Submission failed');
            const result = await res.json();
            const title = titleParam || 'AI Comprehension Quiz';
            const unanswered = result.unanswered_theory ?? 0;
            disarmLeaveGuard();
            window.location.href = `../results/results.html?score=${Math.round(result.score)}&quiz=${encodeURIComponent(title)}&correct=${result.correct}&total=${result.total}&theory=${result.theory_avg ?? ''}&unanswered=${unanswered}`;
        } catch (err) {
            console.error('Submit error:', err);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Retry';
            document.getElementById('progress-text').textContent = 'Submission failed. Please try again.';
        }
    }

    // Show the student's saved highlights from this material as a pre-quiz
    // refresher. Fails silently — the review is a bonus, never a blocker.
    async function loadHighlightReview() {
        if (!materialId) return;
        const wrap = document.getElementById('intro-highlights');
        const list = document.getElementById('intro-highlights-list');
        if (!wrap || !list) return;
        try {
            const res = await authFetch(`${API_BASE}/api/highlights/material/${encodeURIComponent(materialId)}`);
            if (!res.ok) return;
            const data = await res.json();
            const highlights = (data.highlights || []).filter(h => (h.text || '').trim());
            if (!highlights.length) return;

            list.innerHTML = highlights.map(h => `
                <li class="hl-review-item">
                    <span class="hl-review-page">p.${h.page_number}</span>
                    <span class="hl-review-text">${(h.text || '').replace(/</g, '&lt;')}</span>
                </li>
            `).join('');
            wrap.style.display = 'block';
        } catch (err) {
            console.error('Highlight review load failed:', err);
        }
    }

    submitBtn.addEventListener('click', submitQuiz);
    document.getElementById('start-quiz-btn').addEventListener('click', startQuiz);

    loadQuiz();
});
