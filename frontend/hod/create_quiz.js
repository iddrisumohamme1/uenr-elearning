/*
   HOD QUIZ CREATION LOGIC
   frontend/hod/create_quiz.js
   Dynamic quiz builder with multiple questions, options, and correct answer selection.
   HODs who teach can publish quizzes for their own courses.
   Saves quizzes and questions to Supabase via FastAPI backend.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;
    const token = getToken();

    document.getElementById('dept-name').textContent = user.department || 'Department';
    document.getElementById('user-avatar').textContent = (user.full_name || 'H').charAt(0).toUpperCase();

    const form = document.getElementById('quiz-form');
    const courseSelect = document.getElementById('course-select');
    const questionsContainer = document.getElementById('questions-container');
    const addQuestionBtn = document.getElementById('add-question-btn');
    let questionCount = 0;

    attachLogout('logout-btn');
    initProfilePopup();

    async function loadCourses() {
        try {
            const response = await authFetch(`${API_BASE}/api/courses/`);
            const courses = await response.json();
            if (!Array.isArray(courses) || courses.length === 0) {
                courseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }
            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${courses.map(c => `
                    <option value="${c.id}">${c.title} (${c.code || 'No code'})</option>
                `).join('')}
            `;
        } catch (err) {
            console.error('Error loading courses:', err);
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    function addQuestion() {
        questionCount++;
        const qNum = questionCount;
        const div = document.createElement('div');
        div.className = 'question-builder';
        div.dataset.questionNum = qNum;
        div.innerHTML = `
            <button type="button" class="btn-remove-question" onclick="this.parentElement.remove()"> <i class="bi bi-x-lg"></i> Remove</button>
            <h3>Question ${qNum}</h3>
            <div class="form-group">
                <textarea class="form-input question-text" rows="3" placeholder="Enter your question here..." required></textarea>
            </div>
            <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">Select the correct answer:</p>
            <div class="options-grid">
                <div class="option-row">
                    <input type="radio" name="correct_${qNum}" value="0" id="opt_${qNum}_0" required>
                    <label for="opt_${qNum}_0">A</label>
                    <input type="text" class="form-input option-text" placeholder="Option A" required>
                </div>
                <div class="option-row">
                    <input type="radio" name="correct_${qNum}" value="1" id="opt_${qNum}_1">
                    <label for="opt_${qNum}_1">B</label>
                    <input type="text" class="form-input option-text" placeholder="Option B" required>
                </div>
                <div class="option-row">
                    <input type="radio" name="correct_${qNum}" value="2" id="opt_${qNum}_2">
                    <label for="opt_${qNum}_2">C</label>
                    <input type="text" class="form-input option-text" placeholder="Option C" required>
                </div>
                <div class="option-row">
                    <input type="radio" name="correct_${qNum}" value="3" id="opt_${qNum}_3">
                    <label for="opt_${qNum}_3">D</label>
                    <input type="text" class="form-input option-text" placeholder="Option D" required>
                </div>
            </div>
        `;
        questionsContainer.appendChild(div);
    }

    addQuestionBtn.addEventListener('click', addQuestion);
    addQuestion();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const courseId = courseSelect.value;
        const title = document.getElementById('quiz-title').value.trim();
        const timeLimit = document.getElementById('time-limit').value;

        if (!courseId || !title) {
            showToast('Please select a course and enter a quiz title.', 'warning');
            return;
        }

        const questionBuilders = questionsContainer.querySelectorAll('.question-builder');
        if (questionBuilders.length === 0) {
            showToast('Please add at least one question.', 'warning');
            return;
        }

        const questions = [];
        for (let i = 0; i < questionBuilders.length; i++) {
            const builder = questionBuilders[i];
            const qNum = builder.dataset.questionNum;
            const questionText = builder.querySelector('.question-text').value.trim();
            const optionInputs = builder.querySelectorAll('.option-text');
            const correctRadio = builder.querySelector(`input[name="correct_${qNum}"]:checked`);

            if (!questionText) {
                showToast('Question ' + (i + 1) + ': Please enter the question text.', 'warning');
                return;
            }
            if (!correctRadio) {
                showToast('Question ' + (i + 1) + ': Please select the correct answer.', 'warning');
                return;
            }

            const options = [];
            let allFilled = true;
            optionInputs.forEach(input => {
                const val = input.value.trim();
                if (!val) allFilled = false;
                options.push(val);
            });

            if (!allFilled) {
                showToast('Question ' + (i + 1) + ': Please fill in all four options.', 'warning');
                return;
            }

            questions.push({
                question_text: questionText,
                options: options,
                correct_option: parseInt(correctRadio.value)
            });
        }

        try {
            const response = await authFetch(`${API_BASE}/api/quiz/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    course_id: courseId,
                    title: title,
                    time_limit: timeLimit ? parseInt(timeLimit) : null,
                    questions: questions
                })
            });

            const data = await response.json();
            if (response.ok) {
                showToast('Quiz created successfully with ' + questions.length + ' question(s).', 'success');
                window.location.href = 'dashboard.html';
            } else {
                showToast('Failed to create quiz: ' + (data.detail || data.message || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Create quiz error:', err);
            showToast('Server connection failed.', 'error');
        }
    });

    await loadCourses();
});
