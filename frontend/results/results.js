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
    }
});
