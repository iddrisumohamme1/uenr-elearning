/* 
   RESULTS MODULE LOGIC
   frontend/results/results.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    initProfilePopup();

    const urlParams = new URLSearchParams(window.location.search);
    const score = parseInt(urlParams.get('score')) || 0;
    const quizTitle = urlParams.get('quiz');
    const correct = urlParams.get('correct');
    const total = urlParams.get('total');
    const theory = urlParams.get('theory');
    const unansweredTheory = parseInt(urlParams.get('unanswered')) || 0;

    const scoreValue = document.getElementById('score-value');
    const scoreLabel = document.getElementById('score-label');

    scoreValue.textContent = `${score}%`;

    if (score >= 80) {
        scoreLabel.textContent = 'Excellent Work!';
        scoreLabel.style.color = 'var(--clr-success)';
        document.querySelector('.score-circle').style.borderColor = 'var(--clr-success)';
    } else if (score >= 50) {
        scoreLabel.textContent = 'Good Job! Keep Improving.';
        scoreLabel.style.color = 'var(--clr-primary)';
    } else {
        scoreLabel.textContent = 'Don\'t Give Up! Try Again.';
        scoreLabel.style.color = 'var(--clr-danger)';
        document.querySelector('.score-circle').style.borderColor = 'var(--clr-danger)';
    }

    const detailsEl = document.getElementById('results-details');
    if (correct && total) {
        detailsEl.style.display = 'block';
        document.getElementById('detail-text').textContent = `You answered ${correct} out of ${total} questions correctly${quizTitle ? ' in "' + quizTitle + '"' : ''}.`;
        if (theory !== null && theory !== undefined && theory !== '') {
            const theoryEl = document.createElement('p');
            theoryEl.className = 'text-muted';
            theoryEl.style.marginTop = '0.5rem';
            if (unansweredTheory > 0) {
                theoryEl.textContent = `You did not answer ${unansweredTheory} theory question${unansweredTheory > 1 ? 's' : ''}. These were scored 0, which reduced your overall mark.`;
                theoryEl.style.color = 'var(--clr-danger)';
            } else {
                theoryEl.textContent = `Theory questions scored ${Math.round(parseFloat(theory))}%.`;
            }
            detailsEl.appendChild(theoryEl);
        }
    }

    // When a low quiz score generated recommendations, show the result briefly
    // (so the student sees their score) and then automatically move them to the
    // recommendations page to act on them.
    if (urlParams.get('redirectRecs') === '1') {
        const note = document.createElement('p');
        note.className = 'text-muted';
        note.style.marginTop = '1rem';
        note.textContent = 'Taking you to your recommendations...';
        document.querySelector('.results-card')?.appendChild(note);
        setTimeout(() => {
            window.location.href = '../recommendations/recommendations.html';
        }, 2500);
    }
});
