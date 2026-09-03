/* 
   QUIZ MODULE LOGIC
   frontend/quiz/quiz.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    initProfilePopup();

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    const courseSelectorEl = document.getElementById('course-selector');
    const quizAreaEl = document.getElementById('quiz-area');

    let allQuizzes = [];
    let currentQuiz = null;
    let currentQuestionIndex = 0;
    let selectedOption = null;
    let answers = [];

    async function loadCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/students/${user.id}/courses`);
            if (!res.ok) throw new Error('Failed');
            const courses = await res.json();
            const list = document.getElementById('course-list');

            if (!courses.length) {
                list.innerHTML = '<p class="text-muted">No courses enrolled yet. <a href="../courses/courses.html">Browse courses</a></p>';
                return;
            }

            list.innerHTML = courses.map(course => `
                <div class="course-card" data-course-id="${course.id}">
                    <h3>${escapeHTML(course.title)}</h3>
                    <p>${escapeHTML(course.lecturer_name || 'UENR')}</p>
                </div>
            `).join('');

            document.querySelectorAll('.course-card').forEach(card => {
                card.addEventListener('click', () => loadQuizzesForCourse(card.dataset.courseId, card.querySelector('h3').textContent));
            });
        } catch (err) {
            console.error('Error loading courses:', err);
            document.getElementById('course-list').innerHTML = '<p class="text-muted">Unable to load courses.</p>';
        }
    }

    async function loadQuizzesForCourse(courseId, courseTitle) {
        try {
            const res = await authFetch(`${API_BASE}/api/quiz/course/${courseId}`);
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            allQuizzes = (data.quizzes || []).filter(q => q.questions && q.questions.length > 0);

            if (!allQuizzes.length) {
                showToast('No quizzes available for this course yet.', 'warning');
                return;
            }

            currentQuiz = allQuizzes[0];
            currentQuestionIndex = 0;
            answers = new Array(currentQuiz.questions.length).fill(null);

            courseSelectorEl.style.display = 'none';
            quizAreaEl.style.display = 'block';
            document.getElementById('quiz-title').textContent = currentQuiz.title || `Quiz: ${courseTitle}`;

            // Show the start screen — the quiz runs only after the student
            // clicks Start, and it is untimed.
            document.getElementById('intro-count').textContent =
                `${currentQuiz.questions.length} question${currentQuiz.questions.length === 1 ? '' : 's'}`;
            document.getElementById('quiz-intro').style.display = 'block';
        } catch (err) {
            console.error('Error loading quizzes:', err);
            showToast('Unable to load quizzes. Please try again.', 'error');
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
        document.getElementById('quiz-body').style.display = 'block';
        armLeaveGuard();
        loadQuestion();
    }

    function loadQuestion() {
        const q = currentQuiz.questions[currentQuestionIndex];
        selectedOption = answers[currentQuestionIndex];

        document.querySelector('.question-num').textContent = `Question ${currentQuestionIndex + 1} of ${currentQuiz.questions.length}`;
        document.getElementById('question-text').textContent = q.question_text;
        document.getElementById('progress-text').textContent = `${currentQuestionIndex + 1} / ${currentQuiz.questions.length}`;

        document.getElementById('options-grid').innerHTML = q.options.map((opt, i) => `
            <div class="option-card ${selectedOption === i ? 'selected' : ''}" data-index="${i}">${escapeHTML(opt)}</div>
        `).join('');

        document.querySelectorAll('.option-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedOption = parseInt(card.dataset.index);
                answers[currentQuestionIndex] = selectedOption;
            });
        });

        document.getElementById('prev-btn').style.display = currentQuestionIndex > 0 ? 'inline-block' : 'none';
        document.getElementById('next-btn').textContent = currentQuestionIndex === currentQuiz.questions.length - 1 ? 'Submit Quiz' : 'Next';
    }

    document.getElementById('start-quiz-btn').addEventListener('click', startQuiz);
    document.getElementById('prev-btn').addEventListener('click', () => {
        if (currentQuestionIndex > 0) {
            answers[currentQuestionIndex] = selectedOption;
            currentQuestionIndex--;
            loadQuestion();
        }
    });

    document.getElementById('next-btn').addEventListener('click', () => {
        if (selectedOption === null) { showToast('Please select an option.', 'warning'); return; }
        answers[currentQuestionIndex] = selectedOption;
        if (currentQuestionIndex === currentQuiz.questions.length - 1) submitQuiz();
        else { currentQuestionIndex++; loadQuestion(); }
    });

    async function submitQuiz() {
        if (answers.some(a => a === null)) {
            showToast('Please answer every question before submitting.', 'warning');
            return;
        }

        let finalScore = null;
        let correct = 0;
        let total = currentQuiz.questions.length;
        let recRedirect = false;

        try {
            const res = await authFetch(`${API_BASE}/api/quiz/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quiz_id: currentQuiz.id,
                    answers: { manual: answers }
                })
            });
            if (!res.ok) throw new Error('Submission failed');
            const data = await res.json();
            if (data && typeof data.score === 'number') {
                finalScore = Math.round(data.score);
                correct = data.correct ?? 0;
                total = data.total ?? total;
            }
            // If the backend generated recommendations for a low score, show the
            // results first, then automatically move the student to the
            // recommendations page so they can act on them.
            const hasRecs = (data?.recommended_count || 0) > 0;
            if (hasRecs) recRedirect = true;
        } catch (err) {
            console.error('Submission error:', err);
            showToast('Failed to submit quiz. Please try again.', 'error');
            return;
        }

        if (finalScore === null) {
            showToast('Failed to submit quiz. Please try again.', 'error');
            return;
        }

        disarmLeaveGuard();
        const recsParam = recRedirect ? '&redirectRecs=1' : '';
        window.location.href = `../results/results.html?score=${finalScore}&quiz=${encodeURIComponent(currentQuiz.title)}&correct=${correct}&total=${total}${recsParam}`;
    }

    loadCourses();
});
